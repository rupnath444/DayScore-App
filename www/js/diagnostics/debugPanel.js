import { pushLog } from './logBuffer.js';

export function logDiag(level, message, meta = {}) {
	pushLog({ level, message, meta });
}

