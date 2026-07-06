// In-process API usage metrics for the admin System tab. Deliberately
// in-memory: counters reset on restart (labeled as such in the UI), which
// keeps the hot path allocation-free and avoids unbounded telemetry tables.
const startedAt = Date.now();

const counters = {
  totalRequests: 0,
  errors4xx: 0,
  errors5xx: 0,
  byGroup: {}, // first path segment under /api → count
};

export function metricsMiddleware(req, res, next) {
  counters.totalRequests++;
  const group = (req.path.split('/')[2] || 'root').slice(0, 24);
  counters.byGroup[group] = (counters.byGroup[group] || 0) + 1;
  res.on('finish', () => {
    if (res.statusCode >= 500) counters.errors5xx++;
    else if (res.statusCode >= 400) counters.errors4xx++;
  });
  next();
}

export function metricsSnapshot() {
  return {
    startedAt: Math.floor(startedAt / 1000),
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    ...counters,
    byGroup: { ...counters.byGroup },
    memory: {
      rssMb: Math.round(process.memoryUsage().rss / 1048576),
      heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1048576),
    },
    nodeVersion: process.version,
  };
}
