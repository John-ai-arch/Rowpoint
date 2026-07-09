// AI Stroke Analysis (moat #2). Record/select a rowing video, mark catches and
// finishes on the timeline (assisted today; auto pose-estimation is the roadmap
// module), and get modular pipeline feedback + coaching observations with
// explicit confidence. Coaches and athletes annotate; two analyses compare over
// time. Video bytes stay client-side (object URL); the analysis is what's saved.
import { api, state, toast, esc, fmtDate } from '../api.js';
import { t } from '../i18n.js';

export async function renderStroke(el) {
  el.innerHTML = `<div class="card"><div class="skeleton" style="height:100px"></div></div>`;
  let analyses, modules;
  try {
    const [a, m] = await Promise.all([api('/stroke'), api('/stroke/modules')]);
    analyses = a.analyses; modules = m.modules;
  } catch (e) { el.innerHTML = `<div class="notice warn">${esc(e.message)}</div>`; return; }
  drawList(el, analyses, modules);
}

function drawList(el, analyses, modules) {
  el.innerHTML = `
    <header class="mb">
      <div class="row" style="justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap">
        <div><h1>${esc(t('stroke.title'))}</h1><p class="muted">${esc(t('stroke.subtitle'))}</p></div>
        <button id="newBtn">${esc(t('stroke.new'))}</button>
      </div>
    </header>
    <div id="host"></div>
    ${analyses.length ? analyses.map(cardHtml).join('') : `<div class="card"><div class="empty"><span class="ic">🎥</span><h3>${esc(t('stroke.empty'))}</h3></div></div>`}
    <div class="card"><details><summary class="small muted">${esc(t('stroke.howItWorks'))}</summary>
      <p class="small muted mt">${esc(t('stroke.pipelineNote'))}</p>
      <div class="grid cols2" style="gap:6px">
        ${modules.map(m => `<div class="small" style="display:flex;align-items:center;gap:6px">
          <span>${m.available ? '✅' : '🕓'}</span><span>${esc(m.name)}${m.available ? '' : ` <span class="muted">(${esc(t('stroke.roadmap'))})</span>`}</span></div>`).join('')}
      </div></details></div>`;

  el.querySelector('#newBtn').onclick = () => renderRecorder(el);
  el.querySelectorAll('[data-open]').forEach(b => b.onclick = () => renderDetail(el, b.dataset.open));
  el.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!confirm(t('stroke.deleteConfirm'))) return;
    await api(`/stroke/${b.dataset.del}`, { method: 'DELETE' });
    toast(t('stroke.deleted'), 'success'); renderStroke(el);
  });
}

function cardHtml(a) {
  const m = a.metrics || {};
  return `<div class="card">
    <div class="row" style="justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:6px">
      <strong>${esc(a.title)}</strong>
      <span class="row" style="gap:4px"><button class="ghost sm" data-open="${esc(a.id)}">${esc(t('stroke.openBtn'))}</button>
        <button class="ghost sm" data-del="${esc(a.id)}">✕</button></span>
    </div>
    <div class="muted small">${esc(t('stroke.kind_' + a.kind))} · ${fmtDate(a.createdAt)}</div>
    <div class="row mt" style="gap:14px;flex-wrap:wrap">
      ${m.strokeRateSpm ? tile(m.strokeRateSpm, t('stroke.spm')) : ''}
      ${m.ratio ? tile('1:' + m.ratio, t('stroke.ratio')) : ''}
      ${m.consistencyPct != null ? tile(m.consistencyPct + '%', t('stroke.consistency')) : ''}
      ${m.strokes ? tile(m.strokes, t('stroke.strokes')) : ''}
    </div>
  </div>`;
}
const tile = (v, l) => `<div class="stat-tile tight" style="min-width:88px"><div class="n" style="font-size:1.3rem">${esc(String(v))}</div><div class="l">${esc(l)}</div></div>`;

/* ---------------- recorder / marking ---------------- */

function renderRecorder(el) {
  const host = el.querySelector('#host');
  const marks = { catches: [], finishes: [] };
  host.innerHTML = `<div class="card">
    <h3>${esc(t('stroke.newTitle'))}</h3>
    <label class="field"><span>${esc(t('stroke.videoFile'))}</span><input id="vFile" type="file" accept="video/*"></label>
    <video id="vid" controls playsinline style="width:100%;max-height:340px;background:#000;border-radius:12px;display:none"></video>
    <div id="markUi" style="display:none">
      <p class="muted small mt">${esc(t('stroke.markHint'))}</p>
      <div class="row" style="gap:8px;flex-wrap:wrap">
        <button class="secondary" id="catchBtn">⛳ ${esc(t('stroke.catch'))} <span id="catchN">0</span></button>
        <button class="secondary" id="finishBtn">🏁 ${esc(t('stroke.finish'))} <span id="finishN">0</span></button>
        <button class="ghost sm" id="undoBtn">↶ ${esc(t('stroke.undo'))}</button>
      </div>
      <div class="grid cols2 mt">
        <label class="field"><span>${esc(t('stroke.aTitle'))}</span><input id="aTitle" placeholder="${esc(t('stroke.aTitlePh'))}"></label>
        <label class="field"><span>${esc(t('stroke.aKind'))}</span><select id="aKind"><option value="erg">${esc(t('stroke.kind_erg'))}</option><option value="boat">${esc(t('stroke.kind_boat'))}</option></select></label>
      </div>
      <div class="row" style="gap:8px"><button id="saveBtn">${esc(t('stroke.analyze'))}</button><button class="ghost" id="cancelBtn">${esc(t('common.cancel') || 'Cancel')}</button></div>
    </div>
  </div>`;
  const vid = host.querySelector('#vid');
  const fileInput = host.querySelector('#vFile');
  fileInput.onchange = () => {
    const f = fileInput.files?.[0]; if (!f) return;
    vid.src = URL.createObjectURL(f);
    vid.style.display = 'block';
    host.querySelector('#markUi').style.display = 'block';
  };
  const upd = () => { host.querySelector('#catchN').textContent = marks.catches.length; host.querySelector('#finishN').textContent = marks.finishes.length; };
  host.querySelector('#catchBtn').onclick = () => { marks.catches.push(round(vid.currentTime)); upd(); };
  host.querySelector('#finishBtn').onclick = () => { marks.finishes.push(round(vid.currentTime)); upd(); };
  host.querySelector('#undoBtn').onclick = () => { (marks.finishes.length >= marks.catches.length ? marks.finishes : marks.catches).pop(); upd(); };
  host.querySelector('#cancelBtn').onclick = () => { host.innerHTML = ''; };
  host.querySelector('#saveBtn').onclick = async () => {
    const title = host.querySelector('#aTitle').value.trim() || t('stroke.untitled');
    if (marks.catches.length < 2) { toast(t('stroke.needMarks'), 'error'); return; }
    try {
      const r = await api('/stroke', { method: 'POST', body: {
        title, kind: host.querySelector('#aKind').value, durationS: vid.duration || 0, marks,
      } });
      toast(t('stroke.analyzed'), 'success');
      renderDetail(el, r.analysis.id);
    } catch (e) { toast(e.message, 'error'); }
  };
}
const round = (n) => Math.round(n * 100) / 100;

/* ---------------- detail ---------------- */

async function renderDetail(el, id) {
  el.innerHTML = `<div class="card"><div class="skeleton" style="height:120px"></div></div>`;
  let data, list;
  try {
    [data, list] = await Promise.all([api(`/stroke/${id}`), api('/stroke')]);
  } catch (e) { el.innerHTML = `<div class="notice warn">${esc(e.message)}</div>`; return; }
  const a = data.analysis, m = a.metrics || {};
  const others = list.analyses.filter(x => x.id !== id);

  el.innerHTML = `
    <div class="row mb" style="justify-content:space-between;align-items:center">
      <button class="ghost sm" id="back">← ${esc(t('stroke.back'))}</button>
      <button class="ghost sm" id="del">✕ ${esc(t('stroke.delete'))}</button>
    </div>
    <header class="mb"><h1>${esc(a.title)}</h1><p class="muted">${esc(t('stroke.kind_' + a.kind))} · ${fmtDate(a.createdAt)} · ${esc(t('stroke.pipeline'))} v${esc(a.pipelineVersion || '1.0')}</p></header>

    <div class="grid cols2">
      <div class="card"><h3>${esc(t('stroke.metrics'))}</h3>
        <div class="row" style="gap:14px;flex-wrap:wrap">
          ${m.strokeRateSpm ? tile(m.strokeRateSpm, t('stroke.spm')) : ''}
          ${m.ratio ? tile('1:' + m.ratio, t('stroke.ratio')) : ''}
          ${m.consistencyPct != null ? tile(m.consistencyPct + '%', t('stroke.consistency')) : ''}
          ${m.strokes ? tile(m.strokes, t('stroke.strokes')) : ''}
          ${m.driveS ? tile(m.driveS + 's', t('stroke.drive')) : ''}
          ${m.recoveryS ? tile(m.recoveryS + 's', t('stroke.recovery')) : ''}
        </div></div>
      <div class="card"><h3>${esc(t('stroke.observations'))}</h3>
        ${(a.observations || []).length ? a.observations.map(o => `<div class="list-item" style="align-items:flex-start">
          <div class="avatar" aria-hidden="true">${confIcon(o.confidence)}</div>
          <div><div class="small">${esc(o.text)}</div><div class="muted" style="font-size:.7rem">${esc(t('stroke.confidence'))}: ${Math.round((o.confidence || 0) * 100)}%${o.tSeconds != null ? ` · @${o.tSeconds}s` : ''}</div></div>
        </div>`).join('') : `<p class="muted small">${esc(t('stroke.noObs'))}</p>`}
        <p class="muted" style="font-size:.7rem;margin-top:8px">${esc(t('stroke.obsDisclaimer'))}</p></div>
    </div>

    ${others.length ? `<div class="card"><h3>${esc(t('stroke.compare'))}</h3>
      <div class="row" style="gap:8px;align-items:flex-end"><label class="field" style="margin:0;flex:1"><span>${esc(t('stroke.compareWith'))}</span>
        <select id="cmpSel"><option value="">—</option>${others.map(o => `<option value="${esc(o.id)}">${esc(o.title)} · ${fmtDate(o.createdAt)}</option>`).join('')}</select></label></div>
      <div id="cmpOut" class="mt"></div></div>` : ''}

    <div class="card"><h3>${esc(t('stroke.annotations'))}</h3>
      <div id="annList">${annotationsHtml(data.annotations)}</div>
      <div class="row mt" style="gap:8px"><input id="annBody" placeholder="${esc(t('stroke.annPh'))}" style="flex:1">
        <button class="secondary" id="annAdd">${esc(t('stroke.annAdd'))}</button></div>
    </div>`;

  el.querySelector('#back').onclick = () => renderStroke(el);
  el.querySelector('#del').onclick = async () => { if (!confirm(t('stroke.deleteConfirm'))) return; await api(`/stroke/${id}`, { method: 'DELETE' }); toast(t('stroke.deleted'), 'success'); renderStroke(el); };
  el.querySelector('#annAdd').onclick = async () => {
    const body = el.querySelector('#annBody').value.trim();
    if (!body) return;
    try { await api(`/stroke/${id}/annotations`, { method: 'POST', body: { body } }); el.querySelector('#annBody').value = '';
      const fresh = await api(`/stroke/${id}`); el.querySelector('#annList').innerHTML = annotationsHtml(fresh.annotations); toast(t('stroke.annSaved'), 'success');
    } catch (e) { toast(e.message, 'error'); }
  };
  const cmpSel = el.querySelector('#cmpSel');
  if (cmpSel) cmpSel.onchange = async () => {
    const out = el.querySelector('#cmpOut');
    if (!cmpSel.value) { out.innerHTML = ''; return; }
    const c = await api(`/stroke/compare?a=${id}&b=${cmpSel.value}`);
    out.innerHTML = compareHtml(c.a, c.b);
  };
}

function annotationsHtml(anns) {
  if (!anns.length) return `<p class="muted small">${esc(t('stroke.noAnn'))}</p>`;
  return anns.map(a => `<div class="list-item"><div class="avatar" aria-hidden="true">${a.role === 'coach' ? '🧑‍🏫' : '💬'}</div>
    <div><div class="small">${esc(a.body)}</div><div class="muted" style="font-size:.7rem">${esc(a.author)}${a.tSeconds != null ? ` · @${a.tSeconds}s` : ''}</div></div></div>`).join('');
}

function compareHtml(a, b) {
  const rows = [['spm', 'strokeRateSpm'], ['ratio', 'ratio', (v) => '1:' + v], ['consistency', 'consistencyPct', (v) => v + '%'], ['strokes', 'strokes']];
  return `<table><thead><tr><th></th><th>${esc(a.title)}</th><th>${esc(b.title)}</th></tr></thead><tbody>
    ${rows.map(([label, key, f]) => {
    const av = a.metrics?.[key], bv = b.metrics?.[key];
    if (av == null && bv == null) return '';
    const fmt = f || ((v) => v);
    return `<tr><td class="small muted">${esc(t('stroke.' + label))}</td><td>${av != null ? esc(String(fmt(av))) : '–'}</td><td>${bv != null ? esc(String(fmt(bv))) : '–'}</td></tr>`;
  }).join('')}
  </tbody></table><p class="muted small">${esc(t('stroke.compareNote'))}</p>`;
}

const confIcon = (c) => (c >= 0.75 ? '🟢' : c >= 0.55 ? '🟡' : '🟠');
