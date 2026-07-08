# Deploying RowPoint — the short version

RowPoint is one Node.js process + one data folder. Any host that runs Node 22
with a persistent disk and HTTPS works. HTTPS is required for Bluetooth
(erg + heart rate monitors) and for installing the app to a phone.

Users need ZERO setup: they open your URL, sign up, verify the code that
arrives in their email, and everything works — including "Add to Home
Screen" to install RowPoint like a native app.

## Non-negotiable: a persistent data directory

**Accounts live in one SQLite file in `ROWPOINT_DATA_DIR`. If that directory
is not on a persistent disk, every redeploy silently deletes every user
account and signs everyone out** — the classic symptom is "I had to create my
account again, and it let me reuse the same email". All three deploy options
below mount a persistent disk; do not skip that step. The server refuses to
suffer this silently: in production it logs a loud error when
`ROWPOINT_DATA_DIR` is unset and a warning when it finds a brand-new database,
and the admin System tab shows the database instance id, creation date, and
boot count so you can verify persistence at a glance (if the instance id
changes between deploys, your disk is not persistent).

Belt-and-braces: also set `ROWPOINT_TOKEN_SECRET` and
`ROWPOINT_RESEARCH_SECRET` to long random strings in your host's environment
variables (the Render blueprint generates them for you). Then sessions and
research pseudonyms survive even a disk migration.

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
   `RESEND_API_KEY=re_…`, plus `ROWPOINT_TOKEN_SECRET` and
   `ROWPOINT_RESEARCH_SECRET` set to long random strings.
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

## Encrypted backups (automatic)

The server takes an **automatic encrypted backup every night** (SQLite
`VACUUM INTO` → AES-256-GCM), keeps the most recent 14, and stores them in
`ROWPOINT_DATA_DIR/backups`. Each backup has a manifest with a SHA-256 and the
user count; a failed backup is logged and surfaced on the admin dashboard.

- **Set `ROWPOINT_BACKUP_KEY`** to a long random string in your host env if you
  copy backups off-box, so a stolen backup can't be decrypted with a key that
  lived on the same disk. (Optional knobs: `ROWPOINT_BACKUP_DIR`,
  `ROWPOINT_BACKUP_INTERVAL_HOURS`, `ROWPOINT_BACKUP_RETENTION`,
  `ROWPOINT_BACKUPS_ENABLED=0` to disable.)
- **Manage from the admin System tab**: back up on demand and verify integrity.
- **Operator CLI** (run in the app dir with the same `ROWPOINT_DATA_DIR`):
  ```bash
  npm run backup            # create one now
  npm run backup:list       # list backups + manifests
  npm run backup:verify <file>   # decrypt + check GCM auth and SHA-256
  npm run backup:restore <file> [dest]   # decrypt to <dest> (default rowpoint.db.restored)
  ```
  To restore: stop the server, `npm run backup:restore <file>`, move the
  resulting file over `rowpoint.db`, and start the server.

## After deploy — 3-minute check

1. Open the URL on your phone → sign up → the code arrives by email → verify.
2. Browser menu → **Add to Home Screen** → RowPoint opens full-screen as an app.
3. Sign in as `lambert.venema2027@gmail.com` (verified) → Admin dashboard appears.
4. Confirm the **System tab → Encrypted backups** panel shows a recent backup
   (and set `ROWPOINT_BACKUP_KEY` so off-box copies stay encrypted).

Optional variables: `ANTHROPIC_API_KEY` (enables the LLM coach — Claude
reasons over each athlete's training history for daily recommendations;
without it a data-driven fallback engine runs), `GOOGLE_CLIENT_ID` (enables
the Google sign-in button — see README), `MAIL_FROM` (your own verified
sender domain in Resend).
