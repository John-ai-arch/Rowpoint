// Workout detail: splits table + chart, per-stroke force curves (§6), the
// stored AI pacing feedback (§11.4) with its explainable classification, and
// the physics engine's analysis (energy, stroke rhythm, recovery kinetics,
// performance decomposition — loaded lazily, never blocking the page).
import { api, state, esc, fmtSplit, fmtDistance, fmtDuration, fmtDateTime } from '../api.js';
import { t } from '../i18n.js';
import { drawSplitBars, drawForceCurve, drawHrSeries } from '../components/charts.js';
import { describePlanText } from './builder.js';
import { zoneBounds, effectiveMaxHr, ZONE_COLORS, ZONE_NAMES } from '../ble/sensors.js';

export async function renderWorkoutDetail(el, id) {
  el.innerHTML = `<p class="muted">Loading…</p>`;
  let data;
  try { data = await api(`/workouts/${id}`); }
  catch (e) { el.innerHTML = `<div class="notice warn">${esc(e.message)}</div>`; return; }
  const { workout: w, splits, forceCurves } = data;
  const fb = w.aiFeedback;

  el.innerHTML = `
    <a href="#/history" class="small">← History</a>
    <h1>${fmtDistance(w.total_distance_m)} · ${fmtDuration(w.total_time_s)}</h1>
    <p class="muted">${fmtDateTime(w.started_at)} · ${esc(describePlanText(w.plan))} · ${esc(w.machine_type || 'rower')}${w.machine_id ? ` · ${esc(w.machine_id)}` : ''}${w.assigned_by_coach_id ? ' · coach-assigned' : ' · self-directed'}</p>

    <div class="grid cols3">
      <div class="stat-tile"><div class="n">${fmtSplit(w.avg_split_s)}</div><div class="l">avg /500m</div></div>
      <div class="stat-tile"><div class="n">${Math.round(w.avg_stroke_rate || 0)}</div><div class="l">avg stroke rate</div></div>
      <div class="stat-tile"><div class="n">${w.avg_heart_rate ? Math.round(w.avg_heart_rate) : '–'}</div><div class="l">avg HR</div></div>
    </div>

    ${fb ? `<div class="card ai-card">
      <div class="row between"><h3>Pacing feedback</h3><span class="ai-tag">✨ AI-generated</span></div>
      <p>${esc(fb.text)}</p>
      <p class="muted small">Pacing: <strong>${esc(String(fb.classification || '').replaceAll('_', ' '))}</strong>
        ${Number.isFinite(fb.firstThirdPace) ? ` · first third ${fmtSplit(fb.firstThirdPace)} · last third ${fmtSplit(fb.lastThirdPace)} · avg ${fmtSplit(fb.avgPace)}` : ''}</p>
      ${fb.perInterval?.length ? `<details><summary class="small muted">Per-interval breakdown</summary>
        ${fb.perInterval.map(p => `<div class="small">Interval ${p.interval}: ${esc(String(p.tag || '').replaceAll('_', ' '))}</div>`).join('')}</details>` : ''}
    </div>` : ''}

    ${splits.length ? `<div class="card">
      <h3>Splits</h3>
      <canvas class="chart" id="splitChart"></canvas>
      <table class="mt"><thead><tr><th>#</th><th>Dist</th><th>Time</th><th>/500m</th><th>s/m</th><th>HR</th><th>W</th></tr></thead>
      <tbody>${splits.map(s => `<tr><td>${s.split_index + 1}</td><td>${Math.round(s.distance_m)}m</td><td>${fmtDuration(s.time_s)}</td>
        <td>${fmtSplit(s.avg_pace_s_per_500m)}</td><td>${s.avg_stroke_rate ? Math.round(s.avg_stroke_rate) : '–'}</td>
        <td>${s.avg_heart_rate ? Math.round(s.avg_heart_rate) : '–'}</td><td>${s.avg_power_watts ? Math.round(s.avg_power_watts) : '–'}</td></tr>`).join('')}</tbody></table>
    </div>` : ''}

    ${w.hrSeries?.length ? `<div class="card">
      <h3>Heart rate</h3>
      <div class="grid cols3">
        <div class="stat-tile"><div class="n">${Math.round(w.avg_heart_rate || 0)}</div><div class="l">avg bpm</div></div>
        <div class="stat-tile"><div class="n" style="color:var(--bad)">${Math.round(w.max_heart_rate || 0)}</div><div class="l">max bpm</div></div>
        <div class="stat-tile"><div class="n">${Math.round(w.min_heart_rate || 0)}</div><div class="l">min bpm</div></div>
      </div>
      <canvas class="chart mt" id="hrChart"></canvas>
      <p class="muted small">Red = heart rate over the workout, zone colors in the background; dashed blue = pace per split (up = faster) so you can see HR vs pace decoupling.</p>
      ${w.hrZones?.zoneSeconds ? `<div class="mt">${ZONE_NAMES.map((n, i) => {
    const total = w.hrZones.zoneSeconds.reduce((a, b) => a + b, 0) || 1;
    const secs = w.hrZones.zoneSeconds[i];
    return `<div class="row" style="margin:5px 0"><span style="width:118px" class="small">${n}</span>
      <div style="flex:1;background:var(--bg2);border-radius:6px;height:16px;overflow:hidden">
        <div style="width:${Math.round((secs / total) * 100)}%;background:${ZONE_COLORS[i]};height:100%"></div></div>
      <span class="small muted" style="width:100px;text-align:right">${fmtDuration(secs)}</span></div>`;
  }).join('')}</div>` : ''}
      <p class="muted small">
        ${w.hrZones?.driftPct !== null && w.hrZones?.driftPct !== undefined ? `HR drift (2nd half vs 1st): <strong>${w.hrZones.driftPct > 0 ? '+' : ''}${w.hrZones.driftPct}%</strong> · ` : ''}
        ${w.avg_power_watts ? `Calories (est.): <strong>${Math.round((w.avg_power_watts * w.total_time_s / 4184) * 4)}</strong> · ` : ''}
        zones based on max HR ${w.hrZones?.maxHrUsed || effectiveMaxHr(state.user)}
      </p>
    </div>` : ''}

    ${forceCurves.length ? `<div class="card">
      <div class="row between"><h3>Stroke force curves</h3>
        <input id="strokeSlider" type="range" min="0" max="${forceCurves.length - 1}" value="0" style="max-width:200px"></div>
      <canvas class="chart" id="forceChart"></canvas>
      <p class="muted small" id="strokeLabel"></p>
    </div>` : ''}

    <div class="card" id="physicsCard"><h3>${esc(t('physics.title'))}</h3><p class="muted small">${esc(t('common.loading'))}</p></div>
  `;

  if (splits.length) drawSplitBars(el.querySelector('#splitChart'), splits);
  if (w.hrSeries?.length) {
    const maxHr = w.hrZones?.maxHrUsed || effectiveMaxHr(state.user);
    // Pace overlay: cumulative time per split → (t, pace) points.
    let t = 0;
    const paceOverlay = splits.map(s => { t += s.time_s || 0; return { t, pace: s.avg_pace_s_per_500m }; });
    drawHrSeries(el.querySelector('#hrChart'), w.hrSeries, {
      maxHr, zoneBounds: zoneBounds(maxHr), zoneColors: ZONE_COLORS,
      paceOverlay: paceOverlay.length >= 2 ? paceOverlay : null,
    });
  }
  if (forceCurves.length) {
    const slider = el.querySelector('#strokeSlider');
    const show = () => {
      const i = Number(slider.value);
      drawForceCurve(el.querySelector('#forceChart'), forceCurves[i].samples, {
        ghost: i > 0 ? forceCurves[i - 1].samples : null,
        label: `Stroke ${forceCurves[i].strokeIndex}`,
      });
      el.querySelector('#strokeLabel').textContent = `Stroke ${forceCurves[i].strokeIndex} of ${forceCurves[forceCurves.length - 1].strokeIndex} (drag to scrub; ghost = previous stroke)`;
    };
    slider.addEventListener('input', show);
    show();
  }

  renderPhysics(el.querySelector('#physicsCard'), id);
}

/** Physics-engine analysis card (lazy — a physics failure never hurts the page). */
async function renderPhysics(card, workoutId) {
  if (!card) return;
  let p;
  try { ({ ...p } = await api(`/physics/workout/${workoutId}`)); }
  catch { card.remove(); return; }

  const e = p.energy;
  const d = p.decomposition;
  const rhythm = p.stroke?.rhythmRatio;
  const badge = (prov) => `<span class="badge ${prov === 'measured' ? 'green' : prov === 'estimated' ? 'blue' : 'amber'}">${esc(t(`twin.provenance.${prov}`) || prov)}</span>`;

  card.innerHTML = `
    <h3>${esc(t('physics.title'))}</h3>
    ${e ? `<div class="grid cols3">
      <div class="stat-tile"><div class="n">${Math.round(e.calories.value)}</div><div class="l">${esc(t('physics.calories'))} ±${Math.round(e.calories.uncertainty)}</div></div>
      <div class="stat-tile"><div class="n">${Math.round(e.mechanicalWorkKj.value)}</div><div class="l">${esc(t('physics.workKj'))}</div></div>
      <div class="stat-tile"><div class="n">${Math.round(e.systems.aerobic.value * 100)}%</div><div class="l">${esc(t('physics.aerobicShare'))}</div></div>
    </div>
    <p class="muted small">${esc(t('physics.energyNote'))} ${badge(e.grossEfficiency.provenance)}</p>` : ''}
    ${rhythm ? `<p class="small">${esc(t('physics.rhythm'))}: <strong>${rhythm.value.toFixed(1)} : 1</strong>
      ${p.stroke.driveTimeS ? ` · ${esc(t('physics.driveTime'))}: <strong>${p.stroke.driveTimeS.value.toFixed(2)}s</strong>` : ''}
      ${badge(rhythm.provenance)} <span class="muted small">(${p.stroke.source === 'force-curve' ? 'from your force curves' : 'modeled from stroke rate'})</span></p>` : ''}
    ${p.recovery ? `<p class="small">${esc(t('physics.recovery'))}: <strong>~${Math.round(p.recovery.hoursToRecover)}h</strong>
      <span class="muted">· ${esc(t('physics.residual24'))}: ${Math.round(p.recovery.residualIn24h.overall)}/100</span></p>` : ''}
    ${d?.available ? `<p class="small" style="margin-bottom:0"><strong>${esc(t('physics.why'))}</strong> ${esc(d.explanation)}</p>` : ''}
    <p class="muted small" style="margin-bottom:0">${esc(t('physics.disclaimer'))}</p>`;
}
