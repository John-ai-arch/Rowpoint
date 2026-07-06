// §1.3 — Workout builder with instant client-side validation mirroring PM5
// limits (the machine's own validation stays authoritative at push time).
import { toast, esc } from '../api.js';

// Mirror of server/ai/planValidation.js limits for instant feedback.
const L = { minTimeS: 20, maxTimeS: 35999, minDistanceM: 100, maxDistanceM: 50000, maxIntervals: 30, maxRestS: 595 };

export function validatePlanClient(plan) {
  if (!plan || plan.type === 'justrow') return { ok: true };
  if (plan.type === 'time') {
    if (!(plan.durationS >= L.minTimeS)) return { ok: false, error: `Minimum time workout is ${L.minTimeS} seconds.` };
    if (plan.durationS > L.maxTimeS) return { ok: false, error: 'Time workout too long for the monitor.' };
  }
  if (plan.type === 'distance') {
    if (!(plan.distanceM >= L.minDistanceM)) return { ok: false, error: `Minimum distance is ${L.minDistanceM} m.` };
    if (plan.distanceM > L.maxDistanceM) return { ok: false, error: `Maximum distance is ${L.maxDistanceM} m.` };
  }
  if (plan.type === 'intervals') {
    if (!plan.intervals?.length) return { ok: false, error: 'Add at least one interval.' };
    if (plan.intervals.length > L.maxIntervals) return { ok: false, error: `At most ${L.maxIntervals} intervals.` };
    for (let i = 0; i < plan.intervals.length; i++) {
      const iv = plan.intervals[i];
      if (iv.workType === 'time' && !(iv.workTimeS >= L.minTimeS)) return { ok: false, error: `Interval ${i + 1}: work time ≥ ${L.minTimeS}s.` };
      if (iv.workType === 'distance' && !(iv.workDistanceM >= L.minDistanceM)) return { ok: false, error: `Interval ${i + 1}: distance ≥ ${L.minDistanceM}m.` };
      if (iv.workType === 'calories' && !(iv.workCalories >= 1)) return { ok: false, error: `Interval ${i + 1}: calories ≥ 1.` };
      if ((iv.restTimeS ?? 0) > L.maxRestS) return { ok: false, error: `Interval ${i + 1}: rest ≤ ${L.maxRestS}s.` };
    }
  }
  return { ok: true };
}

export function describePlanText(plan) {
  if (!plan) return 'Open row — no target';
  if (plan.type === 'time') { const m = Math.floor(plan.durationS / 60); const s = plan.durationS % 60; return `${m}:${String(s).padStart(2, '0')} timed piece`; }
  if (plan.type === 'distance') return `${plan.distanceM} m piece`;
  if (plan.type === 'intervals') {
    const f = plan.intervals[0];
    const w = f.workType === 'time' ? `${Math.round(f.workTimeS / 60) || f.workTimeS + 's'}${f.workTimeS >= 60 ? 'min' : ''}` : f.workType === 'distance' ? `${f.workDistanceM}m` : `${f.workCalories}cal`;
    return `${plan.intervals.length} × ${w}${f.restTimeS ? ` / ${f.restTimeS}s rest` : ''}`;
  }
  return 'Open row';
}

export function renderBuilder(el) {
  let type = 'distance';
  let intervals = [{ workType: 'distance', workDistanceM: 500, restTimeS: 60 }];

  function draw() {
    el.innerHTML = `<h1>Workout builder</h1>
    <div class="card">
      <label class="field"><span>Name</span><input id="name" placeholder="e.g. 4×500m sprints" value="My workout"></label>
      <label class="field"><span>Type</span>
        <div class="seg">
          ${['distance', 'time', 'intervals', 'justrow'].map(t => `<button type="button" data-t="${t}" class="${type === t ? 'on' : ''}">${t === 'justrow' ? 'Just row' : t}</button>`).join('')}
        </div></label>
      <div id="typeFields"></div>
      <div id="valMsg"></div>
      <div class="row mt">
        <button id="rowNow" style="flex:1">Row this now</button>
      </div>
      <p class="muted small">Values are checked instantly against the monitor's documented limits; the machine's own firmware still has the final say when you push the workout, and its exact response is shown if it rejects.</p>
    </div>`;

    const tf = el.querySelector('#typeFields');
    if (type === 'distance') tf.innerHTML = `<label class="field"><span>Distance (m, ${100}–${50000})</span><input id="distanceM" type="number" value="2000"></label>`;
    if (type === 'time') tf.innerHTML = `<label class="field"><span>Duration (minutes)</span><input id="durationMin" type="number" value="30" min="1"></label>`;
    if (type === 'intervals') {
      tf.innerHTML = `${intervals.map((iv, i) => `
        <div class="card tight" data-iv="${i}">
          <div class="row between"><strong>Interval ${i + 1}</strong>${intervals.length > 1 ? `<button class="ghost sm" data-del="${i}">✕</button>` : ''}</div>
          <div class="grid cols3">
            <label class="field"><span>Work by</span>
              <select data-f="workType" data-i="${i}">
                <option value="distance" ${iv.workType === 'distance' ? 'selected' : ''}>Distance</option>
                <option value="time" ${iv.workType === 'time' ? 'selected' : ''}>Time</option>
                <option value="calories" ${iv.workType === 'calories' ? 'selected' : ''}>Calories</option>
              </select></label>
            <label class="field"><span>${iv.workType === 'time' ? 'Seconds' : iv.workType === 'calories' ? 'Calories' : 'Meters'}</span>
              <input type="number" data-f="workValue" data-i="${i}" value="${iv.workType === 'time' ? iv.workTimeS ?? 60 : iv.workType === 'calories' ? iv.workCalories ?? 15 : iv.workDistanceM ?? 500}"></label>
            <label class="field"><span>Rest (s)</span><input type="number" data-f="restTimeS" data-i="${i}" value="${iv.restTimeS ?? 60}"></label>
          </div>
        </div>`).join('')}
        <button class="secondary sm" id="addIv">+ Add interval</button>
        <button class="ghost sm" id="dupIv">⧉ Duplicate last</button>`;
    }
    if (type === 'justrow') tf.innerHTML = `<p class="muted">Open-ended row — the monitor just counts up.</p>`;
    wire();
    validateLive();
  }

  function currentPlan() {
    if (type === 'justrow') return { type: 'justrow' };
    if (type === 'distance') return { type: 'distance', distanceM: num('#distanceM') };
    if (type === 'time') return { type: 'time', durationS: Math.round(num('#durationMin') * 60) };
    return {
      type: 'intervals',
      intervals: intervals.map(iv => iv.workType === 'time'
        ? { workType: 'time', workTimeS: iv.workTimeS, restTimeS: iv.restTimeS }
        : iv.workType === 'calories'
          ? { workType: 'calories', workCalories: iv.workCalories, restTimeS: iv.restTimeS }
          : { workType: 'distance', workDistanceM: iv.workDistanceM, restTimeS: iv.restTimeS }),
    };
  }

  function validateLive() {
    const v = validatePlanClient(currentPlan());
    el.querySelector('#valMsg').innerHTML = v.ok
      ? `<div class="notice small">✓ Valid: ${esc(describePlanText(currentPlan()))}</div>`
      : `<div class="notice warn small">${esc(v.error)}</div>`;
    el.querySelector('#rowNow').disabled = !v.ok;
  }

  function wire() {
    el.querySelectorAll('[data-t]').forEach(b => b.onclick = () => { type = b.dataset.t; draw(); });
    el.querySelectorAll('input, select').forEach(inp => inp.addEventListener('input', () => {
      if (inp.dataset.i !== undefined) {
        const i = Number(inp.dataset.i); const iv = intervals[i];
        if (inp.dataset.f === 'workType') {
          const nv = inp.value;
          intervals[i] = { workType: nv, restTimeS: iv.restTimeS, ...(nv === 'time' ? { workTimeS: 60 } : nv === 'calories' ? { workCalories: 15 } : { workDistanceM: 500 }) };
          draw(); return;
        }
        if (inp.dataset.f === 'workValue') {
          const v = Number(inp.value);
          if (iv.workType === 'time') iv.workTimeS = v; else if (iv.workType === 'calories') iv.workCalories = v; else iv.workDistanceM = v;
        }
        if (inp.dataset.f === 'restTimeS') iv.restTimeS = Number(inp.value);
      }
      validateLive();
    }));
    el.querySelector('#addIv')?.addEventListener('click', () => { intervals.push({ workType: 'distance', workDistanceM: 500, restTimeS: 60 }); draw(); });
    el.querySelector('#dupIv')?.addEventListener('click', () => { intervals.push({ ...intervals[intervals.length - 1] }); draw(); });
    el.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { intervals.splice(Number(b.dataset.del), 1); draw(); });
    el.querySelector('#rowNow').onclick = () => {
      const plan = currentPlan();
      const v = validatePlanClient(plan);
      if (!v.ok) { toast(v.error, 'error'); return; }
      sessionStorage.setItem('rp_draft_plan', JSON.stringify({ name: el.querySelector('#name').value || 'Custom workout', plan }));
      location.hash = '#/row';
    };
  }

  const num = (sel) => Number(el.querySelector(sel)?.value);
  draw();
}
