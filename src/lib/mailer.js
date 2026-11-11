'use strict';
// Builds outgoing emails and runs the throttled background send queue.
const fs = require('fs');
const path = require('path');
const db = require('./db');
const config = require('./config');
const google = require('./google');
const ai = require('./ai');
const { renderResume } = require('./pdf');
const { decryptBuffer, sha256, randomId } = require('./crypto');

const DAY = 24 * 3600 * 1000;
const domainKey = (d) => String(d || '').trim().toLowerCase();
const resumeHash = (p) => sha256(`${p.resumeText}\u0000${p.fullName}`);

function contactDomain(user, contact) {
  return contact.domain || user.profile.domains[0] || 'General';
}

// Returns the tailored resume for a domain, generating it if missing or stale.
async function ensureTailored(user, domain, { force = false } = {}) {
  const key = domainKey(domain);
  const store = (db.data.tailored[user.id] ||= {});
  const hash = resumeHash(user.profile);
  const cur = store[key];
  const cfg = ai.userAi(user);
  const tag = ai.aiTag(cfg);
  if (!force && cur && cur.sourceHash === hash && cur.ai === tag) return cur;
  const resume = await ai.tailorResume(user.profile, domain, cfg);
  store[key] = { domain, resume, sourceHash: hash, ai: tag, generatedAt: Date.now() };
  db.save();
  return store[key];
}

function pdfProfile(user) {
  return { ...user.profile, contactEmail: user.gmail?.email || user.email };
}

function signature(user) {
  const p = user.profile;
  if (p.signature && p.signature.trim()) return p.signature.trim();
  const lines = ['Best regards,', p.fullName, p.headline, p.phone, user.gmail?.email || user.email, p.linkedin, p.github].filter(Boolean);
  return lines.join('\n');
}

function composeBody(user, draft) {
  let body = `${draft.body.trim()}\n\n${signature(user)}`;
  if (user.profile.includeOptOut) {
    body += '\n\n--\nIf you would prefer not to hear from me again, just reply and let me know.';
  }
  return body;
}

const safeName = (s) => String(s || '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

async function buildAttachment(user, draft) {
  const mode = user.profile.attachMode || 'tailored';
  if (mode === 'none') return null;
  if (mode === 'original' && user.resumeFile) {
    const blob = fs.readFileSync(path.join(db.uploadsDir, user.resumeFile.storedName));
    return { filename: user.resumeFile.originalName, mime: user.resumeFile.mime, data: decryptBuffer(blob) };
  }
  const t = await ensureTailored(user, draft.domain);
  return {
    filename: `${safeName(user.profile.fullName) || 'Resume'}_Resume_${safeName(draft.domain) || 'General'}.pdf`,
    mime: 'application/pdf',
    data: renderResume(pdfProfile(user), t.resume),
  };
}

async function sendDraft(user, contact, draft, { to, toName, subjectPrefix = '' } = {}) {
  const mail = {
    fromName: user.profile.fullName,
    fromEmail: user.gmail.email,
    to: to || contact.email,
    toName: toName === undefined ? contact.name : toName,
    subject: `${subjectPrefix}${draft.subject}`,
    text: composeBody(user, draft),
    attachment: await buildAttachment(user, draft),
  };
  if (user.dev) {
    // Dev mode: never touches Gmail.
    return { id: `simulated_${randomId()}`, simulated: true };
  }
  const token = await google.getAccessToken(user, db.save);
  return google.sendMail(token, mail);
}

function recentSends(userId) {
  const since = Date.now() - DAY;
  return (db.data.sendLog[userId] || []).filter((e) => e.status === 'sent' && !e.test && e.at > since);
}

function log(userId, entry) {
  const arr = (db.data.sendLog[userId] ||= []);
  arr.push({ at: Date.now(), ...entry });
  if (arr.length > 1000) arr.splice(0, arr.length - 1000);
}

const randDelay = () => (config.send.minDelay + Math.random() * (config.send.maxDelay - config.send.minDelay)) * 1000;

function enqueue(userId, contactIds) {
  const mine = db.data.queue.filter((j) => j.userId === userId);
  let t = Math.max(Date.now() + 3000, ...mine.map((j) => j.scheduledAt + randDelay()));
  const jobs = [];
  for (const contactId of contactIds) {
    jobs.push({ id: randomId(), userId, contactId, scheduledAt: t, attempts: 0 });
    t += randDelay();
  }
  db.data.queue.push(...jobs);
  db.save();
  return jobs;
}

function cancelUserQueue(userId, reason) {
  const contacts = db.data.contacts[userId] || [];
  db.data.queue = db.data.queue.filter((j) => {
    if (j.userId !== userId) return true;
    const c = contacts.find((x) => x.id === j.contactId);
    if (c && c.status === 'queued') {
      c.status = reason ? 'failed' : 'drafted';
      if (reason) c.lastError = reason;
    }
    return false;
  });
  db.save();
}

async function processJob(job) {
  const user = db.data.users[job.userId];
  const contact = user && (db.data.contacts[user.id] || []).find((c) => c.id === job.contactId);
  const draft = contact && db.data.drafts[user.id]?.[contact.id];
  const drop = () => (db.data.queue = db.data.queue.filter((j) => j.id !== job.id));
  if (!user || !contact || !draft || contact.status === 'sent') return drop();

  const recent = recentSends(user.id);
  if (recent.length >= config.send.dailyLimit) {
    // Daily cap reached: push this user's whole queue forward.
    const resumeAt = Math.min(...recent.map((e) => e.at)) + DAY + 60_000;
    const shift = resumeAt - job.scheduledAt;
    for (const j of db.data.queue) if (j.userId === user.id) j.scheduledAt += shift;
    return;
  }
  if (!user.gmail) {
    cancelUserQueue(user.id, 'Gmail not connected');
    return;
  }
  try {
    const res = await sendDraft(user, contact, draft);
    contact.status = 'sent';
    contact.lastSentAt = Date.now();
    delete contact.lastError;
    log(user.id, { contactId: contact.id, email: contact.email, name: contact.name, subject: draft.subject, status: 'sent', messageId: res.id, simulated: !!res.simulated });
    drop();
  } catch (e) {
    if (e.code === 'not_connected') {
      log(user.id, { contactId: contact.id, email: contact.email, name: contact.name, subject: draft.subject, status: 'failed', error: e.message });
      cancelUserQueue(user.id, e.message);
    } else if ((!e.status || e.status === 429 || e.status >= 500) && job.attempts < 3) {
      job.attempts += 1;
      job.scheduledAt = Date.now() + 60_000 * 2 ** job.attempts;
    } else {
      contact.status = 'failed';
      contact.lastError = e.message.slice(0, 300);
      log(user.id, { contactId: contact.id, email: contact.email, name: contact.name, subject: draft.subject, status: 'failed', error: contact.lastError });
      drop();
    }
  }
}

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    const now = Date.now();
    const due = db.data.queue.filter((j) => j.scheduledAt <= now).sort((a, b) => a.scheduledAt - b.scheduledAt);
    const seen = new Set();
    for (const job of due) {
      if (seen.has(job.userId)) continue; // at most one send per user per tick
      seen.add(job.userId);
      await processJob(job);
    }
  } catch (e) {
    console.error('queue error', e);
  } finally {
    db.save();
    running = false;
  }
}

function startWorker() {
  setInterval(tick, 5000).unref();
}

module.exports = {
  domainKey,
  contactDomain,
  ensureTailored,
  pdfProfile,
  composeBody,
  sendDraft,
  recentSends,
  log,
  enqueue,
  cancelUserQueue,
  startWorker,
  tick,
};
