// RowPoint SPA shell: hash router, top bar, tab nav, auth guard.
import { state, loadMe, setSession, api, toast, esc, ApiFail } from './api.js';
import { icon } from './icons.js';
import { startSyncWorker, pendingCount } from './offline.js';
import { t, firstRunNeedsLanguage, setLocale, LOCALES } from './i18n.js';
import { renderAuth } from './pages/auth.js';
import { renderDashboard } from './pages/dashboard.js';
import { renderRow } from './pages/row.js';
import { renderProgress } from './pages/progress.js';
import { renderPlan } from './pages/plan.js';
import { renderLab } from './pages/lab.js';
import { renderTwin } from './pages/twin.js';
import { renderOptimizer } from './pages/optimizer.js';
import { renderRaceLab } from './pages/racelab.js';
import { renderObservatory } from './pages/observatory.js';
import { renderBenchmark } from './pages/benchmark.js';
import { renderStroke } from './pages/stroke.js';
import { renderTimeline } from './pages/timeline.js';
import { renderHistory } from './pages/history.js';
import { renderJournal } from './pages/journal.js';
import { renderWorkoutDetail } from './pages/workoutDetail.js';
import { renderBuilder } from './pages/builder.js';
import { renderTeams } from './pages/teams.js';
import { renderTeamDetail } from './pages/teamDetail.js';
import { renderLive } from './pages/live.js';
import { renderSocial } from './pages/social.js';
import { renderGroup } from './pages/group.js';
import { renderWellness } from './pages/wellness.js';
import { renderSettings } from './pages/settings.js';
import { renderEquipment } from './pages/equipment.js';
import { renderIntegrations } from './pages/integrations.js';
import { renderAdmin } from './pages/admin.js';
import { renderResearchDashboard } from './pages/researchDashboard.js';
import { renderHrm } from './pages/hrm.js';
import { hrManager } from './ble/sensors.js';

const routes = [
  { re: /^\/?$/, page: renderDashboard, tab: 'home' },
  { re: /^\/login/, page: renderAuth, public: true },
  { re: /^\/row/, page: renderRow, tab: 'row' },
  { re: /^\/progress/, page: renderProgress, tab: 'progress' },
  { re: /^\/plan/, page: renderPlan, tab: 'progress' },
  { re: /^\/lab/, page: renderLab, tab: 'progress' },
  { re: /^\/athlete/, page: renderTwin, tab: 'progress' },
  { re: /^\/optimizer/, page: renderOptimizer, tab: 'progress' },
  { re: /^\/racelab/, page: renderRaceLab, tab: 'progress' },
  { re: /^\/observatory/, page: renderObservatory, tab: 'progress' },
  { re: /^\/benchmark/, page: renderBenchmark, tab: 'progress' },
  { re: /^\/stroke/, page: renderStroke, tab: 'row' },
  { re: /^\/timeline/, page: renderTimeline, tab: 'progress' },
  { re: /^\/history$/, page: renderHistory, tab: 'history' },
  { re: /^\/journal/, page: renderJournal, tab: 'history' },
  { re: /^\/workout\/([\w-]+)/, page: renderWorkoutDetail, tab: 'history' },
  { re: /^\/builder/, page: renderBuilder, tab: 'row' },
  { re: /^\/teams$/, page: renderTeams, tab: 'teams' },
  { re: /^\/team\/([\w-]+)/, page: renderTeamDetail, tab: 'teams' },
  { re: /^\/live\/([\w:.-]+)/, page: renderLive, tab: 'teams' },
  { re: /^\/social$/, page: renderSocial, tab: 'social' },
  { re: /^\/group\/([\w-]+)/, page: renderGroup, tab: 'social' },
  { re: /^\/wellness/, page: renderWellness, tab: 'home' },
  { re: /^\/hr/, page: renderHrm, tab: 'hr' },
  { re: /^\/settings/, page: renderSettings, tab: 'home' },
  { re: /^\/equipment/, page: renderEquipment, tab: 'home' },
  { re: /^\/integrations/, page: renderIntegrations, tab: 'home' },
  { re: /^\/admin/, page: renderAdmin, tab: 'home' },
  { re: /^\/research$/, page: renderResearchDashboard, tab: 'home' },
];

let cleanup = null;

/* First-launch language selection — a polished full-screen chooser shown
   before anything else when no language preference is stored yet. */
function renderLanguageScreen() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="lang-screen">
      <div class="brand" style="justify-content:center;font-size:1.7rem;margin-bottom:6px"><span class="dot"></span> RowPoint</div>
      <p class="muted">${esc(t('common.tagline'))}</p>
      <h2 style="margin-top:22px">${esc(t('langScreen.choose'))}</h2>
      <div style="margin-top:14px">
        ${LOCALES.map(l => `
          <button class="lang-opt" data-loc="${l.code}">
            <span class="flag">${l.flag}</span>
            <span>${esc(l.native)}<span class="sub">${esc(t(l.code === 'de' ? 'langScreen.germanSub' : 'langScreen.englishSub'))}</span></span>
          </button>`).join('')}
      </div>
      <p class="muted small mt">${esc(t('langScreen.subtitle'))}</p>
    </div>`;
  app.querySelectorAll('[data-loc]').forEach(b => b.onclick = () => {
    setLocale(b.dataset.loc);
    boot();
  });
}

function shell(contentEl, activeTab) {
  const u = state.user;
  const pending = u ? pendingCount(u.id) : 0;
  const app = document.getElementById('app');
  const tab = (href, id, iconName, label) =>
    `<a href="${href}" class="${activeTab === id ? 'active' : ''}" ${activeTab === id ? 'aria-current="page"' : ''}><span class="ico">${icon(iconName)}</span>${esc(label)}</a>`;
  app.innerHTML = `
    <header class="topbar">
      <a class="brand" href="#/" aria-label="RowPoint home"><span class="dot" aria-hidden="true"></span> RowPoint</a>
      <div class="actions">
        ${pending ? `<span class="badge amber" title="${esc(t('nav.pendingTitle'))}">${esc(t('nav.pending', { n: pending }))}</span>` : ''}
        ${u ? `<button class="ghost sm icon-btn" id="notifBtn" aria-label="${esc(t('nav.notifications'))}">${icon('bell', { size: 20 })}<span id="notifCount"></span></button>` : ''}
        ${u ? `<a href="#/settings" class="btn ghost sm icon-btn" aria-label="${esc(t('nav.settings'))}">${icon('gear', { size: 20 })}</a>` : ''}
      </div>
    </header>
    <main id="page"></main>
    ${u ? `
    <nav class="tabs" aria-label="Main">
      ${tab('#/', 'home', 'home', t('nav.home'))}
      ${tab('#/row', 'row', 'oar', t('nav.row'))}
      ${tab('#/progress', 'progress', 'progress', t('nav.progress'))}
      ${tab('#/hr', 'hr', 'heart', t('nav.heart'))}
      ${tab('#/history', 'history', 'history', t('nav.history'))}
      ${tab('#/teams', 'teams', 'flag', t('nav.teams'))}
      ${tab('#/social', 'social', 'social', t('nav.social'))}
    </nav>` : ''}
  `;
  document.getElementById('page').appendChild(contentEl);
  if (u) wireNotifications();
}

async function wireNotifications() {
  const btn = document.getElementById('notifBtn');
  if (!btn) return;
  try {
    const { notifications } = await api('/users/me/notifications');
    const unread = notifications.filter(n => !n.read).length;
    if (unread) document.getElementById('notifCount').textContent = String(unread > 99 ? '99+' : unread);
    btn.onclick = async () => {
      const items = notifications.slice(0, 20).map(n =>
        `<div class="list-item"><div class="li-icon accent">${icon('bell', { size: 20 })}</div><div class="li-body"><strong>${esc(n.title)}</strong><div class="muted small">${esc(n.body || '')}</div></div></div>`).join('')
        || `<div class="empty"><div class="center" style="margin-bottom:12px"><span class="icon-chip lg plain">${icon('bell')}</span></div><p class="muted">${esc(t('nav.noNotifications'))}</p></div>`;
      openModal(`<h2>${esc(t('nav.notifications'))}</h2>${items}`);
      if (unread) { await api('/users/me/notifications/read', { method: 'POST' }); document.getElementById('notifCount').textContent = ''; }
    };
  } catch { /* non-fatal */ }
}

export function openModal(html) {
  document.querySelector('.rp-modal')?.remove();
  const prevFocus = document.activeElement;
  const wrap = document.createElement('div');
  wrap.className = 'rp-modal';
  wrap.setAttribute('role', 'dialog');
  wrap.setAttribute('aria-modal', 'true');
  wrap.innerHTML = `<div class="card">${html}
    <div class="mt center"><button class="secondary" data-close>${esc(t('common.close'))}</button></div></div>`;
  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    wrap.remove();
    if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus();
  };
  // Esc closes; Tab cycles inside the modal (keyboard accessibility).
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key === 'Tab') {
      const focusables = [...wrap.querySelectorAll('a[href], input, select, textarea, button')];
      const i = focusables.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); focusables[focusables.length - 1].focus(); }
      else if (!e.shiftKey && i === focusables.length - 1) { e.preventDefault(); focusables[0].focus(); }
    }
  };
  wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.hasAttribute('data-close')) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(wrap);
  wrap.querySelector('[data-close]').focus();
  return wrap;
}

async function route() {
  if (typeof cleanup === 'function') { try { cleanup(); } catch { /* page teardown */ } cleanup = null; }
  const hash = location.hash.replace(/^#/, '') || '/';
  const match = routes.find(r => r.re.test(hash));
  const el = document.createElement('div');

  if (!match) { location.hash = '#/'; return; }
  if (!match.public && !state.user) { location.hash = '#/login'; return; }
  if (match.public && state.user && /^\/login/.test(hash)) { location.hash = '#/'; return; }

  shell(el, match.tab);
  const params = hash.match(match.re)?.slice(1) || [];
  try {
    cleanup = await match.page(el, ...params) || null;
  } catch (e) {
    console.error(e);
    // API errors already carry a human-written server message; show it. An
    // unexpected JS crash must never surface its technical text to the user.
    const friendly = e instanceof ApiFail
      ? esc(e.message)
      : esc(t('common.pageErrorBody'));
    el.innerHTML = `<div class="card empty"><div class="center" style="margin-bottom:14px"><span class="icon-chip lg amber">${icon('warning')}</span></div>
      <h2>${esc(t('common.somethingWrong'))}</h2>
      <p class="muted">${friendly}</p>
      <button class="secondary mt" onclick="location.reload()">${esc(t('common.retry'))}</button></div>`;
    try { await api('/users/me/health-events', { method: 'POST', body: { kind: 'client_error', detail: `route ${hash}: ${e.message}` } }); } catch { /* offline */ }
  }
}

window.addEventListener('hashchange', route);
window.addEventListener('rp:navigate', route);
// Re-render the current view whenever the language changes so every string
// (nav, chrome, and the active page) picks up the new locale immediately.
window.addEventListener('rp:locale', route);

/* ---------------- global crash reporting (§3.2) ----------------
   Uncaught errors and unhandled promise rejections are reported — sanitized,
   deduplicated, and hard-capped per page load — to the health-events endpoint,
   where they surface as client-crash trends in the admin dashboard. Reporting
   never blocks the UI and silently no-ops when signed out or offline. No user
   content or tokens are included; only the error message + source location. */
const _crashSeen = new Set();
let _crashCount = 0;
async function reportClientError(kind, detail) {
  if (!state.user) return;                       // only meaningful once signed in
  const text = String(detail || 'error').slice(0, 500);
  const key = text.slice(0, 120);
  if (_crashSeen.has(key) || _crashCount >= 25) return; // dedupe + per-load cap
  _crashSeen.add(key); _crashCount++;
  try { await api('/users/me/health-events', { method: 'POST', body: { kind, detail: text } }); }
  catch { /* offline or signed out — drop it */ }
}
window.addEventListener('error', (e) => {
  if (!e?.message) return;                        // ignore resource-load noise
  const where = e.filename ? ` @ ${String(e.filename).replace(location.origin, '')}:${e.lineno || 0}` : '';
  reportClientError('crash', `${e.message}${where}`);
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e?.reason;
  reportClientError('crash', `unhandledrejection: ${(r && (r.message || r)) || 'unknown'}`);
});

let booted = false;
async function boot() {
  // First launch: let the user pick a language before anything else renders.
  if (firstRunNeedsLanguage()) { renderLanguageScreen(); return; }

  await loadMe();
  if (state.user) {
    startSyncWorker();
    // HR subsystem: silent reconnect to the preferred monitor at app launch.
    hrManager.tryAutoReconnect();
  }
  if (!booted) {
    booted = true;
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => { /* PWA optional */ });
    }
    window.addEventListener('rp:session', async () => { await loadMe(); startSyncWorker(); route(); });
  }
  route();
}
boot();

export { setSession, toast };
