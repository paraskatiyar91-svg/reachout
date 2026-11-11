'use strict';
// Extracts text from PDF resumes using Mozilla pdf.js (vendored, Apache-2.0).
// Rebuilds lines from text positions so sections, bullets and dates stay readable.
const path = require('path');
const { pathToFileURL } = require('url');

const VENDOR = path.join(__dirname, '..', '..', 'vendor', 'pdfjs');
let libPromise = null;

function installStubs() {
  // pdf.js references these browser classes at load time; text extraction never renders,
  // so minimal stand-ins are enough (no native canvas dependency needed).
  if (typeof globalThis.DOMMatrix === 'undefined') {
    globalThis.DOMMatrix = class DOMMatrix {
      constructor(init) {
        const m = Array.isArray(init) && init.length === 6 ? init : [1, 0, 0, 1, 0, 0];
        [this.a, this.b, this.c, this.d, this.e, this.f] = m;
      }
      multiplySelf() { return this; }
      preMultiplySelf() { return this; }
      translateSelf() { return this; }
      scaleSelf() { return this; }
      invertSelf() { return this; }
      translate() { return new DOMMatrix([this.a, this.b, this.c, this.d, this.e, this.f]); }
      scale() { return new DOMMatrix([this.a, this.b, this.c, this.d, this.e, this.f]); }
    };
  }
  if (typeof globalThis.Path2D === 'undefined') globalThis.Path2D = class Path2D {};
  if (typeof globalThis.ImageData === 'undefined') globalThis.ImageData = class ImageData {};
}

async function loadLib() {
  if (!libPromise) {
    libPromise = (async () => {
      installStubs();
      // pdf.js prints harmless "cannot polyfill canvas" warnings on load; silence them.
      const warn = console.warn;
      const log = console.log;
      console.warn = () => {};
      console.log = () => {};
      try {
        const lib = await import(pathToFileURL(path.join(VENDOR, 'pdf.min.mjs')).href);
        lib.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(VENDOR, 'pdf.worker.min.mjs')).href;
        return lib;
      } finally {
        console.warn = warn;
        console.log = log;
      }
    })();
  }
  return libPromise;
}

const MAX_PAGES = 6;

async function pdfText(buffer) {
  const lib = await loadLib();
  const task = lib.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false, // never eval code from an uploaded file
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    verbosity: 0,
  });
  let doc;
  try {
    doc = await Promise.race([
      task.promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error('PDF took too long to open')), 20_000)),
    ]);
  } catch (e) {
    task.destroy();
    if (e && e.name === 'PasswordException') throw new Error('This PDF is password-protected. Remove the password and upload again.');
    throw new Error('Could not read this PDF');
  }
  try {
    const out = [];
    const deadline = Date.now() + 20_000;
    for (let n = 1; n <= Math.min(doc.numPages, MAX_PAGES); n++) {
      if (Date.now() > deadline) throw new Error('PDF took too long to read. Try a .docx or paste the text.');
      const page = await doc.getPage(n);
      const { items } = await page.getTextContent();
      out.push(linesFromItems(items));
      page.cleanup();
    }
    return out.join('\n\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  } finally {
    await task.destroy();
  }
}

// Group text runs into lines by baseline (y), order by x, insert spaces/tabs by gaps.
function linesFromItems(items) {
  const runs = items
    .filter((i) => typeof i.str === 'string' && i.str.length)
    .map((i) => ({ s: i.str, x: i.transform[4], y: i.transform[5], w: i.width || 0, h: Math.abs(i.transform[3]) || Math.abs(i.height) || 10 }));
  runs.sort((a, b) => b.y - a.y || a.x - b.x);

  const lines = [];
  for (const r of runs) {
    const line = lines.find((l) => Math.abs(l.y - r.y) <= Math.max(2, r.h * 0.35));
    if (line) line.runs.push(r);
    else lines.push({ y: r.y, h: r.h, runs: [r] });
  }
  lines.sort((a, b) => b.y - a.y);

  const text = [];
  let prevY = null;
  let prevH = 10;
  for (const l of lines) {
    l.runs.sort((a, b) => a.x - b.x);
    let s = '';
    let end = null;
    for (const r of l.runs) {
      if (end !== null) {
        const gap = r.x - end;
        if (gap > r.h * 2.5) s += '   ';
        else if (gap > r.h * 0.15 && !s.endsWith(' ') && !r.s.startsWith(' ')) s += ' ';
      }
      s += r.s;
      end = r.x + r.w;
    }
    // blank line when the vertical gap is large (new section / paragraph)
    if (prevY !== null && prevY - l.y > Math.max(prevH, l.h) * 1.9) text.push('');
    text.push(s.replace(/\s+$/, ''));
    prevY = l.y;
    prevH = l.h;
  }
  return text.join('\n');
}

module.exports = { pdfText };
