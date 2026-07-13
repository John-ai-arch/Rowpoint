// AI Training Journal (vision #6): every workout's AI coaching summary next to
// the athlete's own note, all searchable. The coaching summary is the same
// post-workout feedback the AI already generates at sync — this view collects
// it into a scrollable, searchable journal and lets the athlete add their own
// reflections. Reads /api/workouts/journal; saves notes via PATCH.
import { api, toast, esc, fmtDistance, fmtDuration, fmtSplit, fmtDate } from '../api.js';
import { icon } from '../icons.js';
import { t } from '../i18n.js';

let query = '';

export async function renderJournal(el) {
  el.innerHTML = `
    <header class="mb">
      <div class="row" style="justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap">
        <div><h1>${esc(t('journal.title'))}</h1><p class="muted">${esc(t('journal.subtitle'))}</p></div>
        <a class="btn secondary sm" href="#/history">${esc(t('journal.history'))}</a>
      </div>
    </header>
    <div class="field" style="margin-bottom:14px">
      <input id="jSearch" type="search" placeholder="${esc(t('journal.searchPh'))}" value="${esc(query)}">
    </div>
    <div id="jList"><div class="card"><div class="skeleton" style="height:80px"></div></div></div>`;

  const list = el.querySelector('#jList');
  const search = el.querySelector('#jSearch');
  let timer = null;
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { query = search.value.trim(); load(list); }, 250); });
  await load(list);
}

async function load(list) {
  let data;
  try { data = await api(`/workouts/journal${query ? `?q=${encodeURIComponent(query)}` : ''}`); }
  catch (e) { list.innerHTML = `<div class="notice warn">${esc(e.message)}</div>`; return; }

  if (!data.entries.length) {
    list.innerHTML = `<div class="card"><div class="empty">
      <div class="center" style="margin-bottom:12px"><span class="icon-chip lg">${icon('book')}</span></div>
      <h3>${esc(query ? t('journal.noMatches') : t('journal.empty'))}</h3>
      ${query ? '' : `<a class="btn mt" href="#/row">${icon('oar', { size: 17 })} ${esc(t('journal.startRowing'))}</a>`}
    </div></div>`;
    return;
  }

  list.innerHTML = data.entries.map(entryHtml).join('');
  list.querySelectorAll('[data-note-for]').forEach(wireNoteEditor);
}

function entryHtml(e) {
  const title = e.machineType ? cap(e.machineType) : 'Row';
  return `<div class="card" style="margin-bottom:12px">
    <div class="row" style="justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:6px">
      <strong>${esc(fmtDate(e.startedAt))} · ${esc(title)}</strong>
      <a class="small" href="#/workout/${esc(e.id)}">${esc(t('journal.open'))}</a>
    </div>
    <div class="row small muted" style="gap:14px;flex-wrap:wrap;margin:4px 0 8px">
      <span>${fmtDistance(e.distanceM)}</span><span>${fmtDuration(e.timeS)}</span>
      ${e.avgSplitS ? `<span>${fmtSplit(e.avgSplitS)}/500m</span>` : ''}
      ${e.pacing && e.pacing !== 'insufficient_data' ? `<span class="badge">${esc(pacingLabel(e.pacing))}</span>` : ''}
    </div>
    ${e.coachSummary ? `<div class="notice" style="margin-bottom:8px"><span class="small muted ai-tag">${icon('sparkle', { size: 12 })} ${esc(t('journal.coachSummary'))}</span><br>${esc(e.coachSummary)}</div>` : ''}
    <label class="field" style="margin:0">
      <span class="small muted">${esc(t('journal.yourNote'))}</span>
      <textarea data-note-for="${esc(e.id)}" rows="2" placeholder="${esc(t('journal.notePh'))}">${esc(e.note || '')}</textarea>
    </label>
    <div class="row" style="justify-content:flex-end;margin-top:6px"><button class="ghost sm" data-save="${esc(e.id)}" hidden>${esc(t('journal.save'))}</button></div>
  </div>`;
}

function wireNoteEditor(ta) {
  const id = ta.dataset.noteFor;
  const saveBtn = ta.closest('.card').querySelector(`[data-save="${id}"]`);
  let original = ta.value;
  ta.addEventListener('input', () => { saveBtn.hidden = ta.value === original; });
  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    try {
      const r = await api(`/workouts/${id}/note`, { method: 'PATCH', body: { note: ta.value } });
      original = r.note || '';
      saveBtn.hidden = true;
      toast(t('journal.saved'), 'success', 2000);
    } catch (e) { toast(e.message, 'error'); }
    saveBtn.disabled = false;
  };
}

const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
function pacingLabel(p) {
  return { well_paced: t('journal.pacedWell'), started_too_hard: t('journal.wentOutHard'), started_too_easy: t('journal.negativeSplit') }[p] || p.replaceAll('_', ' ');
}
