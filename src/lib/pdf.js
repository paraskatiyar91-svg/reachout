'use strict';
// Minimal PDF writer for clean, ATS-friendly, single-column resumes.
// Uses the built-in Helvetica fonts (WinAnsi), so no font files are needed.
const zlib = require('zlib');

const W = 595.28;
const H = 841.89;
const M = 48;

// Helvetica glyph widths (1/1000 em) for ASCII 32..126.
const HV = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];

const WIN = { '–': 0x96, '—': 0x97, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '…': 0x85, '€': 0x80, '™': 0x99 };
const ASCII_FALLBACK = { '‐': '-', '‑': '-', '−': '-', ' ': ' ', '→': '->', '≈': '~', '₹': 'Rs.' };

function toWinAnsi(s) {
  let out = '';
  for (const ch of String(s)) {
    if (ASCII_FALLBACK[ch]) out += ASCII_FALLBACK[ch];
    else if (WIN[ch]) out += String.fromCharCode(WIN[ch]);
    else {
      const c = ch.codePointAt(0);
      if (c === 9) out += ' ';
      else if (c >= 32 && c <= 126) out += ch;
      else if (c >= 0xa0 && c <= 0xff) out += ch;
      else out += '?';
    }
  }
  return out;
}

function width(str, size, bold) {
  let w = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    w += c >= 32 && c <= 126 ? HV[c - 32] : 556;
  }
  return (w * size * (bold ? 1.07 : 1)) / 1000;
}

function wrap(text, size, bold, maxW) {
  const lines = [];
  for (const para of toWinAnsi(text).split('\n')) {
    let line = '';
    for (const word of para.split(/ +/)) {
      const tryLine = line ? `${line} ${word}` : word;
      if (width(tryLine, size, bold) <= maxW || !line) line = tryLine;
      else {
        lines.push(line);
        line = word;
      }
      // hard-break absurdly long tokens (URLs)
      while (width(line, size, bold) > maxW && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && width(line.slice(0, cut), size, bold) > maxW) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    lines.push(line);
  }
  return lines;
}

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

class Doc {
  constructor() {
    this.pages = [];
    this.newPage();
  }
  newPage() {
    this.ops = [];
    this.pages.push(this.ops);
    this.y = H - M;
  }
  space(h) {
    if (this.y - h < M) this.newPage();
  }
  gap(h) {
    this.y -= h;
  }
  textAt(str, x, size, bold, color) {
    if (color) this.ops.push(`${color} rg`);
    this.ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${x.toFixed(2)} ${this.y.toFixed(2)} Td (${esc(str)}) Tj ET`);
    if (color) this.ops.push('0 0 0 rg');
  }
  para(text, { size = 10, bold = false, indent = 0, bullet = false, lead = 1.32, color, right } = {}) {
    if (!text) return;
    const bw = bullet ? 11 : 0;
    const maxW = W - 2 * M - indent - bw - (right ? width(toWinAnsi(right), size, false) + 12 : 0);
    const lines = wrap(text, size, bold, maxW);
    lines.forEach((ln, i) => {
      this.space(size * lead);
      this.y -= size * lead;
      if (bullet && i === 0) this.textAt('\x95', M + indent + 1, size, false);
      this.textAt(ln, M + indent + bw, size, bold, color);
      if (right && i === 0) {
        const r = toWinAnsi(right);
        this.textAt(r, W - M - width(r, size, false), size, false, '0.35 0.35 0.35');
      }
    });
  }
  rule() {
    this.y -= 3;
    this.ops.push(`0.6 0.6 0.6 RG 0.6 w ${M} ${this.y.toFixed(2)} m ${(W - M).toFixed(2)} ${this.y.toFixed(2)} l S`);
  }
  section(title) {
    this.space(40);
    this.gap(10);
    this.para(title.toUpperCase(), { size: 10.5, bold: true, color: '0.12 0.23 0.45' });
    this.rule();
    this.gap(2);
  }

  toBuffer(title) {
    const objs = [];
    const add = (o) => objs.push(o) && objs.length;
    add('<< /Type /Catalog /Pages 2 0 R >>');
    add('PAGES');
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const info = add(`<< /Title (${esc(toWinAnsi(title || 'Resume'))}) /Producer (ReachOut) >>`);
    const kids = [];
    for (const ops of this.pages) {
      const stream = zlib.deflateSync(Buffer.from(ops.join('\n'), 'latin1'));
      const contentId = add({ dict: `<< /Length ${stream.length} /Filter /FlateDecode >>`, stream });
      kids.push(
        add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`),
      );
    }
    objs[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;

    const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
    let offset = chunks[0].length;
    const offsets = [];
    objs.forEach((o, i) => {
      offsets.push(offset);
      const parts =
        typeof o === 'string'
          ? [Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1')]
          : [Buffer.from(`${i + 1} 0 obj\n${o.dict}\nstream\n`, 'latin1'), o.stream, Buffer.from('\nendstream\nendobj\n', 'latin1')];
      for (const p of parts) {
        chunks.push(p);
        offset += p.length;
      }
    });
    const xref = [`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
    chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info ${info} 0 R >>\nstartxref\n${offset}\n%%EOF\n`, 'latin1'));
    return Buffer.concat(chunks);
  }
}

const s = (v) => (v == null ? '' : String(v).trim());
const arr = (v) => (Array.isArray(v) ? v : []);

// resume: structured object from AI, or { raw: "plain text" } fallback.
function renderResume(profile, resume) {
  const d = new Doc();
  d.para(s(profile.fullName) || 'Your Name', { size: 20, bold: true, lead: 1.1 });
  const contact = [profile.contactEmail, profile.phone, profile.location].map(s).filter(Boolean).join('  |  ');
  const links = [profile.linkedin, profile.github, profile.portfolio].map(s).filter(Boolean).join('  |  ');
  d.gap(2);
  if (contact) d.para(contact, { size: 9.5, color: '0.3 0.3 0.3' });
  if (links) d.para(links, { size: 9.5, color: '0.3 0.3 0.3' });
  if (s(resume.headline)) {
    d.gap(3);
    d.para(resume.headline, { size: 11, bold: true, color: '0.12 0.23 0.45' });
  }

  if (resume.raw) {
    renderRaw(d, resume.raw);
    return d.toBuffer(`${s(profile.fullName)} Resume`);
  }

  if (s(resume.summary)) {
    d.section('Summary');
    d.para(resume.summary);
  }
  if (arr(resume.skills).length) {
    d.section('Skills');
    for (const g of arr(resume.skills)) {
      const items = arr(g.items).map(s).filter(Boolean).join(', ');
      if (items) d.para(s(g.group) ? `${s(g.group)}: ${items}` : items);
    }
  }
  if (arr(resume.experience).length) {
    d.section('Experience');
    for (const e of arr(resume.experience)) {
      d.gap(3);
      d.para([s(e.title), s(e.organization)].filter(Boolean).join(' - '), { bold: true, right: s(e.dates) });
      for (const b of arr(e.bullets)) d.para(s(b), { bullet: true, indent: 4 });
    }
  }
  if (arr(resume.projects).length) {
    d.section('Projects');
    for (const p of arr(resume.projects)) {
      d.gap(3);
      d.para(s(p.name), { bold: true });
      if (s(p.tech)) d.para(s(p.tech), { size: 9, color: '0.35 0.35 0.35' });
      for (const b of arr(p.bullets)) d.para(s(b), { bullet: true, indent: 4 });
    }
  }
  if (arr(resume.education).length) {
    d.section('Education');
    for (const e of arr(resume.education)) {
      d.gap(2);
      d.para([s(e.degree), s(e.institution)].filter(Boolean).join(' - '), { bold: true, right: s(e.dates) });
      if (s(e.details)) d.para(s(e.details));
    }
  }
  if (arr(resume.achievements).length) {
    d.section('Achievements & Certifications');
    for (const a of arr(resume.achievements)) d.para(s(a), { bullet: true, indent: 4 });
  }
  return d.toBuffer(`${s(profile.fullName)} Resume`);
}

const HEADER_RE = /^(summary|profile|objective|skills|technical skills|experience|work experience|internships?|projects|education|achievements|certifications?|awards|publications|activities|extracurriculars?|positions of responsibility|languages|interests|coursework)\s*:?$/i;

function renderRaw(d, text) {
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t) {
      d.gap(4);
      continue;
    }
    if (HEADER_RE.test(t) || (t.length < 40 && /^[A-Z][A-Z &/]+:?$/.test(t))) d.section(t.replace(/:$/, ''));
    else if (/^[•\-*▪●◦]\s*/.test(t)) d.para(t.replace(/^[•\-*▪●◦]\s*/, ''), { bullet: true, indent: 4 });
    else d.para(t);
  }
}

module.exports = { renderResume, toWinAnsi };
