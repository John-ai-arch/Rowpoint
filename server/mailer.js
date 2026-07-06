// Email transport.
//  - RESEND_API_KEY set → real delivery via Resend's HTTP API (production).
//  - Otherwise "dev mail" mode: nothing is actually sent; codes are surfaced
//    directly in the UI (auth endpoints include devCode) and mail lands in
//    the email_outbox table for inspection via the dev-only endpoint.
// mailConfigured tells the auth layer which mode we're in.
import { db } from './db.js';
import { config } from './config.js';
import { uuid, now } from './util.js';

export const mailConfigured = () => !!config.resendApiKey;

export function sendEmail(to, subject, body) {
  db.prepare('INSERT INTO email_outbox (id, to_email, subject, body, created_at) VALUES (?,?,?,?,?)')
    .run(uuid(), to, subject, body, now());

  if (config.resendApiKey) {
    // Fire-and-forget: a mail-provider hiccup must never fail the signup
    // request itself; failures are logged as health events for the admin.
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.resendApiKey}` },
      body: JSON.stringify({ from: config.mailFrom, to: [to], subject, text: body }),
      signal: AbortSignal.timeout(10000),
    }).then(async (r) => {
      if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 200)}`);
    }).catch((e) => {
      console.error(`[mail] delivery to ${to} failed:`, e.message);
      try {
        db.prepare('INSERT INTO health_events (id, kind, detail, user_id, created_at) VALUES (?,?,?,?,?)')
          .run(uuid(), 'api_error', `email delivery failed: ${e.message}`.slice(0, 500), null, now());
      } catch { /* never throw from telemetry */ }
    });
  } else {
    console.log(`[mail] (dev mode, not sent) to=${to} subject="${subject}"`);
  }
}
