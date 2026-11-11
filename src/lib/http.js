'use strict';
const config = require('./config');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: https://*.googleusercontent.com",
  "connect-src 'self'",
  "font-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

function securityHeaders(res, { csp = true } = {}) {
  if (csp) res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (config.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* ignore malformed */
    }
  }
  return out;
}

// __Host- prefix forces Secure + Path=/ + no Domain in browsers (only usable over https).
const cookieName = (n) => (config.secure ? `__Host-${n}` : n);

function setCookie(res, name, value, { maxAge, sameSite = 'Lax' } = {}) {
  const parts = [`${cookieName(name)}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', `SameSite=${sameSite}`];
  if (config.secure) parts.push('Secure');
  if (maxAge !== undefined) parts.push(`Max-Age=${Math.floor(maxAge)}`);
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', [...(Array.isArray(prev) ? prev : prev ? [prev] : []), parts.join('; ')]);
}
const clearCookie = (res, name) => setCookie(res, name, '', { maxAge: 0 });
const getCookie = (req, name) => parseCookies(req)[cookieName(name)];

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = parseInt(req.headers['content-length'] || '0', 10);
    if (declared > limit) {
      req.resume();
      return reject(new HttpError(413, `Upload too large (max ${Math.round(limit / 1024 / 1024) || 1} MB)`));
    }
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (c) => {
      if (failed) return;
      size += c.length;
      if (size > limit) {
        failed = true;
        reject(new HttpError(413, 'Request body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => !failed && resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const ct = req.headers['content-type'] || '';
  if (!ct.startsWith('application/json')) throw new HttpError(415, 'Expected application/json');
  const buf = await readBody(req, config.maxJsonBytes);
  if (!buf.length) return {};
  try {
    const v = JSON.parse(buf.toString('utf8'));
    if (v === null || typeof v !== 'object') throw new Error();
    return v;
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

// Minimal multipart/form-data parser (single request, buffered, size-limited).
async function readMultipart(req, limit) {
  const ct = req.headers['content-type'] || '';
  const m = /^multipart\/form-data;.*boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct);
  if (!m) throw new HttpError(415, 'Expected multipart/form-data');
  const buf = await readBody(req, limit);
  const boundary = Buffer.from(`--${m[1] || m[2]}`);
  const fields = {};
  const files = [];
  let pos = buf.indexOf(boundary);
  if (pos < 0) throw new HttpError(400, 'Malformed upload');
  for (;;) {
    pos += boundary.length;
    if (buf[pos] === 0x2d && buf[pos + 1] === 0x2d) break; // closing "--"
    pos += 2; // CRLF
    const next = buf.indexOf(boundary, pos);
    if (next < 0) throw new HttpError(400, 'Malformed upload');
    const part = buf.subarray(pos, next - 2);
    const he = part.indexOf('\r\n\r\n');
    if (he < 0) throw new HttpError(400, 'Malformed upload');
    const headers = part.subarray(0, he).toString('utf8');
    const body = part.subarray(he + 4);
    const disp = /content-disposition:[^\r\n]*/i.exec(headers)?.[0] || '';
    const name = /\bname="([^"]*)"/i.exec(disp)?.[1];
    const filename = /\bfilename="([^"]*)"/i.exec(disp)?.[1];
    const ctype = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim() || 'application/octet-stream';
    if (name !== undefined) {
      if (filename !== undefined) files.push({ field: name, filename, contentType: ctype, data: body });
      else fields[name] = body.toString('utf8');
    }
    pos = next;
  }
  return { fields, files };
}

// In-memory fixed-window rate limiter.
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < now) {
    b = { count: 0, reset: now + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  if (b.count > max) throw new HttpError(429, 'Too many requests. Please slow down.');
}
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k);
}, 60_000).unref();

function clientIp(req) {
  if (config.trustProxy) {
    // Use the RIGHTMOST entry: it is the one our hosting proxy appended. Earlier entries are
    // whatever the client sent and can be faked to dodge rate limits.
    const xf = req.headers['x-forwarded-for'];
    if (xf) {
      const parts = String(xf).split(',').map((p) => p.trim()).filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
    }
  }
  return req.socket.remoteAddress || 'unknown';
}

function isLocalRequest(req) {
  const ip = req.socket.remoteAddress || '';
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip) && !req.headers['x-forwarded-for'];
}

// Content-Disposition with a safe ASCII fallback + RFC 5987 UTF-8 name.
function contentDisposition(type, filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

module.exports = {
  HttpError,
  securityHeaders,
  sendJson,
  redirect,
  setCookie,
  clearCookie,
  getCookie,
  readBody,
  readJson,
  readMultipart,
  rateLimit,
  clientIp,
  isLocalRequest,
  contentDisposition,
};
