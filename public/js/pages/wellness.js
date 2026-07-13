// §12 — Daily wellness check-in (<30s, same-day edits) + 7/30-day trends.
import { api, state, toast, esc } from '../api.js';
import { icon } from '../icons.js';
import { drawTrend } from '../components/charts.js';

export async function renderWellness(el) {
  let today = null;
  try { ({ checkin: today } = await api('/wellness/today')); } catch { /* offline */ }

  const v = (f, d) => today?.[f] ?? d;
  el.innerHTML = `<div class="page-head"><p class="eyebrow">${icon('droplet', { size: 14 })} Wellness</p><h1>Daily check-in</h1></div>
    ${today ? `<div class="notice mb">You've already checked in today — editing updates the same entry, no duplicates.</div>` : ''}
    <div class="card">
      <label class="field"><span>Sleep last night: <strong id="sleepVal">${v('sleep_hours', 7.5)}</strong> hours</span>
        <input type="range" id="sleep" min="0" max="12" step="0.5" value="${v('sleep_hours', 7.5)}"></label>
      ${scale('Sleep quality', 'quality', v('sleep_quality', 3))}
      ${scale('Muscle soreness', 'soreness', v('soreness_level', 2))}
      ${scale('Stress level', 'stress', v('stress_level', 2))}
      <label class="field"><span>Anything to flag? (optional)</span>
        <textarea id="notes" rows="2" placeholder="e.g. slight knee tweak yesterday">${esc(v('resting_notes', '') || '')}</textarea></label>
      <button id="save" style="width:100%">${today ? 'Update today\'s check-in' : 'Save check-in'}</button>
      ${state.user.researchOptIn ? `<p class="muted small mt">Check-ins follow the same single research toggle as workouts — you're currently contributing (change anytime in Settings).</p>` : ''}
    </div>
    <div class="card"><div class="card-head"><span class="icon-chip sm">${icon('activity', { size: 18 })}</span><h3>Trends</h3>
      <div class="seg card-head-action" style="max-width:160px"><button id="d7">7d</button><button id="d30" class="on">30d</button></div></div>
      <canvas class="chart" id="trendChart"></canvas>
      <p class="muted small">Sleep hours (blue), soreness 1–5 (amber), stress 1–5 (red). Trends matter more than any single day.</p>
      <div id="notesLog"></div>
    </div>`;

  function scale(label, id, val) {
    return `<label class="field"><span>${label} (1 = great, 5 = rough)</span>
      <div class="scale-picker" id="${id}">${[1, 2, 3, 4, 5].map(n => `<button type="button" data-v="${n}" class="${n === val ? 'on' : ''}">${n}</button>`).join('')}</div></label>`;
  }
  const pick = (id) => {
    const box = el.querySelector(`#${id}`);
    box.querySelectorAll('button').forEach(b => b.onclick = () => {
      box.querySelectorAll('button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
    });
    return () => Number(box.querySelector('.on')?.dataset.v || 3);
  };
  const getQ = pick('quality'), getSo = pick('soreness'), getSt = pick('stress');
  el.querySelector('#sleep').addEventListener('input', (e) => el.querySelector('#sleepVal').textContent = e.target.value);

  el.querySelector('#save').onclick = async () => {
    try {
      const res = await api('/wellness/checkin', {
        method: 'POST',
        body: {
          sleepHours: Number(el.querySelector('#sleep').value),
          sleepQuality: getQ(), sorenessLevel: getSo(), stressLevel: getSt(),
          restingNotes: el.querySelector('#notes').value,
        },
      });
      toast(res.edited ? 'Check-in updated.' : 'Checked in — nice habit.', 'success');
      loadTrend(30);
    } catch (e) { toast(e.message, 'error'); }
  };

  async function loadTrend(days) {
    try {
      const { checkins } = await api(`/wellness/trend?days=${days}`);
      const pts = (f, max) => ({ points: checkins.map(c => ({ y: c[f] })), max });
      drawTrend(el.querySelector('#trendChart'), [
        { label: 'sleep h', color: '#38bdf8', ...pts('sleep_hours', 12) },
        { label: 'soreness', color: '#fbbf24', ...pts('soreness_level', 5) },
        { label: 'stress', color: '#f87171', ...pts('stress_level', 5) },
      ]);
      const noted = checkins.filter(c => c.resting_notes);
      el.querySelector('#notesLog').innerHTML = noted.length
        ? `<details class="mt"><summary class="small muted">Notes (${noted.length})</summary>${noted.map(c => `<div class="small"><strong>${esc(c.date)}</strong> — ${esc(c.resting_notes)}</div>`).join('')}</details>` : '';
    } catch { /* offline */ }
  }
  el.querySelector('#d7').onclick = (e) => { swap(e); loadTrend(7); };
  el.querySelector('#d30').onclick = (e) => { swap(e); loadTrend(30); };
  const swap = (e) => { el.querySelectorAll('.seg button').forEach(b => b.classList.remove('on')); e.target.classList.add('on'); };
  loadTrend(30);
}
