# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems.
Report privately via **GitHub → Security → Report a vulnerability**:
<https://github.com/paraskatiyar91-svg/reachout/security/advisories/new>

Include steps to reproduce and the impact. You will get a reply within 7 days.

## How ReachOut protects users

- Google sign-in with OAuth 2.0 + PKCE; Gmail access is **send-only** (`gmail.send`), the inbox is never read.
- Gmail tokens, users' AI keys, resumes and all stored records are encrypted with AES-256-GCM before storage.
- Sessions: random 256-bit tokens, only their SHA-256 hash is stored; HttpOnly, Secure, SameSite cookies;
  3-day idle timeout, 7-day maximum, "sign out of all devices".
- CSRF tokens + Origin checks on every write; strict Content-Security-Policy; no inline scripts.
- Upload limits and file-type checks; zip-bomb and slow-PDF guards; per-IP and per-user rate limits.
- Users can disconnect Gmail (token revoked at Google) and delete their account and all data.

## Scope

In scope: the code in this repository and https://reachout-sj8b.onrender.com.
Out of scope: denial-of-service volume attacks, social engineering, and third-party services (Google, Render, Upstash).
