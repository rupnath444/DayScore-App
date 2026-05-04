const LOG_KEY = 'dayscore_error_logs';
const MAX_LOG_ENTRIES = 500;
const MAX_LOG_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const LEVEL_ORDER = { INFO: 1, WARN: 2, ERROR: 3 };

function makeLogId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeLogs(logs) {
  let changed = false;
  const normalized = (Array.isArray(logs) ? logs : []).map((log, idx) => {
    if (!log || typeof log !== 'object') {
      changed = true;
      return null;
    }
    const out = { ...log };
    if (!out.id) {
      out.id = `legacy-${out.ts || Date.now()}-${idx}`;
      changed = true;
    }
    if (!out.level) {
      out.level = 'INFO';
      changed = true;
    }
    if (typeof out.ts !== 'number') {
      out.ts = Date.now();
      changed = true;
    }
    return out;
  }).filter(Boolean);
  return { normalized, changed };
}

function formatNow() {
  const now = new Date();
  return now.toISOString().replace('T', ' ').slice(0, 19);
}

function loadLogs() {
  try {
    const parsed = JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
    const { normalized, changed } = normalizeLogs(parsed);
    if (changed) {
      saveLogs(normalized);
    }
    return normalized;
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
    id: makeLogId(),
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
    id: makeLogId(),
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
    id: makeLogId(),
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

export function getPendingLogsForUpload(limit = 25, minLevel = 'WARN') {
  const threshold = LEVEL_ORDER[String(minLevel || 'WARN').toUpperCase()] || LEVEL_ORDER.WARN;
  const logs = loadLogs();
  const pending = logs.filter(log => {
    const level = LEVEL_ORDER[String(log.level || 'INFO').toUpperCase()] || LEVEL_ORDER.INFO;
    return !log.uploadedAt && level >= threshold;
  });
  if (limit > 0) {
    return pending.slice(0, limit);
  }
  return pending;
}

export function markLogsUploaded(ids) {
  if (!Array.isArray(ids) || !ids.length) return;
  const idSet = new Set(ids.map(String));
  let logs = loadLogs();
  let changed = false;
  const now = Date.now();
  logs = logs.map(log => {
    if (idSet.has(String(log.id)) && !log.uploadedAt) {
      changed = true;
      return { ...log, uploadedAt: now };
    }
    return log;
  });
  if (changed) {
    saveLogs(pruneLogs(logs));
  }
}
