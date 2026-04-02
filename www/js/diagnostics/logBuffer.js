const MAX_LOG_ENTRIES = 300;
const logs = [];

export function pushLog(entry) {
  logs.push({ ts: Date.now(), ...entry });
  if (logs.length > MAX_LOG_ENTRIES) logs.splice(0, logs.length - MAX_LOG_ENTRIES);
}

export function getLogs() {
  return logs.slice();
}
