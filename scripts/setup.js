'use strict';
// Creates .env from .env.example with a fresh random ENCRYPTION_KEY.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const envPath = path.join(root, '.env');
const examplePath = path.join(root, '.env.example');

if (fs.existsSync(envPath)) {
  const cur = fs.readFileSync(envPath, 'utf8');
  if (/^ENCRYPTION_KEY=[0-9a-fA-F]{64}\s*$/m.test(cur)) {
    console.log('.env already exists with an ENCRYPTION_KEY. Nothing to do.');
    process.exit(0);
  }
  const updated = cur.replace(/^ENCRYPTION_KEY=.*$/m, `ENCRYPTION_KEY=${crypto.randomBytes(32).toString('hex')}`);
  fs.writeFileSync(envPath, updated, { mode: 0o600 });
  console.log('Added ENCRYPTION_KEY to existing .env');
  process.exit(0);
}

const example = fs.readFileSync(examplePath, 'utf8');
const env = example.replace(/^ENCRYPTION_KEY=.*$/m, `ENCRYPTION_KEY=${crypto.randomBytes(32).toString('hex')}`);
fs.writeFileSync(envPath, env, { mode: 0o600 });
console.log('Created .env with a random ENCRYPTION_KEY.');
console.log('Next: fill GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (see README), optionally an AI key, then `npm start`.');
