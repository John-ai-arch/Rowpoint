// Profile hub — the fourth primary tab. A calm landing that shows who you are
// and a small "how am I doing" summary, then routes into the deeper areas the
// old top-bar gear used to hide: full Settings & privacy, Devices & apps
// (ergs + HR + integrations), Community, your data, and role-gated admin.
// No settings controls are duplicated here — this is a launcher, not a form.
import { api, state, esc, fmtDistance, fmtSplit } from '../api.js';
import { t } from '../i18n.js';
import { icon } from '../icons.js';

export async function renderProfile(el) {
  const u = state.user;
  const initials = (u.displayName || '?').trim().split(/\s+/).map(s => s[0]).slice(0, 2).join('').toUpperCase();

  el.innerHTML = `
    <div class="page-head"><h1>${esc(t('profile.title'))}</h1></div>

    <div class="card feature">
      <div class="row" style="gap:16px;align-items:center">
        <div class="avatar" style="width:60px;height:60px;font-size:1.5rem;border-radius:18px">${esc(initials)}</div>
        <div style="min-width:0;flex:1">
          <h2 style="margin:0">${esc(u.displayName)}</h2>
          <p class="muted small" style="margin:2px 0 0">${esc(u.email)} · ${esc(u.accountType)}${u.emailVerified
    ? ` · <span style="color:var(--good)">${t('profile.verified')} ${icon('check', { size: 12 })}</span>`
    : ` · <span style="color:var(--warn)">${t('profile.unverified')}</span>`}</p>
        </div>
      </div>
      <div id="progSummary" class="mt"></div>
    </div>

    <div class="card stagger">
      <div class="card-head"><span class="icon-chip sm">${icon('user', { size: 18 })}</span><h3>${esc(t('profile.account'))}</h3></div>
      ${entry('gear', 'settings', t('profile.settings'), t('profile.settingsSub'), '#/settings')}
      ${entry('watch', 'devices', t('profile.devices'), t('profile.devicesSub'), '#/equipment')}
      ${entry('social', 'community', t('nav.community'), t('profile.communitySub'), '#/community')}
      ${entry('progress', 'progress', t('profile.progress'), t('profile.progressSub'), '#/progress')}
    </div>

    ${u.isAdmin ? `
    <div class="card">
      <div class="card-head"><span class="icon-chip sm plain">${icon('shield', { size: 18 })}</span><h3>${esc(t('profile.tools'))}</h3></div>
      ${entry('shield', 'admin', t('profile.admin'), t('profile.adminSub'), '#/admin')}
      ${u.researchAdmin ? entry('globe', 'research', t('profile.research'), t('profile.researchSub'), '#/research') : ''}
    </div>` : ''}

    <div class="center mb"><a class="btn ghost" href="#/settings">${icon('gear', { size: 16 })} ${esc(t('profile.allSettings'))}</a></div>`;

  // Lightweight progress summary — reuses /me/progress; never blocks the page.
  try {
    const { progress: p } = await api('/me/progress');
    const box = el.querySelector('#progSummary');
    if (box && p && p.totals.workouts) {
      const goalMeters = Math.max(p.goals.weeklyMeters || 0, 1);
      const pct = Math.min(100, Math.round((p.week.meters / goalMeters) * 100));
      box.innerHTML = `<div class="grid cols3" style="gap:10px">
        <div class="stat-tile tight"><div class="n">${p.streak.current}</div><div class="l">${esc(t('progress.dayStreak'))}</div></div>
        <div class="stat-tile tight"><div class="n">${pct}%</div><div class="l">${esc(t('progress.weeklyGoal'))}</div></div>
        <div class="stat-tile tight"><div class="n">${u.best2kSeconds ? fmtSplit(u.best2kSeconds / 4) : '–'}</div><div class="l">${esc(t('dash.twoKpb'))}</div></div>
      </div>`;
    }
  } catch { /* summary is best-effort */ }
}

function entry(iconName, id, title, sub, href) {
  return `<a class="list-item" href="${href}" style="color:inherit" data-entry="${id}">
    <span class="li-icon accent">${icon(iconName, { size: 20 })}</span>
    <div class="li-body"><strong>${esc(title)}</strong><div class="muted small">${esc(sub)}</div></div>
    <span class="li-go">${icon('chevron-right', { size: 18 })}</span></a>`;
}
