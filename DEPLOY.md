# Deploying RowPoint — the short version

RowPoint is one Node.js process + one data folder. Any host that runs Node 22
with a persistent disk and HTTPS works. HTTPS is required for Bluetooth
(erg + heart rate monitors) and for installing the app to a phone.

Users need ZERO setup: they open your URL, sign up, verify the code that
arrives in their email, and everything works — including "Add to Home
Screen" to install RowPoint like a native app.

## The one thing you must configure: email

Verification codes must reach real inboxes. Sign up at **resend.com** (free:
100 emails/day), create an API key, and set it as the `RESEND_API_KEY`
environment variable. Without it the server runs in dev mode and shows codes
on-screen — fine for local testing, wrong for a public site.

## Option A — Railway (~15 min, ~$5/mo)

1. Push this folder to a GitHub repo (`git init && git add . && git commit -m v1`,
   create the repo on github.com, `git remote add origin … && git push -u origin main`).
2. railway.com → New Project → Deploy from GitHub repo.
3. Right-click the service → **Attach Volume**, mount path `/data`.
4. Variables tab: `ROWPOINT_DATA_DIR=/data`, `NODE_ENV=production`,
   `RESEND_API_KEY=re_…`.
5. Settings → Networking → **Generate Domain**. Done — that URL is your app.

## Option B — Render (blueprint, near-zero clicks)

1. Push to GitHub as above.
2. render.com → New + → **Blueprint** → select the repo. Render reads the
   included `render.yaml` and creates the service, the persistent disk, and
   prompts you for `RESEND_API_KEY`. That's the whole setup.

## Option C — Docker on any server

```bash
docker build -t rowpoint .
docker run -d -p 3000:3000 -v rowpoint-data:/data -e RESEND_API_KEY=re_xxx rowpoint
```
Put Caddy or nginx in front for HTTPS (Caddyfile: `yourdomain.com { reverse_proxy localhost:3000 }`).

## After deploy — 3-minute check

1. Open the URL on your phone → sign up → the code arrives by email → verify.
2. Browser menu → **Add to Home Screen** → RowPoint opens full-screen as an app.
3. Sign in as `lambert.venema2027@gmail.com` (verified) → Admin dashboard appears.
4. Back up the SQLite file (`rowpoint.db` in the data dir) on a schedule.

Optional variables: `ANTHROPIC_API_KEY` (nicer AI phrasing), `GOOGLE_CLIENT_ID`
(enables the Google sign-in button — see README), `MAIL_FROM` (your own
verified sender domain in Resend).
