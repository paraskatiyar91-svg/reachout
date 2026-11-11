'use strict';
// Storage: an in-memory JSON store, saved to a local file AND (when configured) to
// Upstash Redis over its REST API, so data survives restarts on free hosting.
//
// - Each record is its own Redis key (ro:v1:<collection>:<id>), so a save only sends what changed.
// - Every value is AES-256-GCM encrypted before it leaves the server: Upstash only sees ciphertext.
// - Uploaded resume files (already AES-256-GCM encrypted) are stored as ro:v1:file:<name>.
// - If Upstash is configured but unreachable at startup, the app refuses to start rather than
//   risk overwriting real data with an empty store.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const { encrypt, decrypt } = require('./crypto');

const file = path.join(config.dataDir, 'db.json');
const uploadsDir = path.join(config.dataDir, 'uploads');
const PREFIX = 'ro:v1:';
let data = null;
let timer = null;

const COLLECTIONS = {
  users: {}, // id -> user
  sessions: {}, // sha256(token) -> session
  oauthStates: {}, // state -> { purpose, verifier, userId, expiresAt }
  contacts: {}, // userId -> [contact]
  drafts: {}, // userId -> { contactId: draft }
  tailored: {}, // userId -> { domainKey: { domain, resume, sourceHash, generatedAt } }
  queue: [], // [job]
  sendLog: {}, // userId -> [entry]
};

// ---------------------------------------------------------------- Upstash REST client
const remote = config.upstash.url && config.upstash.token ? config.upstash : null;

async function redis(body, pathSuffix = '') {
  const r = await fetch(remote.url + pathSuffix, {
    method: 'POST',
    headers: { Authorization: `Bearer ${remote.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j) throw new Error(`Upstash error ${r.status}: ${j?.error || 'bad response'}`);
  return j;
}
async function cmd(...args) {
  const j = await redis(args);
  if (j.error) throw new Error(`Upstash: ${j.error}`);
  return j.result;
}
async function pipeline(cmds) {
  if (!cmds.length) return [];
  const j = await redis(cmds, '/pipeline');
  const bad = Array.isArray(j) && j.find((x) => x.error);
  if (!Array.isArray(j) || bad) throw new Error(`Upstash pipeline: ${bad?.error || 'bad response'}`);
  return j.map((x) => x.result);
}

// Flatten the store into Redis keys -> JSON strings.
function toEntries(d) {
  const out = new Map();
  for (const col of Object.keys(COLLECTIONS)) {
    if (Array.isArray(COLLECTIONS[col])) out.set(PREFIX + col, JSON.stringify(d[col]));
    else for (const [id, v] of Object.entries(d[col])) out.set(`${PREFIX}${col}:${id}`, JSON.stringify(v));
  }
  return out;
}
const hash = (s) => crypto.createHash('sha1').update(s).digest('base64');
let synced = new Map(); // key -> hash of what Upstash holds

async function loadRemote() {
  const keys = [];
  let cursor = '0';
  do {
    const [next, batch] = await cmd('SCAN', cursor, 'MATCH', `${PREFIX}*`, 'COUNT', '1000');
    cursor = String(next);
    for (const k of batch) if (!k.startsWith(`${PREFIX}file:`)) keys.push(k);
  } while (cursor !== '0');

  const d = JSON.parse(JSON.stringify(COLLECTIONS));
  synced = new Map();
  for (let i = 0; i < keys.length; i += 200) {
    const chunk = keys.slice(i, i + 200);
    const values = await cmd('MGET', ...chunk);
    chunk.forEach((k, j) => {
      let v = values[j];
      if (v == null) return;
      v = decrypt(v);
      const rest = k.slice(PREFIX.length);
      const sep = rest.indexOf(':');
      const col = sep < 0 ? rest : rest.slice(0, sep);
      if (!(col in COLLECTIONS)) return;
      if (sep < 0) d[col] = JSON.parse(v);
      else d[col][rest.slice(sep + 1)] = JSON.parse(v);
      synced.set(k, hash(v));
    });
  }
  return d;
}

let syncChain = Promise.resolve();
let retryTimer = null;
function syncRemote() {
  syncChain = syncChain.then(async () => {
    const entries = toEntries(data);
    const cmds = [];
    const pending = [];
    for (const [k, v] of entries) {
      const h = hash(v);
      if (synced.get(k) !== h) {
        cmds.push(['SET', k, encrypt(v)]);
        pending.push([k, h]);
      }
    }
    const removed = [...synced.keys()].filter((k) => !entries.has(k));
    for (const k of removed) cmds.push(['DEL', k]);
    if (!cmds.length) return;
    try {
      // keep each request well under Upstash's 10 MB limit
      let batch = [];
      let size = 0;
      for (const c of cmds) {
        const n = (c[2] || '').length + c[1].length + 16;
        if (batch.length && (size + n > 6_000_000 || batch.length >= 500)) {
          await pipeline(batch);
          batch = [];
          size = 0;
        }
        batch.push(c);
        size += n;
      }
      await pipeline(batch);
      for (const [k, h] of pending) synced.set(k, h);
      for (const k of removed) synced.delete(k);
    } catch (e) {
      console.error('Storage sync failed, will retry:', e.message);
      if (!retryTimer) retryTimer = setTimeout(() => ((retryTimer = null), syncRemote()), 10_000);
    }
  });
  return syncChain;
}

// ---------------------------------------------------------------- public API
async function init() {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(uploadsDir, { recursive: true, mode: 0o700 });
  if (remote) {
    data = await loadRemote(); // throws if unreachable: never start empty over real data
  } else {
    data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  }
  for (const [k, v] of Object.entries(COLLECTIONS)) {
    if (data[k] === undefined) data[k] = JSON.parse(JSON.stringify(v));
  }
  writeLocal();
}

function writeLocal() {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function save() {
  if (timer) return;
  timer = setTimeout(flush, 150);
}
function flush() {
  if (timer) clearTimeout(timer);
  timer = null;
  writeLocal();
  if (remote) return syncRemote();
  return Promise.resolve();
}

// Encrypted upload blobs.
const safeName = (name) => {
  if (!/^[a-f0-9]{24}\.bin$/.test(name)) throw new Error('Invalid file name');
  return name;
};
async function putFile(name, buf) {
  fs.writeFileSync(path.join(uploadsDir, safeName(name)), buf, { mode: 0o600 });
  if (remote) await cmd('SET', `${PREFIX}file:${name}`, buf.toString('base64'));
}
async function getFile(name) {
  const p = path.join(uploadsDir, safeName(name));
  if (fs.existsSync(p)) return fs.readFileSync(p);
  if (remote) {
    const v = await cmd('GET', `${PREFIX}file:${name}`);
    if (v) {
      const buf = Buffer.from(v, 'base64');
      fs.writeFileSync(p, buf, { mode: 0o600 }); // local cache
      return buf;
    }
  }
  throw new Error('File not found');
}
async function deleteFile(name) {
  try {
    fs.unlinkSync(path.join(uploadsDir, safeName(name)));
  } catch {
    /* already gone */
  }
  if (remote) await cmd('DEL', `${PREFIX}file:${name}`).catch((e) => console.error('file delete failed:', e.message));
}

module.exports = {
  init,
  save,
  flush,
  putFile,
  getFile,
  deleteFile,
  uploadsDir,
  isRemote: () => !!remote,
  get data() {
    return data;
  },
};
