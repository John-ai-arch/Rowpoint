// Interactive Performance Timeline (vision #7): scroll through years of
// progress — first row, distance milestones, PRs, achievements, and training
// plans — merged chronologically from /api/me/timeline (existing data only).
import { api, esc, fmtDate } from '../api.js';
import { icon } from '../icons.js';
import { t } from '../i18n.js';

const TYPE_COLOR = { achievement: '#eab308', pr: '#38bdf8', milestone: '#10b981', plan: '#a855f7', workout: '#6d7bf6' };
const TYPE_ICON = { achievement: 'medal', pr: 'bolt', milestone: 'droplet', plan: 'calendar', workout: 'oar' };

export async function renderTimeline(el) {
  el.innerHTML = `<div class="card"><div class="skeleton" style="height:120px"></div></div>`;
  let timeline;
  try { ({ timeline } = await api('/me/timeline')); }
  catch (e) { el.innerHTML = `<div class="notice warn">${esc(e.message)}</div>`; return; }

  if (!timeline.length) {
    el.innerHTML = `<header class="mb"><h1>${esc(t('timeline.title'))}</h1></header>
      <div class="card"><div class="empty"><div class="center" style="margin-bottom:12px"><span class="icon-chip lg">${icon('progress')}</span></div>
        <h3>${esc(t('timeline.empty'))}</h3><a class="btn mt" href="#/row">${icon('oar', { size: 17 })} ${esc(t('timeline.startRowing'))}</a></div></div>`;
    return;
  }

  const byYear = {};
  for (const e of timeline) { const y = new Date(e.at * 1000).getFullYear(); (byYear[y] = byYear[y] || []).push(e); }
  const years = Object.keys(byYear).sort((a, b) => b - a);

  el.innerHTML = `
    <header class="mb"><h1>${esc(t('timeline.title'))}</h1>
      <p class="muted">${esc(t('timeline.subtitle', { n: timeline.length }))}</p></header>
    ${years.map(y => `<div class="card">
      <h3>${y}</h3>
      <div style="position:relative;padding-left:8px">
        ${byYear[y].map(eventRow).join('')}
      </div>
    </div>`).join('')}`;
}

function eventRow(e) {
  const c = TYPE_COLOR[e.type] || 'var(--accent)';
  return `<div style="display:flex;gap:12px;padding:8px 0;position:relative">
    <div style="flex:0 0 auto;width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:${c}22;border:1px solid ${c}55;color:${c}">${icon(TYPE_ICON[e.type] || 'dot', { size: 18 })}</div>
    <div style="flex:1;min-width:0">
      <strong>${esc(e.title)}</strong>
      <div class="muted small">${esc(e.detail || '')} · ${esc(fmtDate(e.at))}</div>
    </div>
  </div>`;
}
