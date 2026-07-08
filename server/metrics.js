// In-process API usage metrics for the admin System tab. Deliberately
// in-memory: counters reset on restart (labeled as such in the UI), which
// keeps the hot path allocation-free and avoids unbounded telemetry tables.
const startedAt = Date.now();

const counters = {
  totalRequests: 0,
  errors4xx: 0,
  errors5xx: 0,
  byGroup: {}, // first path segment under /api → count
  totalLatencyMs: 0,
  maxLatencyMs: 0,
  slowRequests: 0, // requests over 1s — a signal worth surfacing
};

export function metricsMiddleware(req, res, next) {
  counters.totalRequests++;
  const group = (req.path.split('/')[2] || 'root').slice(0, 24);
  counters.byGroup[group] = (counters.byGroup[group] || 0) + 1;
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    counters.totalLatencyMs += ms;
    if (ms > counters.maxLatencyMs) counters.maxLatencyMs = ms;
    if (ms > 1000) counters.slowRequests++;
    if (res.statusCode >= 500) counters.errors5xx++;
    else if (res.statusCode >= 400) counters.errors4xx++;
  });
  next();
}

export function metricsSnapshot() {
  const mem = process.memoryUsage();
  return {
    startedAt: Math.floor(startedAt / 1000),
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    ...counters,
    avgLatencyMs: counters.totalRequests ? Math.round((counters.totalLatencyMs / counters.totalRequests) * 10) / 10 : 0,
    maxLatencyMs: Math.round(counters.maxLatencyMs),
    byGroup: { ...counters.byGroup },
    memory: {
      rssMb: Math.round(mem.rss / 1048576),
      heapUsedMb: Math.round(mem.heapUsed / 1048576),
      heapTotalMb: Math.round(mem.heapTotal / 1048576),
    },
    nodeVersion: process.version,
  };
}
