'use strict';
const crypto = require('crypto');
const config = require('./config');

let keyCache = null;
function key() {
  if (!keyCache) {
    const k = Buffer.from(config.encryptionKeyHex, 'hex');
    if (k.length !== 32) throw new Error('Invalid ENCRYPTION_KEY');
    keyCache = k;
  }
  return keyCache;
}

// AES-256-GCM: authenticated encryption, random 96-bit IV per message.
function encryptBuffer(buf) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([Buffer.from('RO1'), iv, c.getAuthTag(), ct]);
}
function decryptBuffer(blob) {
  if (blob.subarray(0, 3).toString() !== 'RO1') throw new Error('Unknown ciphertext format');
  const iv = blob.subarray(3, 15);
  const tag = blob.subarray(15, 31);
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(blob.subarray(31)), d.final()]);
}
const encrypt = (text) => encryptBuffer(Buffer.from(String(text), 'utf8')).toString('base64');
const decrypt = (b64) => decryptBuffer(Buffer.from(b64, 'base64')).toString('utf8');

const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const randomId = () => crypto.randomBytes(12).toString('hex');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const pkceChallenge = (verifier) => crypto.createHash('sha256').update(verifier).digest('base64url');

module.exports = { encrypt, decrypt, encryptBuffer, decryptBuffer, randomToken, randomId, sha256, safeEqual, pkceChallenge };
