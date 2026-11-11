'use strict';
// Dependency-free parsers: ZIP (for .xlsx/.docx), XLSX, CSV, DOCX text.
const zlib = require('zlib');

const MAX_UNZIPPED = 30 * 1024 * 1024; // zip-bomb guard

function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('File is not a valid .xlsx/.docx (zip) file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt zip directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    entries.set(buf.subarray(p + 46, p + 46 + nlen).toString('utf8'), { method, csize, usize, lho });
    p += 46 + nlen + elen + clen;
  }
  return {
    has: (n) => entries.has(n),
    read(name) {
      const e = entries.get(name);
      if (!e) return null;
      if (e.usize > MAX_UNZIPPED) throw new Error('File too large after decompression');
      if (buf.readUInt32LE(e.lho) !== 0x04034b50) throw new Error('Corrupt zip entry');
      const start = e.lho + 30 + buf.readUInt16LE(e.lho + 26) + buf.readUInt16LE(e.lho + 28);
      const raw = buf.subarray(start, start + e.csize);
      if (e.method === 0) return raw;
      if (e.method === 8) return zlib.inflateRawSync(raw, { maxOutputLength: MAX_UNZIPPED });
      throw new Error('Unsupported zip compression');
    },
  };
}

function xmlDecode(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}
const textOfRuns = (xml) => [...xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => xmlDecode(m[1])).join('');

function colIndex(ref) {
  const letters = /^[A-Z]+/.exec(ref)?.[0] || 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseXlsx(buf) {
  const z = unzip(buf);
  const shared = [];
  const ss = z.read('xl/sharedStrings.xml');
  if (ss) for (const m of ss.toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(textOfRuns(m[1]));

  // Resolve the first sheet in the workbook.
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const wb = z.read('xl/workbook.xml')?.toString('utf8');
  const rels = z.read('xl/_rels/workbook.xml.rels')?.toString('utf8');
  const rid = wb && /<sheet\b[^>]*\br:id="([^"]+)"/.exec(wb)?.[1];
  if (rid && rels) {
    const rel = [...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0]).find((r) => r.includes(`Id="${rid}"`));
    const target = rel && /Target="([^"]+)"/.exec(rel)?.[1];
    if (target) sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
  }
  const sheet = z.read(sheetPath);
  if (!sheet) throw new Error('Could not find a worksheet in the file');

  const rows = [];
  for (const rm of sheet.toString('utf8').matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const row = [];
    for (const cm of (rm[1] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1];
      const inner = cm[2] || '';
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const t = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let val = '';
      if (t === 's') val = shared[parseInt(v, 10)] ?? '';
      else if (t === 'inlineStr') val = textOfRuns(inner);
      else if (t === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
      else if (v !== undefined) val = xmlDecode(v);
      row[ref ? colIndex(ref) : row.length] = val;
    }
    rows.push(Array.from(row, (c) => (c === undefined ? '' : String(c))));
  }
  return rows;
}

function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const delim = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function docxText(buf) {
  const xml = unzip(buf).read('word/document.xml');
  if (!xml) throw new Error('Not a Word document');
  return xmlDecode(
    xml
      .toString('utf8')
      .replace(/<w:tab\/>/g, '\t')
      .replace(/<w:br\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---- Contacts from rows ----
const HEADER_MAP = {
  name: ['name', 'fullname', 'contactname', 'professorname', 'hrname', 'person'],
  email: ['email', 'emailaddress', 'mail', 'emailid', 'mailid'],
  type: ['type', 'category', 'contacttype', 'professororhr'],
  organization: ['organization', 'organisation', 'org', 'company', 'university', 'institute', 'institution', 'college'],
  domain: ['domain', 'field', 'targetdomain', 'area'],
  description: ['description', 'notes', 'note', 'about', 'research', 'researchinterest', 'researchinterests', 'details'],
  role: ['role', 'position', 'opening', 'jobtitle', 'roleappliedfor'],
};
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[a-z]{2,}$/i;

function rowsToContacts(rows) {
  const nonEmpty = rows.filter((r) => r.some((c) => String(c).trim()));
  if (nonEmpty.length < 2) throw new Error('The sheet needs a header row and at least one contact');
  const header = nonEmpty[0].map(norm);
  const idx = {};
  for (const [field, names] of Object.entries(HEADER_MAP)) {
    const i = header.findIndex((h) => names.includes(h));
    if (i >= 0) idx[field] = i;
  }
  if (idx.email === undefined) throw new Error('Could not find an "Email" column in the header row');
  const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const contacts = [];
  const errors = [];
  nonEmpty.slice(1).forEach((r, k) => {
    const get = (f, n) => (idx[f] === undefined ? '' : clip(r[idx[f]], n));
    const email = get('email', 254).toLowerCase();
    if (!EMAIL_RE.test(email)) {
      errors.push(`Row ${k + 2}: invalid email "${clip(r[idx.email], 60)}"`);
      return;
    }
    let type = get('type', 40);
    const t = type.toLowerCase();
    type = /prof|faculty|research|dr\b/.test(t) ? 'Professor' : /hr|recruit|talent|hiring/.test(t) ? 'HR' : type || 'Other';
    contacts.push({
      name: get('name', 120),
      email,
      type,
      organization: get('organization', 160),
      domain: get('domain', 80),
      description: get('description', 1500),
      role: get('role', 120),
    });
  });
  return { contacts, errors };
}

// Pull phone / LinkedIn / GitHub from resume text to pre-fill the profile.
function profileHints(text) {
  const t = String(text || '');
  const out = {};
  const li = /(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/in\/([A-Za-z0-9_%-]{3,100})/i.exec(t);
  if (li) out.linkedin = `https://www.linkedin.com/in/${li[1]}`;
  const gh = /(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))(?![A-Za-z0-9-])/i.exec(t);
  if (gh && !/^(orgs|topics|features|about)$/i.test(gh[1])) out.github = `https://github.com/${gh[1]}`;
  for (const m of t.matchAll(/(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,5}\)?[\s.-]?)?\d{3,5}[\s.-]?\d{4,5}/g)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 10 && digits.length <= 13 && !/^(19|20)\d{2}(19|20)\d{2}/.test(digits)) {
      out.phone = m[0].trim();
      break;
    }
  }
  return out;
}

module.exports = { unzip, parseXlsx, parseCsv, docxText, rowsToContacts, profileHints, EMAIL_RE };
