# ReachOut

Tailor your resume for each domain and send personalised emails to professors and HR contacts **from your own Gmail**: gradually, after you review every draft.

**Flow:** Profile and domains → Resume → Upload contacts (.xlsx/.csv) → AI drafts an email and tailored resume per contact → you review, edit and approve → throttled sending → activity log.

Zero npm dependencies. It runs on Node.js 20+ only (PDF text extraction uses Mozilla pdf.js, bundled in `vendor/pdfjs`, Apache-2.0).

---

## 1. Quick start (local, 2 minutes, no Google setup)

```bash
cd reachout
npm run setup          # creates .env with a random ENCRYPTION_KEY
```

Open `.env` and set `DEV_FAKE_AUTH=1`, then run:

```bash
npm start              # http://localhost:3000
```

Click **Dev login**. Everything works, but emails are **simulated** and nothing is sent. Use this to try the app.

Run the automated end-to-end test (36 checks: auth, CSRF, uploads, PDF/DOCX/XLSX parsing, drafts, queue, deletion):

```bash
npm test
```

---

## 2. Real Gmail: Google Cloud setup (about 10 minutes, free)

1. Go to <https://console.cloud.google.com/> and create a project, e.g. `ReachOut`.
2. **APIs & Services → Library** → search **Gmail API** → **Enable**.
3. **APIs & Services → OAuth consent screen** (called "Google Auth Platform" in newer consoles):
   - User type: **External**
   - App name, support email, developer email
   - **Scopes** → Add: `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`, `https://www.googleapis.com/auth/gmail.send`
   - **Test users / Audience** → add the Gmail addresses that will use the app (yours first)
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**
   - Authorized redirect URI: `http://localhost:3000/auth/google/callback`
     (for production, add `https://yourdomain.com/auth/google/callback`)
5. Copy the **Client ID** and **Client secret** into `.env`:

```env
GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=xxxx
DEV_FAKE_AUTH=0
```

6. Run `npm start`, click **Sign in with Google**, then go to **Profile → Connect Gmail**.

> While the app is in **Testing** mode, Google expires refresh tokens after **7 days**, so you will need to click *Connect Gmail* again weekly. To remove this limit and let anyone sign up, publish the app and complete Google's verification for the `gmail.send` scope (a sensitive scope). This needs a privacy policy, a homepage on your domain, and a short demo video.

---

## 3. AI tailoring (optional but recommended)

Without a key, the app uses solid templates and formats your resume text into a clean PDF.
For real per-domain tailoring and personalised emails, set **one** of these in `.env`:

```env
# Anthropic (Claude)
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-5-5

# or Google Gemini (has a free tier: aistudio.google.com)
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.5-flash
```

The AI is instructed to **only reorder, rephrase and highlight** facts from your resume, never to invent skills or experience. You still review every email before it is sent.

---

## 4. Contacts sheet format

Download the template from the Contacts tab (Excel or CSV). Columns (header names are flexible, and only **Email** is required):

| Name | Email | Type | Organization | Domain | Description | Role |
|---|---|---|---|---|---|---|
| Dr. Anjali Sharma | anjali@iitd.ac.in | Professor | IIT Delhi | Data Scientist | Works on NLP for clinical text | Summer Research Intern |
| Priya Mehta | priya@xyz.com | HR | XYZ Tech | Software Engineer | Hiring backend interns, Java/Spring | SDE Intern |

- **Type** `Professor` / `HR` changes the tone (research interest vs. role fit).
- **Domain** picks which tailored resume is attached. If it is empty, your first profile domain is used.
- **Description** is what makes emails personal. Be specific.
- Re-uploading updates existing contacts by email; it does not create duplicates.

---

## 5. Security

| Area | What's done |
|---|---|
| Sign-in | Google OAuth 2.0 Authorization Code flow with **PKCE** and a `state` parameter bound to a cookie |
| Gmail permission | Only `gmail.send`. The app **cannot read** your inbox |
| Tokens at rest | Gmail refresh/access tokens encrypted with **AES-256-GCM** |
| Resumes at rest | Uploaded files encrypted with AES-256-GCM, random file names, `0600` permissions |
| Sessions | Random 256-bit tokens, only a SHA-256 hash stored server-side, `HttpOnly` + `SameSite=Lax` + `Secure`/`__Host-` on https, rotated on login, 7-day expiry |
| CSRF | Per-session token required on every write, plus an Origin check |
| XSS | Strict CSP (`script-src 'self'`, no inline scripts). The UI renders all data with `textContent`, never `innerHTML` |
| Headers | CSP, HSTS (https), X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy, COOP/CORP |
| Uploads | 5 MB limit, extension + magic-byte checks, zip-bomb guard for .xlsx/.docx |
| Email | Header-injection-safe MIME builder; daily cap + random delays; opt-out line |
| Abuse | Per-IP and per-user rate limits on auth, uploads, AI and sending |
| Privacy | Users can disconnect Gmail (token revoked at Google) or **delete their account and all data** |

**Never commit `.env` or the `data/` folder.** Both are in `.gitignore`.

---

## 6. Deploying (production)

- Run behind **HTTPS** (required for Secure cookies and Google). Render, Railway, Fly.io or a VPS with nginx + Let's Encrypt all work.
- Set `BASE_URL=https://yourdomain.com` and `TRUST_PROXY=1`, and add the https redirect URI in Google Cloud.
- Mount a **persistent disk** for `data/`, or move storage to Postgres. `src/lib/db.js` is the only file to change.
- Back up `ENCRYPTION_KEY`. If you lose it, stored tokens and resumes cannot be decrypted.

---

## 7. Project structure

```
src/server.js        routes: auth, API, static files
src/lib/google.js    OAuth + PKCE, token refresh, Gmail send, MIME builder
src/lib/ai.js        resume + email tailoring (Anthropic / Gemini / templates)
src/lib/mailer.js    attachments, signature, throttled background send queue
src/lib/pdf.js       ATS-friendly resume PDF generator
src/lib/parsers.js   .xlsx / .csv / .docx parsing, contact validation
src/lib/pdftext.js   PDF resume text extraction (pdf.js, line reconstruction)
vendor/pdfjs/        bundled pdf.js build + license
src/lib/crypto.js    AES-256-GCM, tokens, PKCE
src/lib/http.js      security headers, cookies, body/multipart parsing, rate limits
src/lib/db.js        JSON file store (swap for a real DB later)
public/              frontend (vanilla JS, no build step)
scripts/selftest.js  end-to-end test
```

## 8. Known limitations / next steps

- Text is extracted from PDF, DOCX and TXT resumes. **Scanned/image-only PDFs** have no text layer, so paste the text manually (OCR is a possible future addition).
- JSON storage suits one server and hundreds of users. Move to Postgres to scale.
- Ideas: reply detection (needs the `gmail.readonly` scope), automatic follow-ups after 5–7 days, an ATS match score per job description, and per-contact resume tweaks.
