// RowPoint SPA shell: hash router, top bar, tab nav, auth guard.
import { state, loadMe, setSession, api, toast, esc } from './api.js';
import { startSyncWorker, pendingCount } from './offline.js';
import { renderAuth } from './pages/auth.js';
import { renderDashboard } from './pages/dashboard.js';
import { renderRow } from './pages/row.js';
import { renderHistory } from './pages/history.js';
import { renderWorkoutDetail } from './pages/workoutDetail.js';
import { renderBuilder } from './pages/builder.js';
import { renderTeams } from './pages/teams.js';
import { renderTeamDetail } from './pages/teamDetail.js';
import { renderLive } from './pages/live.js';
import { renderSocial } from './pages/social.js';
import { renderGroup } from './pages/group.js';
import { renderWellness } from './pages/wellness.js';
import { renderSettings } from './pages/settings.js';
import { renderAdmin } from './pages/admin.js';
import { renderHrm } from './pages/hrm.js';
import { hrManager } from './ble/sensors.js';

const routes = [
  { re: /^\/?$/, page: renderDashboard, tab: 'home' },
  { re: /^\/login/, page: renderAuth, public: true },
  { re: /^\/row/, page: renderRow, tab: 'row' },
  { re: /^\/history$/, page: renderHistory, tab: 'history' },
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
  { re: /^\/admin/, page: renderAdmin, tab: 'home' },
];

let cleanup = null;

function shell(contentEl, activeTab) {
  const u = state.user;
  const pending = u ? pendingCount(u.id) : 0;
  const app = document.getElementById('app');
  app.innerHTML = `
    <header class="topbar">
      <div class="brand"><span class="dot"></span> RowPoint</div>
      <div class="actions">
        ${pending ? `<span class="badge amber" title="Workouts waiting to sync">${pending} pending</span>` : ''}
        ${u ? `<button class="ghost sm" id="notifBtn" aria-label="Notifications">🔔<span id="notifCount"></span></button>` : ''}
        ${u ? `<a href="#/settings" class="btn ghost sm" aria-label="Settings">⚙︎</a>` : ''}
      </div>
    </header>
    <main id="page"></main>
    ${u ? `
    <nav class="tabs" aria-label="Main">
      <a href="#/" class="${activeTab === 'home' ? 'active' : ''}"><span class="ico">⌂</span>Home</a>
      <a href="#/row" class="${activeTab === 'row' ? 'active' : ''}"><span class="ico">⏱</span>Row</a>
      <a href="#/hr" class="${activeTab === 'hr' ? 'active' : ''}"><span class="ico">❤</span>Heart Rate</a>
      <a href="#/history" class="${activeTab === 'history' ? 'active' : ''}"><span class="ico">☰</span>History</a>
      <a href="#/teams" class="${activeTab === 'teams' ? 'active' : ''}"><span class="ico">⚑</span>Teams</a>
      <a href="#/social" class="${activeTab === 'social' ? 'active' : ''}"><span class="ico">◎</span>Social</a>
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
    if (unread) document.getElementById('notifCount').textContent = ` ${unread}`;
    btn.onclick = async () => {
      const items = notifications.slice(0, 20).map(n =>
        `<div class="list-item"><div><strong>${esc(n.title)}</strong><div class="muted small">${esc(n.body || '')}</div></div></div>`).join('')
        || '<p class="muted">No notifications yet.</p>';
      openModal(`<h2>Notifications</h2>${items}`);
      if (unread) { await api('/users/me/notifications/read', { method: 'POST' }); document.getElementById('notifCount').textContent = ''; }
    };
  } catch { /* non-fatal */ }
}

export function openModal(html) {
  document.querySelector('.rp-modal')?.remove();
  const wrap = document.createElement('div');
  wrap.className = 'rp-modal';
  wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:60;display:flex;align-items:center;justify-content:center;padding:16px;';
  wrap.innerHTML = `<div class="card" style="max-width:520px;width:100%;max-height:82vh;overflow:auto;">${html}
    <div class="mt center"><button class="secondary" data-close>Close</button></div></div>`;
  wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.dataset.close !== undefined && e.target.hasAttribute('data-close')) wrap.remove(); });
  document.body.appendChild(wrap);
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
    el.innerHTML = `<div class="card"><h2>Something went wrong</h2><p class="muted">${esc(e.message)}</p></div>`;
    try { await api('/users/me/health-events', { method: 'POST', body: { kind: 'client_error', detail: `route ${hash}: ${e.message}` } }); } catch { /* offline */ }
  }
}

window.addEventListener('hashchange', route);
window.addEventListener('rp:navigate', route);

(async function boot() {
  await loadMe();
  if (state.user) {
    startSyncWorker();
    // HR subsystem: silent reconnect to the preferred monitor at app launch.
    hrManager.tryAutoReconnect();
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* PWA optional */ });
  }
  window.addEventListener('rp:session', async () => { await loadMe(); startSyncWorker(); route(); });
  route();
})();

export { setSession, toast };
