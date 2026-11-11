'use strict';
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..', '..');

// Minimal .env loader (no dependency). Real environment variables win.
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadEnv(path.join(root, '.env'));

const env = process.env;
const port = parseInt(env.PORT, 10) || 3000;
// RENDER_EXTERNAL_URL is set automatically on Render.com
const baseUrl = (env.BASE_URL || env.RENDER_EXTERNAL_URL || `http://localhost:${port}`).replace(/\/+$/, '');

// Accept the key as 64 hex chars (npm run setup) or base64 of 32 bytes (Render "generateValue").
function parseKey(v) {
  v = String(v || '').trim();
  if (/^[0-9a-fA-F]{64}$/.test(v)) return v.toLowerCase();
  try {
    const b = Buffer.from(v, 'base64');
    if (b.length === 32) return b.toString('hex');
  } catch {
    /* fallthrough */
  }
  return '';
}

const num = (v, d) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : d);

const config = {
  root,
  port,
  baseUrl,
  origin: new URL(baseUrl).origin,
  secure: baseUrl.startsWith('https://'),
  trustProxy: env.TRUST_PROXY === '1' || !!env.RENDER,
  encryptionKeyHex: parseKey(env.ENCRYPTION_KEY),
  google: {
    clientId: env.GOOGLE_CLIENT_ID || '',
    clientSecret: env.GOOGLE_CLIENT_SECRET || '',
    redirectUri: `${baseUrl}/auth/google/callback`,
  },
  send: {
    dailyLimit: Math.max(1, Math.min(500, num(env.DAILY_SEND_LIMIT, 40))),
    minDelay: Math.max(5, num(env.MIN_DELAY_SECONDS, 45)),
    maxDelay: Math.max(5, num(env.MAX_DELAY_SECONDS, 120)),
  },
  devAuth: env.DEV_FAKE_AUTH === '1',
  dataDir: env.DATA_DIR ? path.resolve(env.DATA_DIR) : path.join(root, 'data'),
  publicDir: path.join(root, 'public'),
  maxUploadBytes: 5 * 1024 * 1024,
  maxJsonBytes: 256 * 1024,
  sessionTtlMs: 7 * 24 * 3600 * 1000,
  maxContactsPerUser: 2000,
};
if (config.send.maxDelay < config.send.minDelay) config.send.maxDelay = config.send.minDelay;

config.validate = function validate() {
  const problems = [];
  if (!/^[0-9a-fA-F]{64}$/.test(config.encryptionKeyHex)) {
    problems.push('ENCRYPTION_KEY must be 64 hex characters (or base64 of 32 bytes). Run `npm run setup`.');
  }
  if (!!config.google.clientId !== !!config.google.clientSecret) {
    problems.push('Set both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (only one is set).');
  }
  if (config.devAuth && config.secure) problems.push('DEV_FAKE_AUTH must not be enabled on an https (production) BASE_URL.');
  return problems;
};

module.exports = config;
