// Minimal structured logger. One place to control log output for the whole
// server; keeps timestamps + subsystem tags consistent and is trivially
// swappable for pino/winston later without touching call sites.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.ROWPOINT_LOG_LEVEL] ?? LEVELS.info;

function emit(level, tag, msg, extra) {
  if (LEVELS[level] < threshold) return;
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] [${tag}] ${msg}`;
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  if (extra !== undefined) fn(line, extra);
  else fn(line);
}

export function logger(tag) {
  return {
    debug: (msg, extra) => emit('debug', tag, msg, extra),
    info: (msg, extra) => emit('info', tag, msg, extra),
    warn: (msg, extra) => emit('warn', tag, msg, extra),
    error: (msg, extra) => emit('error', tag, msg, extra),
  };
}
