const LOG_KEY = 'dayscore_error_logs';
const MAX_LOG_ENTRIES = 500;
const MAX_LOG_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function formatNow() {
  const now = new Date();
  return now.toISOString().replace('T', ' ').slice(0, 19);
}

function loadLogs() {
  try {
    return JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
  } catch (e) {
    return [];
  }
}

function saveLogs(logs) {
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(logs));
  } catch (e) {
    console.warn('Failed to save logs:', e);
  }
}

function pruneLogs(logs) {
  const now = Date.now();
  const fresh = logs.filter(log => now - log.ts < MAX_LOG_AGE_MS);
  if (fresh.length > MAX_LOG_ENTRIES) {
    return fresh.slice(fresh.length - MAX_LOG_ENTRIES);
  }
  return fresh;
}

export function logInfo(category, message, detail) {
  const log = {
    ts: Date.now(),
    level: 'INFO',
    cat: category,
    msg: message,
    detail: detail
  };
  console.log(`[${formatNow()}] [INFO] [${category}] ${message}`, detail || '');
  
  let logs = loadLogs();
  logs.push(log);
  logs = pruneLogs(logs);
  saveLogs(logs);
}

export function logWarn(category, message, detail) {
  const log = {
    ts: Date.now(),
    level: 'WARN',
    cat: category,
    msg: message,
    detail: detail
  };
  console.warn(`[${formatNow()}] [WARN] [${category}] ${message}`, detail || '');
  
  let logs = loadLogs();
  logs.push(log);
  logs = pruneLogs(logs);
  saveLogs(logs);
}

export function logError(category, message, error) {
  const detail = error instanceof Error ? `${error.code || error.name}: ${error.message}` : String(error);
  const log = {
    ts: Date.now(),
    level: 'ERROR',
    cat: category,
    msg: message,
    detail: detail
  };
  console.error(`[${formatNow()}] [ERROR] [${category}] ${message}`, error);
  
  let logs = loadLogs();
  logs.push(log);
  logs = pruneLogs(logs);
  saveLogs(logs);
}

export function exportLogs() {
  const logs = loadLogs();
  const lines = logs.map(log => {
    const time = new Date(log.ts).toISOString().replace('T', ' ').slice(0, 19);
    const detail = log.detail ? ` | ${log.detail}` : '';
    return `${time} [${log.level}] [${log.cat}] ${log.msg}${detail}`;
  });
  return lines.join('\n');
}

export function clearLogs() {
  localStorage.removeItem(LOG_KEY);
}

export function getLogCount() {
  return loadLogs().length;
}
