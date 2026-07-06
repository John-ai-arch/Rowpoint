// Lightweight canvas charts: per-stroke force curve (§6), split bars, and
// wellness trend lines (§12.2). High-contrast, no color-only encoding (§14).
function setup(canvas, heightCss = 160) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.parentElement?.clientWidth || 600;
  canvas.width = w * dpr;
  canvas.height = heightCss * dpr;
  canvas.style.height = `${heightCss}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, heightCss);
  return { ctx, w, h: heightCss };
}

const COL = { line: '#38bdf8', fill: 'rgba(56,189,248,.18)', grid: '#27395e', text: '#9db0cf', ghost: 'rgba(157,176,207,.4)', good: '#34d399' };

export function drawForceCurve(canvas, samples, { ghost = null, label = '' } = {}) {
  const { ctx, w, h } = setup(canvas, 170);
  const pad = 10;
  const all = [...(samples || []), ...(ghost || [])];
  const max = Math.max(...all, 1);
  const plot = (data, stroke, fill) => {
    if (!data?.length) return;
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = pad + (i / (data.length - 1)) * (w - pad * 2);
      const y = h - pad - (v / max) * (h - pad * 2 - 14);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.strokeStyle = stroke; ctx.lineWidth = 2.5; ctx.stroke();
    if (fill) {
      ctx.lineTo(w - pad, h - pad); ctx.lineTo(pad, h - pad); ctx.closePath();
      ctx.fillStyle = fill; ctx.fill();
    }
  };
  plot(ghost, COL.ghost, null);
  plot(samples, COL.line, COL.fill);
  ctx.fillStyle = COL.text; ctx.font = '11px sans-serif';
  ctx.fillText(label || 'Force → drive position', pad, 12);
}

export function drawSplitBars(canvas, splits) {
  const { ctx, w, h } = setup(canvas, 180);
  const pad = { l: 44, r: 8, t: 14, b: 20 };
  const paces = splits.map(s => s.avg_pace_s_per_500m).filter(Number.isFinite);
  if (!paces.length) return;
  const min = Math.min(...paces) - 2, max = Math.max(...paces) + 2;
  const bw = (w - pad.l - pad.r) / splits.length;
  // gridlines
  ctx.strokeStyle = COL.grid; ctx.fillStyle = COL.text; ctx.font = '10px sans-serif'; ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const v = min + (max - min) * (i / 3);
    const y = pad.t + ((v - min) / (max - min)) * (h - pad.t - pad.b); // inverted: faster (lower s) at top
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    const mm = Math.floor(v / 60), ss = Math.round(v % 60);
    ctx.fillText(`${mm}:${String(ss).padStart(2, '0')}`, 4, y + 3);
  }
  splits.forEach((s, i) => {
    if (!Number.isFinite(s.avg_pace_s_per_500m)) return;
    const frac = (s.avg_pace_s_per_500m - min) / (max - min);
    const y = pad.t + frac * (h - pad.t - pad.b);
    const x = pad.l + i * bw + 2;
    ctx.fillStyle = COL.line;
    ctx.fillRect(x, y, Math.max(bw - 4, 2), h - pad.b - y);
  });
  ctx.fillStyle = COL.text;
  ctx.fillText('splits (lower bar top = faster)', pad.l, 10);
}

// Heart-rate time series with training-zone bands as the background (§HR).
// zoneBounds: 5 ascending bpm thresholds; zoneColors: 5 colors.
export function drawHrSeries(canvas, series, { maxHr = 190, zoneBounds = [], zoneColors = [], paceOverlay = null, height = 190 } = {}) {
  const { ctx, w, h } = setup(canvas, height);
  const pad = { l: 34, r: paceOverlay ? 44 : 8, t: 10, b: 16 };
  if (!series?.length) { ctx.fillStyle = COL.text; ctx.fillText('No heart rate data', pad.l, 20); return; }
  const tMax = series[series.length - 1][0] || 1;
  const bpms = series.map(([, b]) => b);
  const yMin = Math.max(Math.min(...bpms) - 12, 30);
  // Scale to the DATA (plus headroom), not to max HR — a Z2 row should fill
  // the chart, with zone bands above the data range simply cropped out.
  const yMax = Math.min(Math.max(...bpms) + 15, 230);
  const X = (t) => pad.l + (t / tMax) * (w - pad.l - pad.r);
  const Y = (bpm) => h - pad.b - ((bpm - yMin) / (yMax - yMin)) * (h - pad.t - pad.b);

  // zone background bands
  const bands = [...zoneBounds, yMax];
  let lo = yMin;
  for (let z = 0; z < 5 && z < zoneColors.length; z++) {
    const hi = Math.min(Math.max(bands[z + 1] ?? yMax, lo), yMax);
    if (hi > lo) {
      ctx.fillStyle = zoneColors[z] + '22';
      ctx.fillRect(pad.l, Y(hi), w - pad.l - pad.r, Y(lo) - Y(hi));
    }
    lo = hi;
  }
  // HR line
  ctx.beginPath();
  series.forEach(([t, bpm], i) => { i ? ctx.lineTo(X(t), Y(bpm)) : ctx.moveTo(X(t), Y(bpm)); });
  ctx.strokeStyle = '#f87171'; ctx.lineWidth = 2.2; ctx.stroke();
  // axes labels
  ctx.fillStyle = COL.text; ctx.font = '10px sans-serif';
  for (const v of [yMin + 10, Math.round((yMin + yMax) / 2), yMax - 10]) ctx.fillText(String(Math.round(v)), 4, Y(v) + 3);
  ctx.fillText('bpm over workout time', pad.l, h - 4);
  // optional pace overlay (lower = faster, drawn inverted, right axis)
  if (paceOverlay?.length) {
    const paces = paceOverlay.map(p => p.pace).filter(Number.isFinite);
    if (paces.length >= 2) {
      const pMin = Math.min(...paces) - 2, pMax = Math.max(...paces) + 2;
      const YP = (p) => pad.t + ((p - pMin) / (pMax - pMin)) * (h - pad.t - pad.b);
      ctx.beginPath();
      paceOverlay.forEach((p, i) => { const x = X(p.t); const y = YP(p.pace); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.strokeStyle = COL.line; ctx.lineWidth = 1.8; ctx.setLineDash([5, 4]); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = COL.line; ctx.fillText('pace (dashed, up = faster)', w - pad.r - 130, 10);
    }
  }
}

export function drawTrend(canvas, seriesList, { height = 160 } = {}) {
  // seriesList: [{ label, color, points: [{x: index, y }] , max }]
  const { ctx, w, h } = setup(canvas, height);
  const pad = { l: 26, r: 8, t: 16, b: 8 };
  let lx = pad.l + 2;
  for (const s of seriesList) {
    const pts = s.points.filter(p => Number.isFinite(p.y));
    if (pts.length < 2) { continue; }
    const maxY = s.max ?? Math.max(...pts.map(p => p.y)) * 1.15;
    const n = s.points.length;
    ctx.beginPath();
    let started = false;
    s.points.forEach((p, i) => {
      if (!Number.isFinite(p.y)) return;
      const x = pad.l + (i / Math.max(n - 1, 1)) * (w - pad.l - pad.r);
      const y = h - pad.b - (p.y / maxY) * (h - pad.t - pad.b);
      started ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      started = true;
    });
    ctx.strokeStyle = s.color; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = s.color; ctx.font = 'bold 11px sans-serif';
    ctx.fillText(s.label, lx, 12);
    lx += ctx.measureText(s.label).width + 14;
  }
}
