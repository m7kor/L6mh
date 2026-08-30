/**
 * Minimal scoped logger. Prefixes every line with a colored scope tag
 * and a timestamp, e.g:  [audio] 2026-08-27 20:15:03  Now playing...
 */

const COLORS = {
  bot: '\x1b[36m', // cyan
  audio: '\x1b[35m', // magenta
  youtube: '\x1b[33m', // yellow
  config: '\x1b[31m', // red
};
const RESET = '\x1b[0m';

function timestamp() {
  return new Date().toISOString().replace('T', ' ').split('.')[0];
}

function write(scope, level, args) {
  const color = COLORS[scope] || '\x1b[37m';
  const prefix = `${color}[${scope}]${RESET} ${timestamp()}`;
  const method = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  method(prefix, ...args);
}

export function createLogger(scope) {
  return {
    info: (...args) => write(scope, 'info', args),
    warn: (...args) => write(scope, 'warn', args),
    error: (...args) => write(scope, 'error', args),
  };
}
