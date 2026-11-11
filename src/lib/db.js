'use strict';
// Tiny JSON-file store with atomic writes. Good for a prototype / single server.
// Swap for Postgres/SQLite when you have many users.
const fs = require('fs');
const path = require('path');
const config = require('./config');

const file = path.join(config.dataDir, 'db.json');
const uploadsDir = path.join(config.dataDir, 'uploads');
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

function init() {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(uploadsDir, { recursive: true, mode: 0o700 });
  data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  for (const [k, v] of Object.entries(COLLECTIONS)) {
    if (data[k] === undefined) data[k] = JSON.parse(JSON.stringify(v));
  }
}

function save() {
  if (timer) return;
  timer = setTimeout(flush, 150);
}
function flush() {
  if (timer) clearTimeout(timer);
  timer = null;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

module.exports = {
  init,
  save,
  flush,
  uploadsDir,
  get data() {
    return data;
  },
};
