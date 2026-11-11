'use strict';
// Google OAuth 2.0 (Authorization Code + PKCE) and Gmail send, using fetch only.
const config = require('./config');
const { encrypt, decrypt } = require('./crypto');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

const SCOPES = {
  login: 'openid email profile',
  // gmail.send = can only SEND mail. The app can never read the user's inbox.
  gmail: `openid email ${GMAIL_SEND_SCOPE}`,
};

function authUrl({ purpose, state, challenge, loginHint }) {
  const p = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: config.google.redirectUri,
    response_type: 'code',
    scope: SCOPES[purpose],
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  if (purpose === 'gmail') {
    p.set('access_type', 'offline'); // we need a refresh token for background sending
    p.set('prompt', 'consent');
    p.set('include_granted_scopes', 'true');
  } else {
    p.set('prompt', 'select_account');
  }
  if (loginHint) p.set('login_hint', loginHint);
  return `${AUTH_URL}?${p}`;
}

async function postForm(url, params) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(body.error_description || body.error || `Google error ${r.status}`);
    err.code = body.error;
    err.status = r.status;
    throw err;
  }
  return body;
}

const exchangeCode = (code, verifier) =>
  postForm(TOKEN_URL, {
    code,
    code_verifier: verifier,
    client_id: config.google.clientId,
    client_secret: config.google.clientSecret,
    redirect_uri: config.google.redirectUri,
    grant_type: 'authorization_code',
  });

async function userInfo(accessToken) {
  const r = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error('Could not read Google profile');
  return r.json();
}

function hasGmailScope(tokenResponse) {
  return String(tokenResponse.scope || '').split(/\s+/).includes(GMAIL_SEND_SCOPE);
}

async function revoke(token) {
  try {
    await postForm(REVOKE_URL, { token });
  } catch {
    /* best effort */
  }
}

// Returns a valid access token for the user's connected Gmail, refreshing if needed.
async function getAccessToken(user, save) {
  const g = user.gmail;
  if (!g || !g.refreshTokenEnc) throw Object.assign(new Error('Gmail is not connected'), { code: 'not_connected' });
  if (g.accessTokenEnc && g.accessExpiresAt > Date.now() + 60_000) return decrypt(g.accessTokenEnc);
  try {
    const t = await postForm(TOKEN_URL, {
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      refresh_token: decrypt(g.refreshTokenEnc),
      grant_type: 'refresh_token',
    });
    g.accessTokenEnc = encrypt(t.access_token);
    g.accessExpiresAt = Date.now() + (t.expires_in || 3600) * 1000;
    save();
    return t.access_token;
  } catch (e) {
    if (e.code === 'invalid_grant') {
      user.gmail = null; // token revoked or expired -> user must reconnect
      save();
      throw Object.assign(new Error('Gmail access expired or was revoked. Please reconnect Gmail.'), { code: 'not_connected' });
    }
    throw e;
  }
}

// ---- MIME building (with header-injection protection) ----
const noCrlf = (s) => String(s || '').replace(/[\r\n]+/g, ' ').trim();
function encodeHeader(s) {
  s = noCrlf(s);
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}
function formatAddress(name, email) {
  email = noCrlf(email);
  if (!name) return email;
  const n = noCrlf(name).replace(/["\\]/g, '');
  return /^[\x20-\x7e]*$/.test(n) ? `"${n}" <${email}>` : `${encodeHeader(n)} <${email}>`;
}
const wrap76 = (b64) => b64.replace(/.{1,76}/g, '$&\r\n');

function buildMime({ fromName, fromEmail, to, toName, subject, text, replyTo, attachment }) {
  const boundary = `ro_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const headers = [
    `From: ${formatAddress(fromName, fromEmail)}`,
    `To: ${formatAddress(toName, to)}`,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
  ];
  if (replyTo) headers.push(`Reply-To: ${noCrlf(replyTo)}`);
  const textPart = [
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(Buffer.from(text, 'utf8').toString('base64')),
  ].join('\r\n');

  if (!attachment) {
    return [...headers, textPart].join('\r\n');
  }
  const fname = noCrlf(attachment.filename).replace(/["\\]/g, '_');
  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    textPart,
    `--${boundary}`,
    `Content-Type: ${attachment.mime}; name="${fname}"`,
    `Content-Disposition: attachment; filename="${fname}"`,
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(attachment.data.toString('base64')),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

async function sendMail(accessToken, mail) {
  const raw = Buffer.from(buildMime(mail), 'utf8').toString('base64url');
  const r = await fetch(SEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(body?.error?.message || `Gmail error ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return body; // { id, threadId, labelIds }
}

module.exports = { authUrl, exchangeCode, userInfo, hasGmailScope, revoke, getAccessToken, sendMail, buildMime };
