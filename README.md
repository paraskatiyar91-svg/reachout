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

Run the automated end-to-end test (47 checks, including a fake AI provider: auth, CSRF, uploads, PDF/DOCX/XLSX parsing, drafts, queue, deletion):

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

## 3. AI tailoring: each user brings their own key

There is **no server-wide AI key**. Each user connects their own key in **Profile → AI assistant**:

| Provider | Cost | Get a key |
|---|---|---|
| Google Gemini | **Free tier** | <https://aistudio.google.com/apikey> |
| ChatGPT (OpenAI) | Paid credits | <https://platform.openai.com/api-keys> |
| Claude (Anthropic) | Paid credits | <https://console.anthropic.com/settings/keys> |

- Keys are tested before saving, stored encrypted (AES-256-GCM), and never sent back to the browser. Only the last 4 characters are shown.
- A user can connect several and pick which one is active. The model name is editable.
- Each user's AI calls use only their own key, so you, the app owner, pay nothing for AI.
- Without a key, the app uses built-in templates and formats the resume text into a clean PDF.
- The AI is instructed to **only reorder, rephrase and highlight** facts from the resume, never to invent skills or experience. Users review every email before it is sent.

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
| Tokens at rest | Gmail refresh/access tokens and users' AI keys encrypted with **AES-256-GCM** |
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

## 6. Deploy to Render (free)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/paraskatiyar91-svg/reachout)

1. Click the button above and sign in to Render with GitHub.
2. Render reads `render.yaml` and generates `ENCRYPTION_KEY` for you. You can leave the Google keys **empty for now**.
3. Click **Apply**. After about 2 minutes your site is live at `https://reachout-xxxx.onrender.com`. Sign-in shows "not configured" until step 5.
4. Do the Google Cloud setup (section 2) using the redirect URI
   `https://reachout-xxxx.onrender.com/auth/google/callback`.
5. In Render → your service → **Environment**, set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, then save. Render redeploys automatically. (No AI key here: users add their own.)

The app detects its public URL and HTTPS automatically on Render (`RENDER_EXTERNAL_URL`).

**Free-plan limits (demo use):**
- The app **sleeps after ~15 min** with no visitors, and the first visit afterwards takes about 30 s to wake it.
- The free plan has **no persistent disk**, so all users, contacts and drafts are **wiped whenever it restarts or redeploys**.
- Sending runs inside the app, so **keep the Activity tab open while emails are sending**. Its auto-refresh keeps the app awake.

**For real use:** in `render.yaml`, set `plan: starter` and uncomment the `disk` and `DATA_DIR` lines (about $7/month), or move storage to Postgres (`src/lib/db.js` is the only file to change).
Back up `ENCRYPTION_KEY`. If you lose it, stored tokens and resumes cannot be decrypted.

Other hosts (Railway, Fly.io, a VPS) also work. Run it behind HTTPS and set `BASE_URL=https://yourdomain.com` and `TRUST_PROXY=1`.

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
- **Opening to everyone:** while the Google app is in *Testing* mode, only the up-to-100 *test users* you add can sign in. To let anyone sign in, click **Publish app** in Google Cloud and submit verification for the `gmail.send` scope (free). Google asks for the homepage, `/privacy.html` and `/terms.html` (both included) and a short demo video.
- Ideas: reply detection (needs the `gmail.readonly` scope), automatic follow-ups after 5–7 days, an ATS match score per job description, and per-contact resume tweaks.
