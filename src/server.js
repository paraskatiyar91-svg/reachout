'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const config = require('./lib/config');
const db = require('./lib/db');
const google = require('./lib/google');
const ai = require('./lib/ai');
const mailer = require('./lib/mailer');
const parsers = require('./lib/parsers');
const { renderResume } = require('./lib/pdf');
const { pdfText } = require('./lib/pdftext');
const C = require('./lib/crypto');
const H = require('./lib/http');
const { HttpError } = H;

// ---------------------------------------------------------------- sessions
const SESSION_IDLE_MS = 3 * 24 * 3600 * 1000; // signed out after 3 days of inactivity
const MAX_SESSIONS_PER_USER = 10;

function createSession(req, res, userId) {
  const old = H.getCookie(req, 'sid');
  if (old) delete db.data.sessions[C.sha256(old)]; // prevent session fixation
  const token = C.randomToken();
  db.data.sessions[C.sha256(token)] = {
    userId,
    csrf: C.randomToken(24),
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    expiresAt: Date.now() + config.sessionTtlMs,
  };
  // keep only the newest sessions per user
  const mine = Object.entries(db.data.sessions).filter(([, s]) => s.userId === userId).sort((a, b) => b[1].createdAt - a[1].createdAt);
  for (const [k] of mine.slice(MAX_SESSIONS_PER_USER)) delete db.data.sessions[k];
  db.save();
  H.setCookie(res, 'sid', token, { maxAge: config.sessionTtlMs / 1000 });
}

function getAuth(req) {
  const token = H.getCookie(req, 'sid');
  if (!token) return null;
  const key = C.sha256(token);
  const session = db.data.sessions[key];
  const now = Date.now();
  if (!session || session.expiresAt < now || (session.lastSeenAt || session.createdAt) + SESSION_IDLE_MS < now) return null;
  const user = db.data.users[session.userId];
  if (!user) return null;
  if (now - (session.lastSeenAt || 0) > 15 * 60_000) {
    session.lastSeenAt = now; // sliding idle timeout, written at most every 15 min
    db.save();
  }
  return { key, session, user };
}

function requireAuth(req) {
  const a = getAuth(req);
  if (!a) throw new HttpError(401, 'Please sign in');
  return a;
}

function checkCsrf(req, session) {
  const origin = req.headers.origin;
  if (origin && origin !== config.origin) throw new HttpError(403, 'Cross-origin request blocked');
  const t = req.headers['x-csrf-token'];
  if (!t || !C.safeEqual(t, session.csrf)) throw new HttpError(403, 'Invalid CSRF token. Refresh the page.');
}

setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [k, s] of Object.entries(db.data.sessions)) {
    if (s.expiresAt < now || (s.lastSeenAt || s.createdAt) + SESSION_IDLE_MS < now) (delete db.data.sessions[k], (changed = true));
  }
  for (const [k, s] of Object.entries(db.data.oauthStates)) if (s.expiresAt < now) (delete db.data.oauthStates[k], (changed = true));
  if (changed) db.save();
}, 10 * 60_000).unref();

// ---------------------------------------------------------------- helpers
const clip = (v, n) => (typeof v === 'string' ? v.replace(/\u0000/g, '').trim().slice(0, n) : '');
const isUrlOrEmpty = (s) => !s || /^https?:\/\/[^\s<>"]+$/i.test(s);

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    picture: user.picture,
    dev: !!user.dev,
    profile: user.profile,
    resumeFile: user.resumeFile ? { originalName: user.resumeFile.originalName, size: user.resumeFile.size, uploadedAt: user.resumeFile.uploadedAt } : null,
    gmail: user.gmail ? { email: user.gmail.email, connectedAt: user.gmail.connectedAt, simulated: !!user.dev } : null,
    ai: {
      active: user.ai?.active || null,
      keys: Object.fromEntries(
        Object.entries(user.ai?.keys || {}).map(([p, k]) => [p, { last4: k.last4, model: k.model, connectedAt: k.connectedAt }]),
      ),
    },
  };
}

function newUser({ sub, email, name, picture, dev = false }) {
  return {
    id: C.randomId(),
    googleSub: sub,
    email,
    name: name || '',
    picture: picture || '',
    dev,
    createdAt: Date.now(),
    profile: {
      fullName: name || '',
      headline: '',
      phone: '',
      location: '',
      linkedin: '',
      github: '',
      portfolio: '',
      domains: [],
      resumeText: '',
      signature: '',
      includeOptOut: true,
      attachMode: 'tailored',
    },
    resumeFile: null,
    gmail: null,
    ai: { active: null, keys: {} },
  };
}

async function deleteResumeFile(user) {
  if (!user.resumeFile) return;
  const name = user.resumeFile.storedName;
  user.resumeFile = null;
  await db.deleteFile(name);
}

const userContacts = (user) => (db.data.contacts[user.id] ||= []);
const userDrafts = (user) => (db.data.drafts[user.id] ||= {});

function sendPdf(res, buf, filename) {
  H.securityHeaders(res, { csp: false });
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': buf.length,
    'Content-Disposition': H.contentDisposition('inline', filename),
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

// ---------------------------------------------------------------- auth routes
function startOAuth(res, purpose, extra = {}) {
  const state = C.randomToken(24);
  const verifier = C.randomToken(48);
  db.data.oauthStates[state] = { purpose, verifier, expiresAt: Date.now() + 10 * 60_000, ...extra };
  db.save();
  H.setCookie(res, 'oauth_state', state, { maxAge: 600 });
  H.redirect(res, google.authUrl({ purpose, state, challenge: C.pkceChallenge(verifier), loginHint: extra.loginHint }));
}

async function authRoutes(req, res, url) {
  const p = url.pathname;

  if (req.method === 'GET' && p === '/auth/google/login') {
    if (!config.google.clientId) return H.redirect(res, '/?error=google_not_configured');
    return startOAuth(res, 'login');
  }

  if (req.method === 'GET' && p === '/auth/google/gmail') {
    const a = getAuth(req);
    if (!a) return H.redirect(res, '/?error=signin_required');
    if (a.user.dev) {
      a.user.gmail = { email: a.user.email, connectedAt: Date.now() };
      db.save();
      return H.redirect(res, '/?ok=gmail_connected#start');
    }
    if (!config.google.clientId) return H.redirect(res, '/?error=google_not_configured');
    return startOAuth(res, 'gmail', { userId: a.user.id, loginHint: a.user.email });
  }

  if (req.method === 'GET' && p === '/auth/google/callback') {
    const state = url.searchParams.get('state') || '';
    const cookieState = H.getCookie(req, 'oauth_state') || '';
    H.clearCookie(res, 'oauth_state');
    const st = db.data.oauthStates[state];
    delete db.data.oauthStates[state];
    db.save();
    if (!st || st.expiresAt < Date.now() || !cookieState || !C.safeEqual(cookieState, state)) return H.redirect(res, '/?error=oauth_state');
    if (url.searchParams.get('error')) return H.redirect(res, '/?error=oauth_denied');
    const code = url.searchParams.get('code');
    if (!code) return H.redirect(res, '/?error=oauth_failed');

    let tokens;
    let info;
    try {
      tokens = await google.exchangeCode(code, st.verifier);
      info = await google.userInfo(tokens.access_token);
    } catch (e) {
      console.error('OAuth exchange failed:', e.message);
      return H.redirect(res, '/?error=oauth_failed');
    }
    if (!info.sub || !info.email || info.email_verified === false) return H.redirect(res, '/?error=email_unverified');

    // Note: we never revoke the previous token when replacing it. Google revokes the whole grant
    // (including the new token) when any token of it is revoked.
    const storeGmail = (user) => {
      user.gmail = {
        email: info.email,
        refreshTokenEnc: C.encrypt(tokens.refresh_token),
        accessTokenEnc: C.encrypt(tokens.access_token),
        accessExpiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
        connectedAt: Date.now(),
      };
    };

    if (st.purpose === 'login') {
      let user = Object.values(db.data.users).find((u) => u.googleSub === info.sub);
      const isNew = !user;
      if (!user) {
        user = newUser({ sub: info.sub, email: info.email, name: info.name, picture: info.picture });
        db.data.users[user.id] = user;
      } else {
        Object.assign(user, { email: info.email, name: info.name || user.name, picture: info.picture || user.picture });
      }
      const granted = google.hasGmailScope(tokens);
      if (granted && tokens.refresh_token) storeGmail(user);
      db.save();
      createSession(req, res, user.id);
      // Gmail permission was granted earlier but we hold no refresh token (e.g. server data was
      // reset): bounce once through the consent screen to get a fresh one. Seamless for the user.
      if (granted && !user.gmail) return startOAuth(res, 'gmail', { userId: user.id, loginHint: info.email });
      return H.redirect(res, isNew ? '/#start' : '/');
    }

    if (st.purpose === 'gmail') {
      const a = getAuth(req);
      if (!a || a.user.id !== st.userId) return H.redirect(res, '/?error=signin_required');
      if (!google.hasGmailScope(tokens)) return H.redirect(res, '/?error=gmail_scope#start');
      if (!tokens.refresh_token) return H.redirect(res, '/?error=no_refresh_token#start');
      storeGmail(a.user);
      db.save();
      return H.redirect(res, '/?ok=gmail_connected#start');
    }
    return H.redirect(res, '/?error=oauth_failed');
  }

  if (req.method === 'POST' && p === '/auth/dev-login') {
    if (!config.devAuth || !H.isLocalRequest(req)) throw new HttpError(404, 'Not found');
    const origin = req.headers.origin;
    if (origin && origin !== config.origin) throw new HttpError(403, 'Cross-origin request blocked');
    let user = Object.values(db.data.users).find((u) => u.dev);
    if (!user) {
      user = newUser({ sub: 'dev-user', email: 'dev.student@example.com', name: 'Dev Student', dev: true });
      db.data.users[user.id] = user;
    }
    createSession(req, res, user.id);
    return H.redirect(res, '/');
  }

  if (req.method === 'POST' && p === '/auth/logout') {
    const a = getAuth(req);
    if (a) {
      checkCsrf(req, a.session);
      delete db.data.sessions[a.key];
      db.save();
    }
    H.clearCookie(res, 'sid');
    return H.sendJson(res, 200, { ok: true });
  }

  throw new HttpError(404, 'Not found');
}

// ---------------------------------------------------------------- API routes
async function api(req, res, url) {
  const p = url.pathname;
  const m = req.method;

  if (m === 'GET' && p === '/api/me') {
    const a = getAuth(req);
    return H.sendJson(res, 200, {
      authenticated: !!a,
      user: a ? publicUser(a.user) : null,
      csrfToken: a ? a.session.csrf : null,
      config: {
        devAuth: config.devAuth,
        googleConfigured: !!config.google.clientId,
        aiProviders: Object.fromEntries(Object.entries(ai.PROVIDERS).map(([k, v]) => [k, { label: v.label, defaultModel: v.defaultModel, keyUrl: v.keyUrl, free: v.free }])),
        dailyLimit: config.send.dailyLimit,
        minDelay: config.send.minDelay,
        maxDelay: config.send.maxDelay,
      },
    });
  }

  const { user, session } = requireAuth(req);
  if (m !== 'GET' && m !== 'HEAD') checkCsrf(req, session);
  H.rateLimit(`user:${user.id}`, 300, 60_000);

  // ---- profile
  if (m === 'PUT' && p === '/api/profile') {
    const b = await H.readJson(req);
    const pr = user.profile;
    const next = {
      fullName: clip(b.fullName, 100),
      headline: clip(b.headline, 160),
      phone: clip(b.phone, 40),
      location: clip(b.location, 100),
      linkedin: clip(b.linkedin, 200),
      github: clip(b.github, 200),
      portfolio: clip(b.portfolio, 200),
      signature: clip(b.signature, 600),
      resumeText: typeof b.resumeText === 'string' ? b.resumeText.replace(/\u0000/g, '').slice(0, 20000) : pr.resumeText,
      includeOptOut: b.includeOptOut !== false,
      attachMode: ['tailored', 'original', 'none'].includes(b.attachMode) ? b.attachMode : 'tailored',
      domains: Array.isArray(b.domains) ? [...new Set(b.domains.map((d) => clip(d, 60)).filter(Boolean))].slice(0, 12) : pr.domains,
    };
    for (const f of ['linkedin', 'github', 'portfolio']) {
      if (!isUrlOrEmpty(next[f])) throw new HttpError(400, `${f} must be a full link starting with https://`);
    }
    if (!next.fullName) throw new HttpError(400, 'Full name is required');
    user.profile = next;
    db.save();
    return H.sendJson(res, 200, { user: publicUser(user) });
  }

  // ---- per-user AI keys (Gemini / OpenAI / Claude)
  let am;
  if (m === 'PUT' && (am = /^\/api\/ai\/keys\/(gemini|openai|anthropic)$/.exec(p))) {
    H.rateLimit(`aikey:${user.id}`, 20, 3600_000);
    const provider = am[1];
    const b = await H.readJson(req);
    const model = clip(b.model, 80) || ai.PROVIDERS[provider].defaultModel;
    if (!/^[A-Za-z0-9._:\-]+$/.test(model)) throw new HttpError(400, 'Invalid model name');
    const store = (user.ai ||= { active: null, keys: {} });
    store.keys ||= {};
    const existing = store.keys[provider];
    const apiKey = typeof b.apiKey === 'string' ? b.apiKey.trim() : '';
    if (!apiKey && !existing) throw new HttpError(400, 'Paste your API key');
    if (apiKey && !/^[\x21-\x7e]{16,400}$/.test(apiKey)) throw new HttpError(400, 'That does not look like an API key');
    const keyToTest = apiKey || C.decrypt(existing.keyEnc);
    try {
      await ai.testKey(provider, keyToTest, model);
    } catch (e) {
      throw new HttpError(400, e.message);
    }
    store.keys[provider] = {
      keyEnc: apiKey ? C.encrypt(apiKey) : existing.keyEnc,
      last4: apiKey ? apiKey.slice(-4) : existing.last4,
      model,
      connectedAt: Date.now(),
    };
    if (!store.active || b.makeActive !== false) store.active = provider;
    db.save();
    return H.sendJson(res, 200, { user: publicUser(user) });
  }

  if (m === 'DELETE' && (am = /^\/api\/ai\/keys\/(gemini|openai|anthropic)$/.exec(p))) {
    const store = user.ai || { active: null, keys: {} };
    delete store.keys[am[1]];
    if (store.active === am[1]) store.active = Object.keys(store.keys)[0] || null;
    user.ai = store;
    db.save();
    return H.sendJson(res, 200, { user: publicUser(user) });
  }

  if (m === 'PUT' && p === '/api/ai/active') {
    const b = await H.readJson(req);
    const store = user.ai || { active: null, keys: {} };
    if (b.provider === null) store.active = null;
    else if (typeof b.provider === 'string' && store.keys[b.provider]) store.active = b.provider;
    else throw new HttpError(400, 'Connect that AI provider first');
    user.ai = store;
    db.save();
    return H.sendJson(res, 200, { user: publicUser(user) });
  }

  // ---- resume file
  if (m === 'POST' && p === '/api/resume') {
    H.rateLimit(`upload:${user.id}`, 20, 3600_000);
    const { files, fields } = await H.readMultipart(req, config.maxUploadBytes);
    const f = files.find((x) => x.field === 'file');
    if (!f || !f.data.length) throw new HttpError(400, 'No file uploaded');
    const ext = path.extname(f.filename).toLowerCase();
    let mime;
    let text = '';
    let note = '';
    if (ext === '.pdf') {
      if (f.data.subarray(0, 5).toString('latin1') !== '%PDF-') throw new HttpError(400, 'That file is not a valid PDF');
      mime = 'application/pdf';
      try {
        text = await pdfText(f.data);
      } catch (e) {
        note = e.message;
      }
      if (!text && !note) note = 'No text found. This looks like a scanned/image PDF. Paste your resume text instead.';
    } else if (ext === '.docx') {
      if (f.data.readUInt32LE(0) !== 0x04034b50) throw new HttpError(400, 'That file is not a valid .docx');
      mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      try {
        text = parsers.docxText(f.data);
      } catch {
        throw new HttpError(400, 'Could not read that Word document');
      }
    } else if (ext === '.txt') {
      if (f.data.includes(0)) throw new HttpError(400, 'That file is not a text file');
      mime = 'text/plain';
      text = f.data.toString('utf8');
    } else {
      throw new HttpError(400, 'Upload a PDF, DOCX or TXT resume');
    }
    await deleteResumeFile(user);
    const storedName = `${C.randomId()}.bin`;
    await db.putFile(storedName, C.encryptBuffer(f.data));
    user.resumeFile = {
      storedName,
      originalName: path.basename(f.filename).replace(/[^\w.\- ()]/g, '_').slice(0, 100) || `resume${ext}`,
      mime,
      size: f.data.length,
      uploadedAt: Date.now(),
    };
    if (text && (fields.replaceText === '1' || !user.profile.resumeText.trim())) {
      user.profile.resumeText = text.slice(0, 20000);
    }
    // Auto-fill empty profile fields (phone, LinkedIn, GitHub) from the resume.
    const autofilled = [];
    if (text) {
      const hints = parsers.profileHints(text);
      for (const [k, v] of Object.entries(hints)) {
        if (v && !user.profile[k]) {
          user.profile[k] = v;
          autofilled.push(k);
        }
      }
    }
    db.save();
    return H.sendJson(res, 200, { user: publicUser(user), extracted: !!text, note, autofilled });
  }

  if (m === 'DELETE' && p === '/api/resume') {
    await deleteResumeFile(user);
    db.save();
    return H.sendJson(res, 200, { user: publicUser(user) });
  }

  if (m === 'GET' && p === '/api/resume/file') {
    if (!user.resumeFile) throw new HttpError(404, 'No resume uploaded');
    const data = C.decryptBuffer(await db.getFile(user.resumeFile.storedName));
    H.securityHeaders(res, { csp: false });
    res.writeHead(200, {
      'Content-Type': user.resumeFile.mime,
      'Content-Length': data.length,
      'Content-Disposition': H.contentDisposition(user.resumeFile.mime === 'application/pdf' ? 'inline' : 'attachment', user.resumeFile.originalName),
      'Cache-Control': 'no-store',
    });
    return res.end(data);
  }

  // ---- tailored resumes
  if (m === 'GET' && p === '/api/tailored') {
    const store = db.data.tailored[user.id] || {};
    const hash = C.sha256(`${user.profile.resumeText}\u0000${user.profile.fullName}`);
    return H.sendJson(res, 200, {
      tailored: Object.values(store).map((t) => ({
        domain: t.domain,
        generatedAt: t.generatedAt,
        stale: t.sourceHash !== hash,
        ai: t.ai,
        keywordsMatched: t.resume.keywordsMatched || [],
        summary: t.resume.summary || '',
      })),
    });
  }

  if (m === 'POST' && p === '/api/tailored') {
    H.rateLimit(`ai:${user.id}`, 60, 3600_000);
    const b = await H.readJson(req);
    const domain = clip(b.domain, 80);
    if (!domain) throw new HttpError(400, 'Domain is required');
    if (!user.profile.resumeText.trim()) throw new HttpError(400, 'Add your resume text first (Resume tab)');
    const t = await mailer.ensureTailored(user, domain, { force: !!b.force });
    return H.sendJson(res, 200, { domain: t.domain, generatedAt: t.generatedAt, keywordsMatched: t.resume.keywordsMatched || [] });
  }

  if (m === 'GET' && p === '/api/tailored/pdf') {
    const domain = clip(url.searchParams.get('domain'), 80);
    if (!domain) throw new HttpError(400, 'Domain is required');
    if (!user.profile.resumeText.trim()) throw new HttpError(400, 'Add your resume text first');
    let t = (db.data.tailored[user.id] || {})[mailer.domainKey(domain)];
    if (!t) {
      H.rateLimit(`ai:${user.id}`, 60, 3600_000); // generating may call the user's AI key
      t = await mailer.ensureTailored(user, domain);
    }
    return sendPdf(res, renderResume(mailer.pdfProfile(user), t.resume), `${user.profile.fullName || 'Resume'} - ${domain}.pdf`);
  }

  // ---- contacts
  if (m === 'GET' && p === '/api/contacts') {
    const drafts = userDrafts(user);
    return H.sendJson(res, 200, {
      contacts: userContacts(user).map((c) => ({ ...c, hasDraft: !!drafts[c.id], approved: !!drafts[c.id]?.approved })),
    });
  }

  if (m === 'POST' && p === '/api/contacts/upload') {
    H.rateLimit(`upload:${user.id}`, 20, 3600_000);
    const { files } = await H.readMultipart(req, config.maxUploadBytes);
    const f = files.find((x) => x.field === 'file');
    if (!f || !f.data.length) throw new HttpError(400, 'No file uploaded');
    const ext = path.extname(f.filename).toLowerCase();
    let rows;
    try {
      if (ext === '.xlsx' || f.data.readUInt32LE(0) === 0x04034b50) rows = parsers.parseXlsx(f.data);
      else if (ext === '.csv' || ext === '.txt') rows = parsers.parseCsv(f.data.toString('utf8'));
      else throw new Error('Upload an .xlsx or .csv file (old .xls is not supported — "Save as" .xlsx)');
    } catch (e) {
      throw new HttpError(400, e.message);
    }
    let parsed;
    try {
      parsed = parsers.rowsToContacts(rows);
    } catch (e) {
      throw new HttpError(400, e.message);
    }
    const list = userContacts(user);
    let added = 0;
    let updated = 0;
    let skipped = 0;
    const seen = new Set();
    for (const c of parsed.contacts) {
      if (seen.has(c.email)) {
        skipped++;
        continue;
      }
      seen.add(c.email);
      const existing = list.find((x) => x.email === c.email);
      if (existing) {
        Object.assign(existing, { ...c, email: existing.email });
        updated++;
      } else if (list.length >= config.maxContactsPerUser) {
        skipped++;
      } else {
        list.push({ id: C.randomId(), ...c, status: 'new', addedAt: Date.now() });
        added++;
      }
    }
    db.save();
    return H.sendJson(res, 200, { added, updated, skipped, errors: parsed.errors.slice(0, 50) });
  }

  if (m === 'POST' && p === '/api/contacts') {
    const b = await H.readJson(req);
    const { contacts, errors } = parsers.rowsToContacts([
      ['name', 'email', 'type', 'organization', 'domain', 'description', 'role'],
      [b.name, b.email, b.type, b.organization, b.domain, b.description, b.role].map((v) => (typeof v === 'string' ? v : '')),
    ]);
    if (!contacts.length) throw new HttpError(400, errors[0]?.replace(/^Row \d+: /, '') || 'Invalid contact');
    const list = userContacts(user);
    if (list.some((x) => x.email === contacts[0].email)) throw new HttpError(409, 'That email is already in your contacts');
    if (list.length >= config.maxContactsPerUser) throw new HttpError(400, 'Contact limit reached');
    list.push({ id: C.randomId(), ...contacts[0], status: 'new', addedAt: Date.now() });
    db.save();
    return H.sendJson(res, 200, { ok: true });
  }

  if (m === 'POST' && p === '/api/contacts/delete') {
    const b = await H.readJson(req);
    const list = userContacts(user);
    const ids = b.all === true ? list.map((c) => c.id) : Array.isArray(b.ids) ? b.ids.map(String) : [];
    const kill = new Set(ids);
    db.data.contacts[user.id] = list.filter((c) => !kill.has(c.id));
    const drafts = userDrafts(user);
    for (const id of kill) delete drafts[id];
    db.data.queue = db.data.queue.filter((j) => !(j.userId === user.id && kill.has(j.contactId)));
    db.save();
    return H.sendJson(res, 200, { deleted: list.length - db.data.contacts[user.id].length });
  }

  // ---- drafts
  if (m === 'GET' && p === '/api/drafts') {
    const drafts = userDrafts(user);
    const out = [];
    for (const c of userContacts(user)) if (drafts[c.id]) out.push({ contact: c, draft: drafts[c.id] });
    return H.sendJson(res, 200, { drafts: out });
  }

  if (m === 'POST' && p === '/api/drafts/generate') {
    H.rateLimit(`ai:${user.id}`, 300, 3600_000);
    const b = await H.readJson(req);
    const ids = Array.isArray(b.contactIds) ? b.contactIds.map(String).slice(0, 5) : [];
    if (!ids.length) throw new HttpError(400, 'Select at least one contact');
    if (!user.profile.fullName) throw new HttpError(400, 'Fill in your name in the Profile tab first');
    if (!user.profile.resumeText.trim()) throw new HttpError(400, 'Add your resume text in the Resume tab first');
    const list = userContacts(user);
    const drafts = userDrafts(user);
    const results = [];
    for (const id of ids) {
      const c = list.find((x) => x.id === id);
      if (!c) continue;
      if (c.status === 'queued' || c.status === 'sent') {
        results.push({ contactId: id, ok: false, error: `Already ${c.status}` });
        continue;
      }
      try {
        const domain = mailer.contactDomain(user, c);
        const t = await mailer.ensureTailored(user, domain);
        const email = await ai.writeEmail(user.profile, c, domain, t.resume, ai.userAi(user));
        drafts[c.id] = { subject: email.subject, body: email.body, domain, approved: false, generatedAt: Date.now(), ai: ai.aiTag(ai.userAi(user)) };
        c.status = 'drafted';
        delete c.lastError;
        results.push({ contactId: id, ok: true });
      } catch (e) {
        console.error('draft generation failed:', e.message);
        results.push({ contactId: id, ok: false, error: e.message.slice(0, 200) });
      }
    }
    db.save();
    return H.sendJson(res, 200, { results });
  }

  let mm;
  if (m === 'PUT' && (mm = /^\/api\/drafts\/([a-f0-9]{24})$/.exec(p))) {
    const c = userContacts(user).find((x) => x.id === mm[1]);
    const d = c && userDrafts(user)[c.id];
    if (!d) throw new HttpError(404, 'Draft not found');
    if (c.status === 'queued' || c.status === 'sent') throw new HttpError(409, `This email is already ${c.status}`);
    const b = await H.readJson(req);
    if (typeof b.subject === 'string') d.subject = clip(b.subject, 150);
    if (typeof b.body === 'string') d.body = b.body.replace(/\u0000/g, '').slice(0, 6000);
    if (typeof b.domain === 'string' && clip(b.domain, 80)) d.domain = clip(b.domain, 80);
    if (typeof b.approved === 'boolean') d.approved = b.approved;
    if (!d.subject || !d.body.trim()) d.approved = false;
    db.save();
    return H.sendJson(res, 200, { draft: d });
  }

  if (m === 'POST' && p === '/api/drafts/approve') {
    const b = await H.readJson(req);
    const drafts = userDrafts(user);
    const ids = Array.isArray(b.contactIds) ? b.contactIds.map(String) : Object.keys(drafts);
    let n = 0;
    for (const id of ids) {
      const d = drafts[id];
      const c = userContacts(user).find((x) => x.id === id);
      if (d && c && c.status === 'drafted' && d.subject && d.body.trim()) {
        d.approved = b.approved !== false;
        n++;
      }
    }
    db.save();
    return H.sendJson(res, 200, { updated: n });
  }

  // ---- sending
  if (m === 'POST' && p === '/api/send/test') {
    H.rateLimit(`test:${user.id}`, 15, 3600_000);
    if (!user.gmail) throw new HttpError(400, 'Connect your Gmail first');
    const b = await H.readJson(req);
    const c = userContacts(user).find((x) => x.id === String(b.contactId));
    const d = c && userDrafts(user)[c.id];
    if (!d) throw new HttpError(404, 'Draft not found');
    try {
      const r = await mailer.sendDraft(user, c, d, { to: user.gmail.email, toName: user.profile.fullName, subjectPrefix: '[TEST] ' });
      mailer.log(user.id, { contactId: c.id, email: user.gmail.email, name: 'Test to yourself', subject: d.subject, status: 'sent', test: true, simulated: !!r.simulated });
      db.save();
      return H.sendJson(res, 200, { ok: true, to: user.gmail.email, simulated: !!r.simulated });
    } catch (e) {
      throw new HttpError(e.code === 'not_connected' ? 400 : 502, `Send failed: ${e.message}`);
    }
  }

  if (m === 'POST' && p === '/api/send') {
    if (!user.gmail) throw new HttpError(400, 'Connect your Gmail first (Profile tab)');
    const b = await H.readJson(req);
    const drafts = userDrafts(user);
    const list = userContacts(user);
    const ids = (Array.isArray(b.contactIds) ? b.contactIds.map(String) : Object.keys(drafts)).filter((id) => {
      const c = list.find((x) => x.id === id);
      return c && drafts[id]?.approved && c.status === 'drafted';
    });
    if (!ids.length) throw new HttpError(400, 'No approved drafts to send. Review and approve drafts first.');
    if (ids.length > 500) throw new HttpError(400, 'Send at most 500 at a time');
    for (const id of ids) list.find((x) => x.id === id).status = 'queued';
    const jobs = mailer.enqueue(user.id, ids);
    return H.sendJson(res, 200, { queued: jobs.length, firstAt: jobs[0].scheduledAt, lastAt: jobs[jobs.length - 1].scheduledAt });
  }

  if (m === 'POST' && p === '/api/queue/cancel') {
    mailer.cancelUserQueue(user.id);
    return H.sendJson(res, 200, { ok: true });
  }

  if (m === 'GET' && p === '/api/activity') {
    const contacts = userContacts(user);
    const pending = db.data.queue
      .filter((j) => j.userId === user.id)
      .sort((a, b) => a.scheduledAt - b.scheduledAt)
      .map((j) => {
        const c = contacts.find((x) => x.id === j.contactId);
        return { contactId: j.contactId, name: c?.name, email: c?.email, scheduledAt: j.scheduledAt, attempts: j.attempts };
      });
    return H.sendJson(res, 200, {
      pending,
      sentLast24h: mailer.recentSends(user.id).length,
      dailyLimit: config.send.dailyLimit,
      log: (db.data.sendLog[user.id] || []).slice(-200).reverse(),
    });
  }

  // ---- security: sign out everywhere
  if (m === 'POST' && p === '/api/sessions/revoke-all') {
    for (const [k, s] of Object.entries(db.data.sessions)) if (s.userId === user.id) delete db.data.sessions[k];
    db.save();
    H.clearCookie(res, 'sid');
    return H.sendJson(res, 200, { ok: true });
  }

  // ---- gmail + account
  if (m === 'POST' && p === '/api/gmail/disconnect') {
    if (user.gmail?.refreshTokenEnc) await google.revoke(C.decrypt(user.gmail.refreshTokenEnc));
    user.gmail = null;
    mailer.cancelUserQueue(user.id);
    db.save();
    return H.sendJson(res, 200, { user: publicUser(user) });
  }

  if (m === 'POST' && p === '/api/account/delete') {
    const b = await H.readJson(req);
    if (b.confirm !== 'DELETE') throw new HttpError(400, 'Type DELETE to confirm');
    if (user.gmail?.refreshTokenEnc) await google.revoke(C.decrypt(user.gmail.refreshTokenEnc));
    await deleteResumeFile(user);
    for (const col of ['contacts', 'drafts', 'tailored', 'sendLog']) delete db.data[col][user.id];
    db.data.queue = db.data.queue.filter((j) => j.userId !== user.id);
    for (const [k, s] of Object.entries(db.data.sessions)) if (s.userId === user.id) delete db.data.sessions[k];
    delete db.data.users[user.id];
    db.save();
    H.clearCookie(res, 'sid');
    return H.sendJson(res, 200, { ok: true });
  }

  throw new HttpError(404, 'Not found');
}

// ---------------------------------------------------------------- static files
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.csv': 'text/csv; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
const staticFiles = new Map();
(function index(dir, prefix) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) index(full, `${prefix}${e.name}/`);
    else if (MIME[path.extname(e.name)]) staticFiles.set(`/${prefix}${e.name}`, full);
  }
})(config.publicDir, '');

function serveStatic(req, res, p) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
  const file = staticFiles.get(p === '/' ? '/index.html' : p);
  if (!file) throw new HttpError(404, 'Not found');
  let data = fs.readFileSync(file);
  const ext = path.extname(file);
  if (file.endsWith(`${path.sep}index.html`) && config.siteVerification) {
    data = Buffer.from(data.toString('utf8').replace('<meta charset="utf-8">', `<meta charset="utf-8">\n  <meta name="google-site-verification" content="${config.siteVerification}">`));
  }
  const headers = { 'Content-Type': MIME[ext], 'Content-Length': data.length, 'Cache-Control': 'no-cache' };
  if (ext === '.csv' || ext === '.xlsx') headers['Content-Disposition'] = H.contentDisposition('attachment', path.basename(file));
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : data);
}

// ---------------------------------------------------------------- server
async function handle(req, res) {
  H.securityHeaders(res);
  let url;
  try {
    url = new URL(req.url, config.baseUrl);
  } catch {
    throw new HttpError(400, 'Bad URL');
  }
  if (url.pathname === '/healthz') return H.sendJson(res, 200, { ok: true, storage: db.isRemote() ? 'upstash' : 'local', version: 6 });
  const ip = H.clientIp(req);
  H.rateLimit(`ip:${ip}`, 600, 60_000);
  if (url.pathname.startsWith('/auth/')) {
    H.rateLimit(`auth:${ip}`, 30, 60_000);
    return authRoutes(req, res, url);
  }
  if (url.pathname.startsWith('/api/')) return api(req, res, url);
  return serveStatic(req, res, url.pathname);
}

async function main() {
  const problems = config.validate();
  if (problems.length) {
    console.error('\nConfiguration problems:\n  - ' + problems.join('\n  - ') + '\n');
    process.exit(1);
  }
  if (!config.google.clientId && !config.devAuth) {
    console.warn('WARNING: GOOGLE_CLIENT_ID/SECRET not set. The site runs, but nobody can sign in until you add them (see README section 2).');
  }
  try {
    await db.init();
  } catch (e) {
    console.error(`\nCould not load data from storage: ${e.message}\nRefusing to start so existing data is not overwritten. Check UPSTASH_REDIS_REST_URL / TOKEN.\n`);
    process.exit(1);
  }
  mailer.startWorker();

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      if (res.headersSent) return res.end();
      H.sendJson(res, status, { error: status === 500 ? 'Something went wrong. Please try again.' : e.message });
    });
  });
  server.headersTimeout = 30_000;
  server.requestTimeout = 120_000;
  server.listen(config.port, () => {
    console.log(`ReachOut running at ${config.baseUrl}`);
    console.log(`AI: per-user keys  |  Storage: ${db.isRemote() ? 'Upstash Redis (persistent)' : 'local file'}  |  Dev login: ${config.devAuth ? 'ON (simulated sends)' : 'off'}`);
  });
  process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e && e.message));
  const shutdown = async () => {
    await Promise.race([db.flush(), new Promise((r) => setTimeout(r, 8000))]);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) main();
module.exports = { handle };
