'use strict';
// Proves data survives a restart with a wiped disk (like Render Free), using a fake Upstash.
//   node scripts/storetest.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const TOKEN = 'test-upstash-token';
const store = new Map();
let commands = 0;
let failures = 0;
const ok = (c, m) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`);
  if (!c) failures++;
};

function run(c) {
  commands++;
  const [op, ...a] = c.map(String);
  switch (op.toUpperCase()) {
    case 'SET': store.set(a[0], a[1]); return 'OK';
    case 'GET': return store.has(a[0]) ? store.get(a[0]) : null;
    case 'DEL': return a.reduce((n, k) => n + (store.delete(k) ? 1 : 0), 0);
    case 'MGET': return a.map((k) => (store.has(k) ? store.get(k) : null));
    case 'SCAN': {
      const pat = a[a.indexOf('MATCH') + 1].replace(/\*$/, '');
      return ['0', [...store.keys()].filter((k) => k.startsWith(pat))];
    }
    default: throw new Error(`unsupported ${op}`);
  }
}
const mock = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorized' }));
    }
    const body = JSON.parse(b);
    const out = req.url === '/pipeline' ? body.map((c) => ({ result: run(c) })) : { result: run(body) };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
  });
});

function multipart(field, filename, data) {
  const bd = `----t${crypto.randomBytes(6).toString('hex')}`;
  return {
    body: Buffer.concat([Buffer.from(`--${bd}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`), data, Buffer.from(`\r\n--${bd}--\r\n`)]),
    type: `multipart/form-data; boundary=${bd}`,
  };
}

async function startApp(port, upstashUrl, token = TOKEN) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-store-')); // fresh, empty disk every start
  const env = {
    ...process.env, PORT: String(port), BASE_URL: `http://localhost:${port}`, DATA_DIR: dataDir,
    ENCRYPTION_KEY: KEY, DEV_FAKE_AUTH: '1', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '',
    UPSTASH_REDIS_REST_URL: upstashUrl, UPSTASH_REDIS_REST_TOKEN: token,
  };
  const p = spawn(process.execPath, [path.join(root, 'src/server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  const started = await new Promise((resolve) => {
    p.on('exit', () => resolve(false));
    const t = setInterval(() => out.includes('running at') && (clearInterval(t), resolve(true)), 50);
  });
  return { p, started, log: () => out };
}
const KEY = crypto.randomBytes(32).toString('hex');

(async () => {
  await new Promise((r) => mock.listen(0, r));
  const url = `http://127.0.0.1:${mock.address().port}`;
  const port = 3994;
  const base = `http://localhost:${port}`;
  let cookie = '';
  let csrf = '';
  const req = async (method, p, { json, raw, type } = {}) => {
    const h = { Cookie: cookie, Origin: base };
    if (method !== 'GET') h['X-CSRF-Token'] = csrf;
    let body;
    if (json) { h['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    if (raw) { h['Content-Type'] = type; body = raw; }
    const r = await fetch(base + p, { method, headers: h, body, redirect: 'manual' });
    for (const c of r.headers.getSetCookie?.() || []) if (c.startsWith('sid=')) cookie = c.split(';')[0];
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, data: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };

  try {
    // 1st run: create data
    let app = await startApp(port, url);
    ok(app.started && app.log().includes('Upstash Redis (persistent)'), 'app starts with Upstash storage');
    await req('POST', '/auth/dev-login');
    csrf = (await req('GET', '/api/me')).data.csrfToken;
    await req('PUT', '/api/profile', { json: { fullName: 'Persist Test', headline: 'H', domains: ['Data Analyst'], includeOptOut: true, attachMode: 'tailored' } });
    const mp = multipart('file', 'resume.txt', Buffer.from('SKILLS\nPython, SQL\nPhone +91 98765 43210'));
    await req('POST', '/api/resume', { raw: mp.body, type: mp.type });
    const cmp = multipart('file', 'c.csv', Buffer.from('Name,Email,Type\nA,a@example.com,HR\nB,b@example.com,Professor\n'));
    await req('POST', '/api/contacts/upload', { raw: cmp.body, type: cmp.type });
    await new Promise((r) => setTimeout(r, 600));
    const before = commands;
    await new Promise((r) => setTimeout(r, 6000)); // idle: queue worker ticks but nothing changed
    ok(commands === before, `no storage commands while idle (used ${commands - before})`);
    app.p.kill('SIGTERM');
    await new Promise((r) => app.p.on('exit', r));
    ok([...store.keys()].some((k) => k.startsWith('ro:v1:file:')), 'resume file stored in Upstash');
    ok(![...store.values()].some((v) => /Python, SQL|Persist Test|a@example\.com/.test(v)), 'everything in Upstash is encrypted (no readable names, emails or resume text)');

    // 2nd run: brand-new empty disk, same Upstash
    app = await startApp(port, url);
    let r = await req('GET', '/api/me');
    ok(r.data.authenticated && r.data.user.profile.fullName === 'Persist Test', 'after restart: still signed in, profile intact');
    ok(r.data.user.profile.phone === '+91 98765 43210' && r.data.user.resumeFile, 'after restart: resume + auto-filled phone intact');
    r = await req('GET', '/api/contacts');
    ok(r.data.contacts.length === 2, 'after restart: contacts intact');
    r = await req('GET', '/api/resume/file');
    ok(r.status === 200 && r.data.toString().includes('Python, SQL'), 'after restart: resume file restored from Upstash');
    r = await req('POST', '/api/contacts/delete', { json: { all: true } });
    await new Promise((r2) => setTimeout(r2, 600));
    ok(store.size > 0 && commands > 0, 'deletes synced to Upstash');
    app.p.kill('SIGTERM');
    await new Promise((r2) => app.p.on('exit', r2));

    // wrong token: must refuse to start rather than run on empty data
    app = await startApp(port, url, 'wrong-token');
    ok(!app.started && /Refusing to start/.test(app.log()), 'refuses to start if Upstash unreachable (protects data)');
  } catch (e) {
    console.error(e);
    failures++;
  }
  mock.close();
  console.log(failures ? `\n${failures} storage test(s) FAILED` : '\nAll storage tests passed');
  process.exit(failures ? 1 : 0);
})();
