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

// Scatter plot for the analytics lab: relationships like pace-vs-stroke-rate or
// HR-vs-split. Points may carry their own colour (e.g. by training zone).
export function drawScatter(canvas, points, { xLabel = '', yLabel = '', xInvert = false, yInvert = false, color = '#38bdf8', height = 200 } = {}) {
  const { ctx, w, h } = setup(canvas, height);
  const pad = { l: 42, r: 10, t: 14, b: 22 };
  const valid = points.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (valid.length < 2) { ctx.fillStyle = COL.text; ctx.font = '11px sans-serif'; ctx.fillText('Not enough data yet', pad.l, 30); return; }
  const xs = valid.map(p => p.x), ys = valid.map(p => p.y);
  const xMin = Math.min(...xs), xMax = Math.max(...xs), yMin = Math.min(...ys), yMax = Math.max(...ys);
  const X = (v) => pad.l + ((xInvert ? xMax - v : v - xMin) / ((xMax - xMin) || 1)) * (w - pad.l - pad.r);
  const Y = (v) => pad.t + ((yInvert ? v - yMin : yMax - v) / ((yMax - yMin) || 1)) * (h - pad.t - pad.b);
  ctx.strokeStyle = COL.grid; ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) { const y = pad.t + (i / 3) * (h - pad.t - pad.b); ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke(); }
  for (const p of valid) { ctx.fillStyle = (p.color || color) + 'cc'; ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), 3.4, 0, Math.PI * 2); ctx.fill(); }
  ctx.fillStyle = COL.text; ctx.font = '10px sans-serif';
  if (yLabel) ctx.fillText(yLabel, pad.l, 10);
  if (xLabel) ctx.fillText(xLabel, w - pad.r - ctx.measureText(xLabel).width, h - 4);
}

// Labelled vertical bars (zone distribution, weekly load, …).
export function drawBars(canvas, items, { height = 170, showValue = true } = {}) {
  const { ctx, w, h } = setup(canvas, height);
  const pad = { l: 8, r: 8, t: 12, b: 22 };
  const max = Math.max(...items.map(i => i.value), 1);
  const bw = (w - pad.l - pad.r) / (items.length || 1);
  ctx.textAlign = 'center';
  items.forEach((it, i) => {
    const bh = (it.value / max) * (h - pad.t - pad.b);
    const x = pad.l + i * bw + 3, y = h - pad.b - bh;
    ctx.fillStyle = it.color || COL.line; ctx.fillRect(x, y, Math.max(bw - 6, 2), bh);
    ctx.fillStyle = COL.text; ctx.font = '10px sans-serif';
    ctx.fillText(it.label, x + (bw - 6) / 2, h - 8);
    if (showValue && it.value) ctx.fillText(String(it.value), x + (bw - 6) / 2, y - 3);
  });
  ctx.textAlign = 'left';
}

// Population distribution (histogram) with the viewer's own value marked — the
// core Research Observatory visual. `hist` = { min, max, bins:[{x0,x1,count}] }.
export function drawDistribution(canvas, hist, marker, { color = '#38bdf8', markerColor = '#f472b6', height = 170, fmt = (v) => Math.round(v) } = {}) {
  const { ctx, w, h } = setup(canvas, height);
  const pad = { l: 8, r: 8, t: 16, b: 20 };
  if (!hist || !hist.bins?.length) { ctx.fillStyle = COL.text; ctx.font = '11px sans-serif'; ctx.fillText('Not enough data yet', pad.l, 30); return; }
  const max = Math.max(...hist.bins.map(b => b.count), 1);
  const bw = (w - pad.l - pad.r) / hist.bins.length;
  hist.bins.forEach((b, i) => {
    const bh = (b.count / max) * (h - pad.t - pad.b);
    ctx.fillStyle = color + 'cc';
    ctx.fillRect(pad.l + i * bw + 1, h - pad.b - bh, Math.max(bw - 2, 1), bh);
  });
  if (Number.isFinite(marker) && hist.max > hist.min) {
    const frac = Math.max(0, Math.min(1, (marker - hist.min) / (hist.max - hist.min)));
    const mx = pad.l + frac * (w - pad.l - pad.r);
    ctx.strokeStyle = markerColor; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(mx, pad.t - 4); ctx.lineTo(mx, h - pad.b); ctx.stroke();
    ctx.fillStyle = markerColor; ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('you', mx, pad.t - 6); ctx.textAlign = 'left';
  }
  ctx.fillStyle = COL.text; ctx.font = '10px sans-serif';
  ctx.fillText(fmt(hist.min), pad.l, h - 5);
  const hi = fmt(hist.max); ctx.fillText(hi, w - pad.r - ctx.measureText(hi).width, h - 5);
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
