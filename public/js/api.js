// API client. Sessions are carried by an HttpOnly `rp_session` cookie the
// browser sets at login (see server/cookies.js) — the token is deliberately
// NOT kept in localStorage, so there is nothing script-readable for an XSS
// payload to steal. State-changing requests echo the readable `rp_csrf` cookie
// back in an X-CSRF-Token header (stateless double-submit CSRF defence).
//
// `state.token` only ever holds a *legacy* token left by an older build; it is
// used as a Bearer fallback until the server transparently migrates the session
// to a cookie (on the first /auth/me), after which it is cleared. Workout
// history and local caches remain namespaced by user id (§2.5) so account
// switching on a shared device can never leak data between views.
export const state = {
  token: localStorage.getItem('rp_token') || null,
  user: null,
};

export function setSession(token, user) {
  state.token = token; state.user = user;
  // New sessions are cookie-based; never (re)persist a token to localStorage.
  // Clearing on any session change also cleans up a legacy token on logout.
  if (!token) localStorage.removeItem('rp_token');
}

function readCookie(name) {
  const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}

export class ApiFail extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

export async function api(path, { method = 'GET', body, raw = false } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  // Bearer only for grandfathered (pre-cookie) sessions; the cookie carries
  // auth for everyone else and is sent automatically (same-origin).
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  // CSRF double-submit: attach the readable CSRF cookie on mutating requests.
  const m = method.toUpperCase();
  if (m !== 'GET' && m !== 'HEAD') {
    const csrf = readCookie('rp_csrf');
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }
  let r;
  try {
    r = await fetch(`/api${path}`, {
      method, headers, credentials: 'same-origin',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiFail(0, 'offline', 'You appear to be offline. Your data is saved locally and will sync when you reconnect.');
  }
  if (raw) return r;
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiFail(r.status, data.error || 'error', data.message || `Request failed (${r.status})`);
  return data;
}

export async function loadMe() {
  try {
    const res = await api('/auth/me');
    const user = res.user;
    // Hard verification gate: an unverified session (only possible with a
    // legacy token) is discarded entirely — there is no unverified mode.
    if (!user.emailVerified) { setSession(null, null); return null; }
    // The server migrated a legacy Bearer session to a cookie — drop the
    // now-unnecessary (and XSS-stealable) localStorage token.
    if (res.migrated && state.token) { state.token = null; localStorage.removeItem('rp_token'); }
    state.user = user;
    return user;
  } catch (e) {
    if (e.status === 401 || e.status === 403) setSession(null, null);
    return null;
  }
}

/* ---------------- toasts ---------------- */
export function toast(msg, kind = 'info', ms = 4200) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

/* ---------------- units & formatting (§14 consistent unit handling) ---------------- */

export function units() { return state.user?.units || 'metric'; }

export function fmtSplit(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '–:––';
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

export function fmtDuration(totalS) {
  if (!Number.isFinite(totalS)) return '–';
  totalS = Math.round(totalS);
  const h = Math.floor(totalS / 3600), m = Math.floor((totalS % 3600) / 60), s = totalS % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

// Pace is always /500m (the universal erg convention on both unit systems);
// long distances and body weight follow the unit toggle.
export function fmtDistance(m) {
  if (!Number.isFinite(m)) return '–';
  if (units() === 'imperial' && m >= 1609) return `${(m / 1609.344).toFixed(2)} mi`;
  return m >= 10000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

export function fmtWeight(kg) {
  if (!Number.isFinite(kg)) return '–';
  return units() === 'imperial' ? `${Math.round(kg * 2.20462)} lb` : `${Math.round(kg)} kg`;
}

export function fmtDate(unixS) {
  if (!unixS) return '–';
  return new Date(unixS * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
export function fmtDateTime(unixS) {
  if (!unixS) return '–';
  return new Date(unixS * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function uuidv4() {
  return crypto.randomUUID ? crypto.randomUUID() :
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}
