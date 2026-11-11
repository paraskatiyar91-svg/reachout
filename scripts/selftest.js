'use strict';
// End-to-end self test in dev mode (simulated Gmail, template AI). No network needed.
//   npm test
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reachout-test-'));
const PORT = 3999;
const BASE = `http://localhost:${PORT}`;

let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
};

function multipart(field, filename, data, extra = {}) {
  const b = `----t${crypto.randomBytes(6).toString('hex')}`;
  const parts = [];
  for (const [k, v] of Object.entries(extra)) parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`), data, Buffer.from(`\r\n--${b}--\r\n`));
  return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${b}` };
}

// ---- fake AI provider (Gemini + OpenAI shapes) ----
const http = require('http');
const GOOD_GEMINI = 'AIzaTEST-gemini-key-1234567890';
const GOOD_OPENAI = 'sk-test-openai-key-abcdefghijkl';
const seenKeys = [];
const MOCK_EMAIL = { subject: 'Research on clinical NLP – Paras', body: 'Dear Prof. Sharma,\n\nAI-written body from the fake provider.' };
const MOCK_RESUME = { headline: 'AI tailored headline', summary: 'AI summary', skills: [{ group: 'Core', items: ['Python', 'SQL'] }], experience: [], projects: [{ name: 'Readmission predictor', tech: 'scikit-learn', bullets: ['Built it'] }], education: [], achievements: [], keywordsMatched: ['Python'] };
function startMockAi() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        const isGemini = req.url.startsWith('/gemini/');
        const key = isGemini ? req.headers['x-goog-api-key'] : String(req.headers.authorization || '').replace(/^Bearer /, '');
        seenKeys.push(key);
        if (key !== GOOD_GEMINI && key !== GOOD_OPENAI) {
          res.writeHead(401, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: 'API key not valid' } }));
        }
        const body = JSON.parse(b || '{}');
        const sys = isGemini ? body.systemInstruction?.parts?.[0]?.text || '' : body.messages?.[0]?.content || '';
        const out = JSON.stringify(/resume editor/.test(sys) ? MOCK_RESUME : /cold emails/.test(sys) ? MOCK_EMAIL : { ok: true });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(isGemini ? { candidates: [{ content: { parts: [{ text: out }] } }] } : { choices: [{ message: { content: out } }] }));
      });
    });
    srv.listen(0, () => resolve(srv));
  });
}

(async () => {
  const mockAi = await startMockAi();
  const env = {
    ...process.env,
    PORT: String(PORT),
    BASE_URL: BASE,
    DATA_DIR: dataDir,
    ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
    DEV_FAKE_AUTH: '1',
    GOOGLE_CLIENT_ID: '',
    GOOGLE_CLIENT_SECRET: '',
    AI_PROVIDER: 'none',
    ANTHROPIC_API_KEY: '',
    GEMINI_API_KEY: '',
    MIN_DELAY_SECONDS: '5',
    AI_TEST_BASE_URL: `http://127.0.0.1:${mockAi.address().port}`,
    MAX_DELAY_SECONDS: '5',
  };
  const srv = spawn(process.execPath, [path.join(root, 'src/server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stderr.on('data', (d) => process.stderr.write(d));
  await new Promise((r) => srv.stdout.once('data', r));

  let cookie = '';
  let csrf = '';
  const req = async (method, p, { json, raw, type, headers = {} } = {}) => {
    const h = { Cookie: cookie, ...headers };
    if (method !== 'GET') h['X-CSRF-Token'] = csrf;
    let body;
    if (json !== undefined) {
      h['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    } else if (raw) {
      h['Content-Type'] = type;
      body = raw;
    }
    const r = await fetch(BASE + p, { method, headers: h, body, redirect: 'manual' });
    const sc = r.headers.getSetCookie?.() || [];
    for (const c of sc) if (c.startsWith('sid=')) cookie = c.split(';')[0];
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, headers: r.headers, data: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };

  try {
    // security headers + static
    let r = await req('GET', '/');
    ok(r.status === 200 && r.headers.get('content-security-policy')?.includes("script-src 'self'"), 'index served with CSP');
    ok(r.headers.get('x-frame-options') === 'DENY', 'X-Frame-Options set');
    r = await req('GET', '/../.env');
    ok(r.status === 404, 'path traversal blocked');
    r = await req('GET', '/api/contacts');
    ok(r.status === 401, 'API requires auth');

    // dev login
    r = await req('POST', '/auth/dev-login', { headers: { Origin: BASE } });
    ok(r.status === 302 && cookie.startsWith('sid='), 'dev login sets session cookie');
    r = await req('GET', '/api/me');
    csrf = r.data.csrfToken;
    ok(r.data.authenticated && csrf, 'session works, CSRF token issued');

    // CSRF + origin checks
    const goodCsrf = csrf;
    csrf = 'wrong';
    r = await req('PUT', '/api/profile', { json: { fullName: 'X' } });
    ok(r.status === 403, 'bad CSRF token rejected');
    csrf = goodCsrf;
    r = await req('PUT', '/api/profile', { json: { fullName: 'X' }, headers: { Origin: 'https://evil.example' } });
    ok(r.status === 403, 'cross-origin request rejected');

    // profile
    r = await req('PUT', '/api/profile', {
      json: {
        fullName: 'Paras Katiyar', headline: 'B.Tech CSE · Python, SQL, ML', phone: '+91 90000 00000', location: 'Ludhiana, India',
        linkedin: 'https://linkedin.com/in/example', github: 'https://github.com/example', portfolio: '',
        domains: ['Software Engineer', 'Data Analyst', 'Data Scientist'], includeOptOut: true, attachMode: 'tailored', signature: '',
      },
    });
    ok(r.status === 200 && r.data.user.profile.domains.length === 3, 'profile saved with 3 domains');
    r = await req('PUT', '/api/profile', { json: { fullName: 'A', linkedin: 'javascript:alert(1)' } });
    ok(r.status === 400, 'javascript: URL rejected');

    // resume upload (txt) + bad pdf
    const resumeTxt = `SUMMARY\nComputer science student who builds data tools.\n\nSKILLS\nPython, SQL, Java, Spring Boot, Power BI, Pandas, scikit-learn\n\nPROJECTS\n• Hospital readmission predictor – scikit-learn model, 0.81 AUC\n• Expense tracker REST API in Spring Boot with PostgreSQL\n\nEDUCATION\nB.Tech Computer Science, XYZ University, 2023–2027, CGPA 8.4`;
    let mp = multipart('file', 'resume.txt', Buffer.from(resumeTxt));
    r = await req('POST', '/api/resume', { raw: mp.body, type: mp.type });
    ok(r.status === 200 && r.data.extracted && r.data.user.profile.resumeText.includes('Spring Boot'), 'TXT resume uploaded + text extracted');
    mp = multipart('file', 'fake.pdf', Buffer.from('<script>alert(1)</script>'));
    r = await req('POST', '/api/resume', { raw: mp.body, type: mp.type });
    ok(r.status === 400, 'fake PDF rejected by magic-byte check');
    mp = multipart('file', 'resume.exe', Buffer.from('MZ'));
    r = await req('POST', '/api/resume', { raw: mp.body, type: mp.type });
    ok(r.status === 400, 'disallowed extension rejected');
    const stored = fs.readdirSync(path.join(dataDir, 'uploads'));
    const onDisk = fs.readFileSync(path.join(dataDir, 'uploads', stored[0]));
    ok(stored.length === 1 && !onDisk.includes(Buffer.from('Spring Boot')), 'resume stored encrypted at rest');
    r = await req('GET', '/api/resume/file');
    ok(r.status === 200 && r.data.toString().includes('Spring Boot'), 'resume decrypts on download');
    // PDF upload with text extraction
    const { renderResume } = require(path.join(root, 'src/lib/pdf.js'));
    const pdfBuf = renderResume({ fullName: 'Paras Katiyar', contactEmail: 'p@example.com' }, { raw: resumeTxt });
    mp = multipart('file', 'My Resume.pdf', pdfBuf, { replaceText: '1' });
    r = await req('POST', '/api/resume', { raw: mp.body, type: mp.type });
    ok(r.status === 200 && r.data.extracted && /Spring Boot/.test(r.data.user.profile.resumeText) && /XYZ University/.test(r.data.user.profile.resumeText),
      'PDF resume uploaded + text extracted');
    ok(fs.readdirSync(path.join(dataDir, 'uploads')).length === 1, 'old resume file replaced, not left on disk');

    // contacts xlsx
    const xlsx = fs.readFileSync(path.join(root, 'public/contacts_template.xlsx'));
    mp = multipart('file', 'contacts.xlsx', xlsx);
    r = await req('POST', '/api/contacts/upload', { raw: mp.body, type: mp.type });
    ok(r.status === 200 && r.data.added === 3, `xlsx upload added 3 contacts (got ${JSON.stringify(r.data)})`);
    // csv with a bad row + duplicate
    const csv = 'Name,Email,Type,Company,Domain,Notes\n"Kumar, Dev",dev.k@example.org,Recruiter,Acme,Software Engineer,"Hiring ""Java"" folks"\nBad Row,not-an-email,HR,,,\nDup,PRIYA.MEHTA@example.com,HR,XYZ Tech,,updated\n';
    mp = multipart('file', 'c.csv', Buffer.from(csv));
    r = await req('POST', '/api/contacts/upload', { raw: mp.body, type: mp.type });
    ok(r.data.added === 1 && r.data.updated === 1 && r.data.errors.length === 1, `csv: quoted fields, dedupe, invalid email reported (${JSON.stringify(r.data)})`);
    r = await req('GET', '/api/contacts');
    const contacts = r.data.contacts;
    const kumar = contacts.find((c) => c.email === 'dev.k@example.org');
    ok(kumar && kumar.name === 'Kumar, Dev' && kumar.type === 'HR' && kumar.description === 'Hiring "Java" folks', 'csv parsing + header synonyms + type normalisation');

    // tailored resume pdf
    r = await req('POST', '/api/tailored', { json: { domain: 'Data Analyst' } });
    ok(r.status === 200, 'tailored resume generated');
    r = await req('GET', `/api/tailored/pdf?domain=${encodeURIComponent('Data Analyst')}`);
    ok(r.status === 200 && r.data.subarray(0, 5).toString() === '%PDF-', 'tailored resume PDF served');
    fs.writeFileSync(path.join(dataDir, 'test.pdf'), r.data);

    // drafts
    r = await req('POST', '/api/drafts/generate', { json: { contactIds: contacts.map((c) => c.id) } });
    ok(r.status === 200 && r.data.results.every((x) => x.ok), 'drafts generated for all contacts');
    r = await req('GET', '/api/drafts');
    const drafts = r.data.drafts;
    const prof = drafts.find((d) => d.contact.type === 'Professor');
    ok(drafts.length === 4 && prof.draft.body.includes('Prof. Sharma') && prof.draft.body.includes('NLP'), 'professor draft is personalised');

    // ---- per-user AI keys
    r = await req('PUT', '/api/ai/keys/gemini', { json: { apiKey: 'AIzaBAD-key-000000000000' } });
    ok(r.status === 400 && /rejected your API key/.test(r.data.error), 'invalid AI key rejected with a clear message');
    r = await req('PUT', '/api/ai/keys/gemini', { json: { apiKey: GOOD_GEMINI } });
    ok(r.status === 200 && r.data.user.ai.active === 'gemini' && r.data.user.ai.keys.gemini.last4 === GOOD_GEMINI.slice(-4), "user's Gemini key connected + active");
    ok(!JSON.stringify(r.data).includes(GOOD_GEMINI), 'API key is never sent back to the browser');
    await new Promise((res) => setTimeout(res, 400));
    ok(!fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8').includes(GOOD_GEMINI), 'API key encrypted in the database');
    seenKeys.length = 0;
    r = await req('POST', '/api/drafts/generate', { json: { contactIds: [prof.contact.id] } });
    ok(r.data.results[0].ok, 'draft regenerated with user AI');
    r = await req('GET', '/api/drafts');
    const aiDraft = r.data.drafts.find((d) => d.contact.id === prof.contact.id).draft;
    ok(aiDraft.subject === MOCK_EMAIL.subject && aiDraft.body === MOCK_EMAIL.body, 'email written by the AI provider');
    ok(seenKeys.length >= 2 && seenKeys.every((k) => k === GOOD_GEMINI), "provider called with this user's own key");
    r = await req('PUT', '/api/ai/keys/openai', { json: { apiKey: GOOD_OPENAI, model: 'gpt-4o-mini' } });
    ok(r.status === 200 && r.data.user.ai.active === 'openai', 'ChatGPT key connected and switched active');
    r = await req('PUT', '/api/ai/active', { json: { provider: 'gemini' } });
    ok(r.data.user.ai.active === 'gemini', 'switch active provider back to Gemini');
    r = await req('DELETE', '/api/ai/keys/gemini');
    ok(r.data.user.ai.active === 'openai' && !r.data.user.ai.keys.gemini, 'removing active key falls back to the other one');
    r = await req('PUT', '/api/ai/keys/openai', { json: { model: 'bad model; rm -rf' } });
    ok(r.status === 400, 'model name validated');

    // send without approval should fail
    r = await req('POST', '/api/send', { json: {} });
    ok(r.status === 400, 'cannot send unapproved drafts');

    // gmail connect (simulated) + edit + approve + test + send
    r = await req('GET', '/auth/google/gmail');
    ok(r.status === 302, 'gmail connect (simulated in dev)');
    const target = drafts[0].contact.id;
    r = await req('PUT', `/api/drafts/${target}`, { json: { subject: 'Edited subject\r\nBcc: victim@example.com', approved: true } });
    ok(r.status === 200 && r.data.draft.approved, 'draft edited + approved');
    r = await req('POST', '/api/send/test', { json: { contactId: target } });
    ok(r.status === 200 && r.data.simulated, 'test email (simulated)');
    r = await req('POST', '/api/drafts/approve', { json: { approved: true } });
    ok(r.data.updated === 4, 'approve all');
    r = await req('POST', '/api/send', { json: {} });
    ok(r.status === 200 && r.data.queued === 4, 'queued 4 emails');
    r = await req('PUT', `/api/drafts/${target}`, { json: { subject: 'x' } });
    ok(r.status === 409, 'queued draft is locked');

    // wait for the worker to send everything (5s spacing)
    for (let i = 0; i < 20; i++) {
      await new Promise((res) => setTimeout(res, 2500));
      r = await req('GET', '/api/activity');
      if (!r.data.pending.length) break;
    }
    const sent = r.data.log.filter((e) => e.status === 'sent' && !e.test);
    ok(r.data.pending.length === 0 && sent.length === 4, `queue drained: ${sent.length} sent (simulated)`);

    // MIME header-injection check
    const { buildMime } = require(path.join(root, 'src/lib/google.js'));
    const mime = buildMime({ fromName: 'A', fromEmail: 'a@x.com', to: 'b@y.com\r\nBcc: evil@z.com', subject: 'Hi\r\nBcc: evil@z.com', text: 'hello' });
    ok(!/\r\nBcc:/i.test(mime), 'MIME headers cannot be injected');

    // logout + account deletion
    r = await req('POST', '/api/account/delete', { json: { confirm: 'DELETE' } });
    ok(r.status === 200, 'account deleted');
    r = await req('GET', '/api/contacts');
    ok(r.status === 401, 'session invalid after deletion');
    ok(fs.readdirSync(path.join(dataDir, 'uploads')).length === 0, 'uploaded resume removed from disk');
  } catch (e) {
    console.error(e);
    failures++;
  } finally {
    srv.kill('SIGTERM');
    mockAi.close();
  }
  console.log(failures ? `\n${failures} test(s) FAILED` : '\nAll tests passed');
  console.log(`(test data in ${dataDir})`);
  process.exit(failures ? 1 : 0);
})();
