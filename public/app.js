'use strict';
/* ReachOut frontend — vanilla JS. All user data is rendered with textContent (never innerHTML) to prevent XSS. */

const S = { me: null, csrf: null, cfg: {}, timer: null };
const $ = (sel, root = document) => root.querySelector(sel);

const DOMAINS = [
  'Software Engineer', 'Frontend Developer', 'Backend Developer', 'Full Stack Developer',
  'Data Analyst', 'Data Scientist', 'Machine Learning Engineer', 'AI Research',
  'DevOps / Cloud', 'Cybersecurity', 'Mobile App Developer', 'Product Manager',
  'UI/UX Designer', 'Business Analyst', 'Academic Research',
];

const MESSAGES = {
  oauth_state: 'Sign-in session expired or was invalid. Please try again.',
  oauth_denied: 'Google sign-in was cancelled.',
  oauth_failed: 'Google sign-in failed. Please try again.',
  email_unverified: 'Your Google email address is not verified.',
  signin_required: 'Please sign in first.',
  gmail_scope: 'Gmail permission was not granted. Tick the "Send email on your behalf" box when connecting.',
  no_refresh_token: 'Google did not return offline access. Remove ReachOut from myaccount.google.com/permissions and connect again.',
  google_not_configured: 'Google sign-in is not configured on this server yet (see README).',
  gmail_connected: 'Gmail connected. You can now send emails.',
};

// ---------- tiny DOM helper ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}
// Replace the main area, ignoring empty (null/false) parts.
const setMain = (...kids) => $('#main').replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));
const card = (title, ...kids) => h('section', { class: 'card' }, title ? h('h2', {}, title) : null, ...kids);
const field = (label, input, hint) => h('label', { class: 'field' }, h('span', { class: 'label' }, label), input, hint ? h('small', { class: 'muted' }, hint) : null);
const badge = (text, kind = '') => h('span', { class: `badge ${kind}` }, text);
const fmt = (ts) => (ts ? new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
const fmtIn = (ts) => {
  const s = Math.max(0, Math.round((ts - Date.now()) / 1000));
  if (s < 60) return `in ${s}s`;
  if (s < 3600) return `in ${Math.round(s / 60)} min`;
  return `at ${fmt(ts)}`;
};

// ---------- API ----------
async function api(path, { method = 'GET', body, form } = {}) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (method !== 'GET') opts.headers['X-CSRF-Token'] = S.csrf || '';
  if (form) opts.body = form;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(path, opts);
  const isJson = (r.headers.get('content-type') || '').includes('application/json');
  const data = isJson ? await r.json() : null;
  if (r.status === 401) {
    S.me = null;
    route();
  }
  if (!r.ok) throw new Error((data && data.error) || `Request failed (${r.status})`);
  return data;
}

function toast(msg, kind = 'ok', ms = 4500) {
  const t = h('div', { class: `toast ${kind}` }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), ms);
}

async function withBusy(btn, fn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Working…';
  try {
    return await fn();
  } catch (e) {
    toast(e.message, 'err', 7000);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

// ---------- boot & routing ----------
async function loadMe() {
  const r = await api('/api/me');
  S.me = r.user;
  S.csrf = r.csrfToken;
  S.cfg = r.config;
}

function renderUserbox() {
  const box = $('#userbox');
  box.replaceChildren();
  if (!S.me) return;
  const avatar = S.me.picture && /^https:\/\/[a-z0-9.-]+\.googleusercontent\.com\//.test(S.me.picture)
    ? h('img', { class: 'avatar', src: S.me.picture, alt: '', referrerpolicy: 'no-referrer' })
    : h('span', { class: 'avatar initials' }, (S.me.profile.fullName || S.me.email).slice(0, 1).toUpperCase());
  const gmail = S.me.gmail
    ? badge(S.me.dev ? 'Gmail: simulated' : 'Gmail connected', 'ok')
    : h('a', { class: 'badge warn', href: '#profile' }, 'Gmail not connected');
  box.append(
    gmail,
    avatar,
    h('button', {
      class: 'btn ghost small',
      onclick: async () => {
        try { await api('/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
        location.href = '/';
      },
    }, 'Log out'),
  );
}

function route() {
  clearInterval(S.timer);
  renderUserbox();
  const nav = $('#nav');
  if (!S.me) {
    nav.classList.add('hidden');
    return renderLogin();
  }
  nav.classList.remove('hidden');
  const tab = location.hash.slice(1).split('?')[0];
  const view = VIEWS[tab] ? tab : (S.me.profile.resumeText && S.me.gmail ? 'contacts' : 'start');
  for (const a of nav.querySelectorAll('a')) a.classList.toggle('active', a.dataset.tab === view);
  setMain(h('p', { class: 'muted center' }, 'Loading…'));
  VIEWS[view]().catch((e) => setMain(card('Error', h('p', {}, e.message))));
}

function showBannerFromQuery() {
  const q = new URLSearchParams(location.search);
  const err = q.get('error');
  const ok = q.get('ok');
  if (err) toast(MESSAGES[err] || 'Something went wrong.', 'err', 9000);
  if (ok) toast(MESSAGES[ok] || 'Done.', 'ok');
  if (err || ok) history.replaceState(null, '', `/${location.hash}`);
  if (S.cfg.devAuth) {
    const b = $('#banner');
    b.textContent = 'Dev mode: emails are simulated and never actually sent. Set DEV_FAKE_AUTH=0 for real use.';
    b.classList.remove('hidden');
  }
}

// ---------- login ----------
function renderLogin() {
  const main = $('#main');
  const actions = h('div', { class: 'stack' });
  if (S.cfg.googleConfigured) {
    actions.append(h('a', { class: 'btn primary big', href: '/auth/google/login' }, h('span', { class: 'g' }, 'G'), ' Continue with Google'));
  } else {
    actions.append(h('p', { class: 'muted' }, 'Google sign-in is not configured yet. See README → "Google Cloud setup".'));
  }
  if (S.cfg.devAuth) {
    actions.append(h('form', { method: 'post', action: '/auth/dev-login' }, h('button', { class: 'btn ghost', type: 'submit' }, 'Dev login (local testing)')));
  }
  setMain(
    h('div', { class: 'hero' },
      h('h1', {}, 'Tailored resumes. Personal emails. Sent from your own Gmail.'),
      h('p', { class: 'lead' }, 'Upload your resume and a sheet of professors or HR contacts. ReachOut tailors your resume for each domain, drafts a personal email for every contact, lets you review everything, then sends gradually so you stay out of spam.'),
      h('ol', { class: 'steps' },
        h('li', {}, 'Continue with Google: one click, no passwords'),
        h('li', {}, 'Upload your resume. We fill in your profile'),
        h('li', {}, 'Upload your contacts sheet'),
        h('li', {}, 'Review the drafts and send')),
      actions,
      h('p', { class: 'fine' }, 'ReachOut only asks for permission to send email. It can never read your inbox. You can disconnect or delete all your data at any time. ',
        h('a', { href: '/privacy.html' }, 'Privacy Policy'), ' · ', h('a', { href: '/terms.html' }, 'Terms'))),
  );
}

// ---------- profile ----------
function checklist() {
  const me = S.me;
  const items = [
    ['Profile details', !!me.profile.fullName && !!me.profile.headline, '#profile'],
    ['Target domains', me.profile.domains.length > 0, '#profile'],
    ['Resume', !!me.profile.resumeText.trim(), '#resume'],
    ['Contacts', (S.contactCount || 0) > 0, '#contacts'],
    ['Gmail connected', !!me.gmail, '#profile'],
    ['AI connected', !!me.ai.active, '#profile'],
  ];
  return h('div', { class: 'checklist' }, items.map(([t, done, href]) => h('a', { href, class: done ? 'done' : '' }, h('span', { class: 'tick' }, done ? '✓' : ''), t)));
}

async function saveProfile(patch) {
  const r = await api('/api/profile', { method: 'PUT', body: { ...S.me.profile, ...patch } });
  S.me = r.user;
  renderUserbox();
  return r;
}

async function viewProfile() {
  try {
    S.contactCount = (await api('/api/contacts')).contacts.length;
  } catch { /* ignore */ }
  const p = S.me.profile;
  const inp = (name, attrs = {}) => h('input', { name, value: p[name] || '', ...attrs });

  const details = h('form', { class: 'grid2', id: 'pform' },
    field('Full name *', inp('fullName', { required: true, maxlength: 100, autocomplete: 'name' })),
    field('Headline', inp('headline', { maxlength: 160, placeholder: 'B.Tech CSE 2027 · Python, SQL, ML' })),
    field('Phone', inp('phone', { maxlength: 40, autocomplete: 'tel' })),
    field('Location', inp('location', { maxlength: 100, placeholder: 'Ludhiana, India' })),
    field('LinkedIn', inp('linkedin', { maxlength: 200, placeholder: 'https://linkedin.com/in/…', type: 'url' })),
    field('GitHub', inp('github', { maxlength: 200, placeholder: 'https://github.com/…', type: 'url' })),
    field('Portfolio', inp('portfolio', { maxlength: 200, placeholder: 'https://…', type: 'url' })),
  );

  const selected = new Set(p.domains);
  const all = [...new Set([...DOMAINS, ...p.domains])];
  const chips = h('div', { class: 'chips' });
  const drawChips = () => {
    chips.replaceChildren(...all.map((d) => h('button', {
      type: 'button',
      class: `chip ${selected.has(d) ? 'on' : ''}`,
      onclick: () => { selected.has(d) ? selected.delete(d) : selected.add(d); drawChips(); },
    }, d)));
  };
  drawChips();
  const custom = h('input', { placeholder: 'Add your own domain, e.g. Embedded Systems', maxlength: 60 });
  const addCustom = () => {
    const v = custom.value.trim();
    if (!v) return;
    if (!all.includes(v)) all.push(v);
    selected.add(v);
    custom.value = '';
    drawChips();
  };
  custom.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addCustom(); } });

  const signature = h('textarea', { rows: 4, maxlength: 600, placeholder: 'Leave empty to auto-generate from your profile' }, p.signature || '');
  const attachMode = h('select', {},
    h('option', { value: 'tailored' }, 'Tailored resume PDF for each domain (recommended)'),
    h('option', { value: 'original' }, 'My original uploaded resume file'),
    h('option', { value: 'none' }, 'No attachment'));
  attachMode.value = p.attachMode || 'tailored';
  const optOut = h('input', { type: 'checkbox', checked: p.includeOptOut !== false });

  const save = h('button', { class: 'btn primary', type: 'button' }, 'Save profile');
  save.addEventListener('click', () => withBusy(save, async () => {
    const f = new FormData(details);
    await saveProfile({
      ...Object.fromEntries(f.entries()),
      domains: [...selected],
      signature: signature.value,
      attachMode: attachMode.value,
      includeOptOut: optOut.checked,
    });
    toast('Profile saved');
    route();
  }));

  const gmailCard = card('Gmail connection',
    S.me.gmail
      ? h('div', {},
        h('p', {}, 'Sending from ', h('strong', {}, S.me.gmail.email), S.me.dev ? ' (simulated in dev mode)' : '', '. Connected ', fmt(S.me.gmail.connectedAt), '.'),
        h('button', {
          class: 'btn ghost',
          onclick: (e) => withBusy(e.target, async () => {
            if (!confirm('Disconnect Gmail? Queued emails will be cancelled.')) return;
            S.me = (await api('/api/gmail/disconnect', { method: 'POST' })).user;
            toast('Gmail disconnected');
            route();
          }),
        }, 'Disconnect Gmail'))
      : h('div', {},
        h('p', {}, 'Connect the Gmail account you want to send from. ReachOut asks only for the ', h('em', {}, 'send email'), ' permission. It cannot read, delete or search your mail.'),
        h('a', { class: 'btn primary', href: '/auth/google/gmail' }, 'Connect Gmail')),
  );

  const aiCard = renderAiCard();

  const sessionsCard = card('Security',
    h('p', { class: 'muted' }, 'Signed in somewhere you no longer use, or lost a device? Sign out everywhere. You are also signed out automatically after 3 days of inactivity.'),
    h('button', {
      class: 'btn ghost',
      onclick: (e) => withBusy(e.target, async () => {
        if (!confirm('Sign out of ReachOut on all devices, including this one?')) return;
        await api('/api/sessions/revoke-all', { method: 'POST' });
        location.href = '/';
      }),
    }, 'Sign out of all devices'));

  const danger = card('Delete account',
    h('p', { class: 'muted' }, 'Permanently deletes your profile, resume, contacts, drafts and logs, and revokes Gmail access.'),
    h('button', {
      class: 'btn danger',
      onclick: (e) => withBusy(e.target, async () => {
        const v = prompt('Type DELETE to permanently delete your account and all data.');
        if (v !== 'DELETE') return;
        await api('/api/account/delete', { method: 'POST', body: { confirm: 'DELETE' } });
        location.href = '/';
      }),
    }, 'Delete my account'));

  setMain(
    checklist(),
    card('Your details', details),
    card('Target domains', h('p', { class: 'muted' }, 'Pick every domain you are applying for. A tailored resume is generated for each.'), chips,
      h('div', { class: 'row' }, custom, h('button', { class: 'btn ghost', type: 'button', onclick: addCustom }, 'Add'))),
    card('Email settings',
      field('Signature', signature, 'Added below every email.'),
      field('Attachment', attachMode),
      h('label', { class: 'check' }, optOut, ' Add a polite opt-out line ("reply and I won\'t email again") — recommended')),
    h('div', { class: 'savebar' }, save),
    gmailCard,
    aiCard,
    sessionsCard,
    danger,
  );
}

// ---------- shared: generate drafts in batches ----------
async function generateDrafts(ids, btn) {
  let ok = 0;
  const errs = [];
  for (let i = 0; i < ids.length; i += 5) {
    btn.textContent = `Drafting ${Math.min(i + 5, ids.length)}/${ids.length}…`;
    const r = await api('/api/drafts/generate', { method: 'POST', body: { contactIds: ids.slice(i, i + 5) } });
    for (const x of r.results) x.ok ? ok++ : errs.push(x.error);
  }
  toast(`${ok} draft(s) ready${errs.length ? `, ${errs.length} failed: ${errs[0]}` : ''}`, errs.length ? 'warn' : 'ok', 7000);
  if (ok) location.hash = '#drafts';
  else route();
}

const FIELD_NAMES = { phone: 'phone', linkedin: 'LinkedIn', github: 'GitHub' };
async function uploadResume(fileInput, replace) {
  if (!fileInput.files[0]) throw new Error('Choose your resume file first');
  const fd = new FormData();
  fd.append('file', fileInput.files[0]);
  if (replace) fd.append('replaceText', '1');
  const r = await api('/api/resume', { method: 'POST', form: fd });
  S.me = r.user;
  const filled = (r.autofilled || []).map((k) => FIELD_NAMES[k] || k);
  if (r.extracted) toast(`Resume read successfully${filled.length ? `. Auto-filled your ${filled.join(', ')}` : ''}.`);
  else toast(`Resume uploaded. ${r.note || 'Paste your resume text in the Resume tab.'}`, 'warn', 9000);
  return r;
}

const skipStore = {
  get(k) { try { return localStorage.getItem(`ro_skip_${k}`) === '1'; } catch { return false; } },
  set(k) { try { localStorage.setItem(`ro_skip_${k}`, '1'); } catch { /* ignore */ } },
};

// ---------- get started (guided onboarding) ----------
function setupState() {
  const me = S.me;
  return {
    gmail: !!me.gmail,
    resume: !!me.profile.resumeText.trim(),
    domains: me.profile.domains.length > 0,
    ai: !!me.ai.active || skipStore.get('ai'),
    contacts: (S.contactCount || 0) > 0,
  };
}
const setupDone = () => Object.values(setupState()).every(Boolean);

async function viewStart() {
  S.contactCount = (await api('/api/contacts')).contacts.length;
  const st = setupState();
  const order = ['gmail', 'resume', 'domains', 'ai', 'contacts'];
  const current = order.find((k) => !st[k]);
  const doneCount = order.filter((k) => st[k]).length;

  const step = (key, n, title, sub, body) => h('section', { class: `card step ${st[key] ? 'done' : ''} ${current === key ? 'current' : ''}` },
    h('div', { class: 'stephead' },
      h('span', { class: 'stepnum' }, st[key] ? '✓' : n),
      h('div', {}, h('h2', {}, title), h('p', { class: 'muted small' }, sub))),
    current === key || (!st[key] && key === 'ai') ? body() : null);

  // 1. Gmail
  const gmailBody = () => h('div', {},
    h('p', {}, 'Allow ReachOut to send emails from your Gmail. It can only send, never read your inbox.'),
    h('a', { class: 'btn primary', href: '/auth/google/gmail' }, 'Connect Gmail'));

  // 2. Resume
  const resumeBody = () => {
    const f = h('input', { type: 'file', accept: '.pdf,.docx,.txt' });
    const b = h('button', { class: 'btn primary', type: 'button' }, 'Upload resume');
    b.addEventListener('click', () => withBusy(b, async () => { await uploadResume(f, true); route(); }));
    return h('div', {}, h('div', { class: 'row wrap' }, f, b),
      h('small', { class: 'muted' }, 'PDF, Word or TXT. We read it and fill in your phone, LinkedIn and GitHub automatically. Prefer to paste text? ', h('a', { href: '#resume' }, 'Use the Resume tab'), '.'));
  };

  // 3. Domains (auto-saves)
  const domainsBody = () => {
    const selected = new Set(S.me.profile.domains);
    const chips = h('div', { class: 'chips' });
    const draw = () => chips.replaceChildren(...DOMAINS.map((d) => h('button', {
      type: 'button', class: `chip ${selected.has(d) ? 'on' : ''}`,
      onclick: () => { selected.has(d) ? selected.delete(d) : selected.add(d); draw(); },
    }, d)));
    draw();
    const b = h('button', { class: 'btn primary', type: 'button' }, 'Save domains');
    b.addEventListener('click', () => withBusy(b, async () => {
      if (!selected.size) throw new Error('Pick at least one domain');
      await saveProfile({ domains: [...selected] });
      route();
    }));
    return h('div', {}, h('p', {}, 'What are you applying for? Pick all that apply. You get a tailored resume for each.'), chips, b);
  };

  // 4. AI (optional)
  const aiBody = () => {
    const key = h('input', { type: 'password', placeholder: 'Paste your Gemini API key', autocomplete: 'off', spellcheck: 'false' });
    const b = h('button', { class: 'btn primary', type: 'button' }, 'Connect & test');
    b.addEventListener('click', () => withBusy(b, async () => {
      if (!key.value.trim()) throw new Error('Paste your key first');
      S.me = (await api('/api/ai/keys/gemini', { method: 'PUT', body: { apiKey: key.value } })).user;
      toast('Gemini connected. Your resumes and emails will be AI-tailored.');
      route();
    }));
    const skip = h('button', { class: 'btn ghost', type: 'button', onclick: () => { skipStore.set('ai'); route(); } }, 'Skip, use templates');
    return h('div', {},
      h('ol', { class: 'mini' },
        h('li', {}, 'Open ', h('a', { href: 'https://aistudio.google.com/apikey', target: '_blank', rel: 'noopener noreferrer' }, 'aistudio.google.com/apikey'), ' (signs in with the same Google account).'),
        h('li', {}, 'Click ', h('strong', {}, 'Create API key'), ', then copy it.'),
        h('li', {}, 'Paste it here. It is stored encrypted and only used for your drafts.')),
      h('div', { class: 'row wrap' }, key, b, skip),
      h('small', { class: 'muted' }, 'Prefer ChatGPT or Claude? Add them in ', h('a', { href: '#profile' }, 'Profile → AI assistant'), '.'));
  };

  // 5. Contacts
  const contactsBody = () => {
    const f = h('input', { type: 'file', accept: '.xlsx,.csv' });
    const b = h('button', { class: 'btn primary', type: 'button' }, 'Upload contacts');
    b.addEventListener('click', () => withBusy(b, async () => {
      if (!f.files[0]) throw new Error('Choose your .xlsx or .csv file first');
      const fd = new FormData();
      fd.append('file', f.files[0]);
      const r = await api('/api/contacts/upload', { method: 'POST', form: fd });
      toast(`${r.added} contacts added${r.errors.length ? `, ${r.errors.length} rows skipped` : ''}`);
      route();
    }));
    return h('div', {},
      h('p', {}, 'A sheet with Name, Email, Type (Professor/HR), Organization, Domain, Description. ',
        h('a', { href: '/contacts_template.xlsx' }, 'Download the Excel template'), '.'),
      h('div', { class: 'row wrap' }, f, b));
  };

  let finish = null;
  if (setupDone()) {
    const go = h('button', { class: 'btn primary big', type: 'button' }, `Write emails for all ${S.contactCount} contacts`);
    go.addEventListener('click', () => withBusy(go, async () => {
      const { contacts } = await api('/api/contacts');
      const ids = contacts.filter((c) => c.status === 'new').map((c) => c.id);
      if (!ids.length) { location.hash = '#drafts'; return; }
      await generateDrafts(ids, go);
    }));
    finish = h('section', { class: 'card finish' },
      h('h2', {}, "You're all set 🎉"),
      h('p', {}, 'Next: we write a personal email and a tailored resume for every contact. You review and approve each one before anything is sent.'),
      go);
  }

  setMain(...[
    h('div', { class: 'progresshead' },
      h('h1', {}, `Welcome${S.me.profile.fullName ? `, ${S.me.profile.fullName.split(' ')[0]}` : ''}!`),
      h('p', { class: 'muted' }, `${doneCount} of 5 steps done. Takes about 3 minutes.`),
      h('div', { class: 'bar' }, h('span', { style: null, class: `fill w${doneCount}` }))),
    finish,
    step('gmail', 1, 'Connect your Gmail', st.gmail ? `Sending from ${S.me.gmail.email}` : 'So emails go out from your own address', gmailBody),
    step('resume', 2, 'Upload your resume', st.resume ? 'Resume added' : 'We read it and fill in your profile', resumeBody),
    step('domains', 3, 'Pick your domains', st.domains ? S.me.profile.domains.join(', ') : 'Software Engineer, Data Analyst, …', domainsBody),
    step('ai', 4, 'Connect AI (optional, free)', S.me.ai.active ? `Using ${S.cfg.aiProviders[S.me.ai.active].label}` : skipStore.get('ai') ? 'Skipped. Using templates.' : 'Free Gemini key, 1 minute', aiBody),
    step('contacts', 5, 'Upload contacts', st.contacts ? `${S.contactCount} contacts` : 'Professors and HRs to email', contactsBody),
  ].filter(Boolean));
}

// ---------- AI keys (per user) ----------
function renderAiCard() {
  const P = S.cfg.aiProviders;
  const mine = S.me.ai;
  const rows = Object.entries(P).map(([id, info]) => {
    const k = mine.keys[id];
    const keyIn = h('input', { type: 'password', placeholder: k ? `Saved key ending ••••${k.last4} (paste to replace)` : 'Paste your API key', autocomplete: 'off', spellcheck: 'false' });
    const modelIn = h('input', { value: k ? k.model : info.defaultModel, maxlength: 80, spellcheck: 'false' });
    const save = h('button', { class: 'btn primary small', type: 'button' }, k ? 'Update & test' : 'Connect & test');
    save.addEventListener('click', () => withBusy(save, async () => {
      const r = await api(`/api/ai/keys/${id}`, { method: 'PUT', body: { apiKey: keyIn.value, model: modelIn.value } });
      keyIn.value = '';
      S.me = r.user;
      toast(`${info.label} connected and working. It is now your active AI.`);
      route();
    }));
    const remove = k ? h('button', {
      class: 'btn ghost small', type: 'button',
      onclick: (e) => withBusy(e.target, async () => {
        if (!confirm(`Remove your ${info.label} key?`)) return;
        S.me = (await api(`/api/ai/keys/${id}`, { method: 'DELETE' })).user;
        route();
      }),
    }, 'Remove') : null;
    const use = k && mine.active !== id ? h('button', {
      class: 'btn ghost small', type: 'button',
      onclick: (e) => withBusy(e.target, async () => {
        S.me = (await api('/api/ai/active', { method: 'PUT', body: { provider: id } })).user;
        toast(`Now using ${info.label}`);
        route();
      }),
    }, 'Use this') : null;
    return h('details', { class: 'aiprov', open: (mine.active === id || (!mine.active && id === 'gemini')) || null },
      h('summary', {},
        h('strong', {}, info.label), ' ',
        info.free ? badge('free tier', 'ok') : badge('paid'), ' ',
        mine.active === id ? badge('active', 'info') : k ? badge('connected') : null),
      h('div', { class: 'grid2' },
        field('API key', keyIn, h('span', {}, 'Get one at ', h('a', { href: info.keyUrl, target: '_blank', rel: 'noopener noreferrer' }, info.keyUrl.replace('https://', '')))),
        field('Model', modelIn, `Default: ${info.defaultModel}`)),
      h('div', { class: 'row' }, save, use, remove));
  });
  return card('AI assistant (your own key)',
    h('p', { class: 'muted' }, 'Connect your own AI key. It is used only for your resumes and emails, stored encrypted, and never shown again after saving. Usage counts against your own free tier or credits. No key? The app still works with simple templates.'),
    ...rows);
}

// ---------- resume ----------
async function viewResume() {
  const p = S.me.profile;
  const { tailored } = await api('/api/tailored');
  const byDomain = Object.fromEntries(tailored.map((t) => [t.domain.toLowerCase(), t]));

  const file = h('input', { type: 'file', accept: '.pdf,.docx,.txt' });
  const replace = h('input', { type: 'checkbox' });
  const upBtn = h('button', { class: 'btn primary', type: 'button' }, 'Upload');
  upBtn.addEventListener('click', () => withBusy(upBtn, async () => {
    if (!file.files[0]) throw new Error('Choose a file first');
    const fd = new FormData();
    fd.append('file', file.files[0]);
    if (replace.checked) fd.append('replaceText', '1');
    const r = await api('/api/resume', { method: 'POST', form: fd });
    S.me = r.user;
    if (r.extracted) toast(replace.checked || !S.me.profile.resumeText ? 'Resume uploaded and text extracted. Check it below.' : 'Resume uploaded. Tick "Replace my resume text" to use the text from this file.');
    else toast(`Resume uploaded. ${r.note || 'Paste your resume text below.'}`, 'warn', 9000);
    route();
  }));

  const current = S.me.resumeFile
    ? h('div', { class: 'filebox' },
      h('span', {}, '📄 ', h('strong', {}, S.me.resumeFile.originalName), ` · ${Math.round(S.me.resumeFile.size / 1024)} KB · ${fmt(S.me.resumeFile.uploadedAt)}`),
      h('a', { class: 'btn ghost small', href: '/api/resume/file', target: '_blank', rel: 'noopener' }, 'Open'),
      h('button', {
        class: 'btn ghost small',
        onclick: (e) => withBusy(e.target, async () => {
          S.me = (await api('/api/resume', { method: 'DELETE' })).user;
          route();
        }),
      }, 'Remove'))
    : h('p', { class: 'muted' }, 'No file uploaded yet.');

  const text = h('textarea', { rows: 18, class: 'mono', maxlength: 20000, placeholder: 'Paste your full resume here: summary, skills, experience, projects, education, achievements…' }, p.resumeText || '');
  const saveText = h('button', { class: 'btn primary', type: 'button' }, 'Save resume text');
  saveText.addEventListener('click', () => withBusy(saveText, async () => {
    await saveProfile({ resumeText: text.value });
    toast('Resume text saved. Tailored versions will refresh when regenerated.');
    route();
  }));

  const rows = p.domains.length
    ? p.domains.map((d) => {
      const t = byDomain[d.toLowerCase()];
      const status = !t ? badge('Not generated') : t.stale ? badge('Out of date', 'warn') : badge(`Ready · ${fmt(t.generatedAt)}`, 'ok');
      const gen = h('button', { class: 'btn ghost small', type: 'button' }, t ? 'Regenerate' : 'Generate');
      gen.addEventListener('click', () => withBusy(gen, async () => {
        await api('/api/tailored', { method: 'POST', body: { domain: d, force: true } });
        toast(`Tailored resume for ${d} ready`);
        route();
      }));
      return h('div', { class: 'trow' },
        h('div', {}, h('strong', {}, d), ' ', status,
          t && t.keywordsMatched.length ? h('div', { class: 'muted small' }, 'Highlights: ', t.keywordsMatched.slice(0, 8).join(', ')) : null),
        h('div', { class: 'row' }, gen,
          h('a', { class: 'btn ghost small', href: `/api/tailored/pdf?domain=${encodeURIComponent(d)}`, target: '_blank', rel: 'noopener' }, 'Preview PDF')));
    })
    : [h('p', { class: 'muted' }, 'Pick your target domains in the Profile tab first.')];

  setMain(
    card('Resume file', current,
      h('div', { class: 'row wrap' }, file, upBtn),
      h('label', { class: 'check' }, replace, ' Replace my current resume text with the text from this file'),
      h('small', { class: 'muted' }, 'PDF, DOCX or TXT, max 5 MB. Stored encrypted. Text is extracted automatically, so review it below (scanned/image PDFs have no text).')),
    card('Resume text (used for tailoring)', text,
      h('p', { class: 'muted small' }, 'The AI only reorders, rephrases and highlights what is written here. It is instructed never to invent skills or experience.'),
      h('div', { class: 'savebar' }, saveText)),
    card('Tailored resumes by domain',
      h('p', { class: 'muted' }, S.me.ai.active
        ? `AI tailoring is on, using your ${S.cfg.aiProviders[S.me.ai.active].label} key.`
        : ['No AI connected, so your resume text is formatted into a clean PDF without tailoring. ', h('a', { href: '#profile' }, 'Connect your free Gemini key'), ' for real tailoring.']),
      ...rows),
  );
}

// ---------- contacts ----------
async function viewContacts() {
  const { contacts } = await api('/api/contacts');
  S.contactCount = contacts.length;
  const sel = new Set();

  const file = h('input', { type: 'file', accept: '.xlsx,.csv' });
  const result = h('div');
  const up = h('button', { class: 'btn primary', type: 'button' }, 'Upload contacts');
  up.addEventListener('click', () => withBusy(up, async () => {
    if (!file.files[0]) throw new Error('Choose an .xlsx or .csv file first');
    const fd = new FormData();
    fd.append('file', file.files[0]);
    const r = await api('/api/contacts/upload', { method: 'POST', form: fd });
    toast(`${r.added} added, ${r.updated} updated, ${r.skipped} skipped`);
    if (r.errors.length) {
      sessionStorage.setItem('ro_upload_errors', JSON.stringify(r.errors));
    }
    route();
  }));
  try {
    const errs = JSON.parse(sessionStorage.getItem('ro_upload_errors') || '[]');
    sessionStorage.removeItem('ro_upload_errors');
    if (errs.length) result.append(h('div', { class: 'alert warn' }, h('strong', {}, 'Some rows were skipped:'), h('ul', {}, errs.map((e) => h('li', {}, e)))));
  } catch { /* ignore */ }

  // manual add
  const mf = h('form', { class: 'grid2' },
    field('Name', h('input', { name: 'name', maxlength: 120 })),
    field('Email *', h('input', { name: 'email', type: 'email', required: true })),
    field('Type', h('select', { name: 'type' }, h('option', {}, 'Professor'), h('option', {}, 'HR'), h('option', {}, 'Other'))),
    field('Organization', h('input', { name: 'organization', maxlength: 160 })),
    field('Domain', h('input', { name: 'domain', maxlength: 80, list: 'domlist' })),
    field('Role / position', h('input', { name: 'role', maxlength: 120 })),
    field('Description', h('textarea', { name: 'description', rows: 2, maxlength: 1500, placeholder: 'Research area, team, what they are hiring for…' })),
    h('datalist', { id: 'domlist' }, [...new Set([...S.me.profile.domains, ...DOMAINS])].map((d) => h('option', { value: d }))));
  const addBtn = h('button', { class: 'btn ghost', type: 'button' }, 'Add contact');
  addBtn.addEventListener('click', () => withBusy(addBtn, async () => {
    await api('/api/contacts', { method: 'POST', body: Object.fromEntries(new FormData(mf).entries()) });
    toast('Contact added');
    route();
  }));

  // table
  const counter = h('span', { class: 'muted' });
  const genBtn = h('button', { class: 'btn primary', type: 'button' }, 'Generate drafts');
  const delBtn = h('button', { class: 'btn ghost', type: 'button' }, 'Delete selected');
  const updateBar = () => {
    counter.textContent = `${sel.size} selected`;
    genBtn.disabled = delBtn.disabled = sel.size === 0;
  };
  const statusKind = { new: '', drafted: 'info', queued: 'warn', sent: 'ok', failed: 'err' };
  const boxes = [];
  const all = h('input', { type: 'checkbox', 'aria-label': 'Select all' });
  all.addEventListener('change', () => {
    for (const b of boxes) {
      if (b.disabled) continue;
      b.checked = all.checked;
      all.checked ? sel.add(b.dataset.id) : sel.delete(b.dataset.id);
    }
    updateBar();
  });
  const tbody = h('tbody', {}, contacts.map((c) => {
    const cb = h('input', { type: 'checkbox', 'data-id': c.id, disabled: c.status === 'sent' || c.status === 'queued' });
    boxes.push(cb);
    cb.addEventListener('change', () => { cb.checked ? sel.add(c.id) : sel.delete(c.id); updateBar(); });
    return h('tr', {},
      h('td', {}, cb),
      h('td', {}, h('div', { class: 'strong' }, c.name || '—'), h('div', { class: 'muted small' }, c.email)),
      h('td', {}, c.type),
      h('td', {}, c.organization),
      h('td', {}, c.domain || h('span', { class: 'muted' }, S.me.profile.domains[0] || 'General')),
      h('td', { class: 'desc', title: c.description }, c.description.length > 140 ? `${c.description.slice(0, 140)}…` : c.description),
      h('td', {}, badge(c.status, statusKind[c.status]), c.lastError ? h('div', { class: 'err small', title: c.lastError }, c.lastError.slice(0, 60)) : null));
  }));

  genBtn.addEventListener('click', () => withBusy(genBtn, () => generateDrafts([...sel], genBtn)));
  delBtn.addEventListener('click', () => withBusy(delBtn, async () => {
    if (!confirm(`Delete ${sel.size} contact(s) and their drafts?`)) return;
    await api('/api/contacts/delete', { method: 'POST', body: { ids: [...sel] } });
    route();
  }));
  updateBar();

  setMain(
    card('Upload contacts',
      h('p', {}, 'Columns: ', h('code', {}, 'Name, Email, Type, Organization, Domain, Description, Role'), '. Only Email is required. ',
        'Template: ', h('a', { href: '/contacts_template.xlsx' }, 'Excel'), ' · ', h('a', { href: '/contacts_template.csv' }, 'CSV')),
      h('div', { class: 'row wrap' }, file, up),
      h('small', { class: 'muted' }, 'Type: "Professor" or "HR". Description: research area or what they are hiring for — more specific means better emails. Existing emails are updated, not duplicated.'),
      result),
    h('details', { class: 'card' }, h('summary', {}, 'Add a single contact'), mf, h('div', { class: 'savebar' }, addBtn)),
    card(`Contacts (${contacts.length})`,
      contacts.length
        ? h('div', {},
          h('div', { class: 'toolbar' }, counter, h('div', { class: 'row' }, delBtn, genBtn)),
          h('div', { class: 'tablewrap' }, h('table', {},
            h('thead', {}, h('tr', {}, h('th', {}, all), h('th', {}, 'Contact'), h('th', {}, 'Type'), h('th', {}, 'Organization'), h('th', {}, 'Domain'), h('th', {}, 'Description'), h('th', {}, 'Status'))),
            tbody)))
        : h('p', { class: 'muted' }, 'No contacts yet. Upload a sheet above.')),
  );
}

// ---------- drafts ----------
async function viewDrafts() {
  const { drafts } = await api('/api/drafts');
  const main = $('#main');
  const editable = (c) => c.status === 'drafted';
  const approvedCount = drafts.filter((d) => d.draft.approved && editable(d.contact)).length;

  const warn = !S.me.gmail
    ? h('div', { class: 'alert warn' }, 'Gmail is not connected. ', h('a', { href: '#profile' }, 'Connect it in Profile'), ' before sending.')
    : null;

  const sendBtn = h('button', { class: 'btn primary', type: 'button', disabled: !approvedCount || !S.me.gmail }, `Send ${approvedCount} approved`);
  sendBtn.addEventListener('click', () => withBusy(sendBtn, async () => {
    if (!confirm(`Send ${approvedCount} email(s) from ${S.me.gmail.email}?\n\nThey go out gradually (one every ${S.cfg.minDelay}–${S.cfg.maxDelay}s, max ${S.cfg.dailyLimit}/day) to protect your Gmail from spam filters. You can cancel anytime in Activity.`)) return;
    const r = await api('/api/send', { method: 'POST', body: {} });
    toast(`${r.queued} email(s) queued. First one ${fmtIn(r.firstAt)}.`);
    location.hash = '#activity';
  }));
  const approveAll = h('button', { class: 'btn ghost', type: 'button' }, 'Approve all');
  approveAll.addEventListener('click', () => withBusy(approveAll, async () => {
    await api('/api/drafts/approve', { method: 'POST', body: { approved: true } });
    route();
  }));

  const cards = drafts.map(({ contact: c, draft: d }) => {
    const ro = !editable(c);
    const subj = h('input', { value: d.subject, maxlength: 150, disabled: ro });
    const body = h('textarea', { rows: 10, disabled: ro, maxlength: 6000 }, d.body);
    const appr = h('input', { type: 'checkbox', checked: d.approved, disabled: ro });
    const dirty = () => subj.value !== d.subject || body.value !== d.body;
    const save = async (extra = {}) => {
      const r = await api(`/api/drafts/${c.id}`, { method: 'PUT', body: { subject: subj.value, body: body.value, ...extra } });
      Object.assign(d, r.draft);
      return r;
    };
    const saveBtn = h('button', { class: 'btn ghost small', type: 'button', disabled: ro }, 'Save');
    saveBtn.addEventListener('click', () => withBusy(saveBtn, async () => { await save(); toast('Saved'); }));
    appr.addEventListener('change', async () => {
      try {
        await save({ approved: appr.checked });
        route();
      } catch (e) {
        appr.checked = !appr.checked;
        toast(e.message, 'err');
      }
    });
    const testBtn = h('button', { class: 'btn ghost small', type: 'button', disabled: !S.me.gmail }, 'Send test to me');
    testBtn.addEventListener('click', () => withBusy(testBtn, async () => {
      if (dirty()) await save();
      const r = await api('/api/send/test', { method: 'POST', body: { contactId: c.id } });
      toast(r.simulated ? 'Test simulated (dev mode)' : `Test sent to ${r.to}. Check your inbox.`);
    }));
    const regen = h('button', { class: 'btn ghost small', type: 'button', disabled: ro }, 'Regenerate');
    regen.addEventListener('click', () => withBusy(regen, async () => {
      if (!confirm('Replace this draft with a new one?')) return;
      const r = await api('/api/drafts/generate', { method: 'POST', body: { contactIds: [c.id] } });
      if (!r.results[0]?.ok) throw new Error(r.results[0]?.error || 'Failed');
      route();
    }));
    const attach = S.me.profile.attachMode === 'none'
      ? h('span', { class: 'muted small' }, 'No attachment')
      : S.me.profile.attachMode === 'original' && S.me.resumeFile
        ? h('span', { class: 'small' }, '📎 ', S.me.resumeFile.originalName)
        : h('a', { class: 'small', href: `/api/tailored/pdf?domain=${encodeURIComponent(d.domain)}`, target: '_blank', rel: 'noopener' }, `📎 Resume tailored for ${d.domain}`);
    return h('article', { class: `card draft ${d.approved ? 'approved' : ''}` },
      h('div', { class: 'drafthead' },
        h('div', {}, h('strong', {}, c.name || c.email), ' ', h('span', { class: 'muted' }, `<${c.email}>`),
          h('div', { class: 'muted small' }, [c.type, c.organization, c.role].filter(Boolean).join(' · '))),
        h('div', {}, badge(d.domain, 'info'), ' ', badge(c.status, c.status === 'sent' ? 'ok' : c.status === 'failed' ? 'err' : ''))),
      c.description ? h('p', { class: 'context small' }, 'Context: ', c.description) : null,
      field('Subject', subj),
      field('Message', body, 'Your signature' + (S.me.profile.includeOptOut ? ' and opt-out line are' : ' is') + ' added automatically.'),
      h('div', { class: 'draftfoot' },
        attach,
        h('div', { class: 'row wrap' }, regen, testBtn, saveBtn,
          h('label', { class: 'check approve' }, appr, ' Approved'))));
  });

  setMain(
    warn,
    h('div', { class: 'card toolbar sticky' },
      h('span', {}, h('strong', {}, `${drafts.length} drafts`), ` · ${approvedCount} approved and ready`),
      h('div', { class: 'row' }, approveAll, sendBtn)),
    ...(drafts.length ? cards : [card(null, h('p', { class: 'muted' }, 'No drafts yet. Go to ', h('a', { href: '#contacts' }, 'Contacts'), ', select people and click "Generate drafts".'))]),
  );
}

// ---------- activity ----------
async function viewActivity() {
  const draw = async () => {
    const a = await api('/api/activity');
    const cancel = h('button', { class: 'btn ghost', type: 'button', disabled: !a.pending.length }, 'Cancel queue');
    cancel.addEventListener('click', () => withBusy(cancel, async () => {
      if (!confirm('Cancel all queued emails? They go back to drafts.')) return;
      await api('/api/queue/cancel', { method: 'POST' });
      draw();
    }));
    setMain(
      h('div', { class: 'stats' },
        h('div', { class: 'stat' }, h('b', {}, a.pending.length), h('span', {}, 'queued')),
        h('div', { class: 'stat' }, h('b', {}, `${a.sentLast24h}/${a.dailyLimit}`), h('span', {}, 'sent in last 24h')),
        h('div', { class: 'stat' }, h('b', {}, a.pending[0] ? fmtIn(a.pending[0].scheduledAt) : '—'), h('span', {}, 'next send'))),
      card('Queue',
        a.pending.length
          ? h('div', {}, h('ul', { class: 'plain' }, a.pending.slice(0, 50).map((j) => h('li', {}, h('span', {}, j.name || j.email, ' ', h('span', { class: 'muted' }, j.email)), h('span', { class: 'muted' }, fmtIn(j.scheduledAt), j.attempts ? ` · retry ${j.attempts}` : '')))), cancel)
          : h('p', { class: 'muted' }, 'Nothing queued.')),
      card('Sent log',
        a.log.length
          ? h('div', { class: 'tablewrap' }, h('table', {},
            h('thead', {}, h('tr', {}, h('th', {}, 'Time'), h('th', {}, 'To'), h('th', {}, 'Subject'), h('th', {}, 'Status'))),
            h('tbody', {}, a.log.map((e) => h('tr', {},
              h('td', { class: 'nowrap' }, fmt(e.at)),
              h('td', {}, e.name || '', h('div', { class: 'muted small' }, e.email)),
              h('td', {}, e.subject),
              h('td', {}, badge(e.test ? 'test' : e.status, e.status === 'sent' ? 'ok' : 'err'), e.simulated ? badge('simulated') : null, e.error ? h('div', { class: 'err small' }, e.error) : null))))))
          : h('p', { class: 'muted' }, 'No emails sent yet.')),
    );
  };
  await draw();
  S.timer = setInterval(() => draw().catch(() => {}), 10_000);
}

const VIEWS = { start: viewStart, profile: viewProfile, resume: viewResume, contacts: viewContacts, drafts: viewDrafts, activity: viewActivity };

(async function boot() {
  try {
    await loadMe();
  } catch (e) {
    setMain(card('Cannot reach server', h('p', {}, e.message)));
    return;
  }
  showBannerFromQuery();
  window.addEventListener('hashchange', route);
  route();
})();
