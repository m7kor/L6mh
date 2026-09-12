/**
 * Structured logger with console + optional JSON output.
 *
 * Default: coloured scope-tagged console output (development).
 * Set LOG_FORMAT=json for machine-parseable JSON lines (production).
 * Preserve the same createLogger(scope) API so no call sites change.
 */
const COLORS = {
    bot: '\x1b[36m',
    audio: '\x1b[35m',
    youtube: '\x1b[33m',
    config: '\x1b[31m',
    heartbeat: '\x1b[32m',
    webhook: '\x1b[37m',
    status: '\x1b[96m',
};
const RESET = '\x1b[0m';
const jsonMode = process.env.LOG_FORMAT === 'json';
function timestamp() {
    return new Date().toISOString();
}
function timestampPretty() {
    return new Date().toISOString().replace('T', ' ').split('.')[0];
}
function write(scope, level, args) {
    if (jsonMode) {
        const msg = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
        const entry = { ts: timestamp(), level, scope, msg };
        if (level === 'error')
            console.error(JSON.stringify(entry));
        else if (level === 'warn')
            console.warn(JSON.stringify(entry));
        else
            console.log(JSON.stringify(entry));
    }
    else {
        const color = COLORS[scope] || '\x1b[37m';
        const prefix = `${color}[${scope}]${RESET} ${timestampPretty()}`;
        const method = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
        method(prefix, ...args);
    }
}
export function createLogger(scope) {
    return {
        info: (...args) => write(scope, 'info', args),
        warn: (...args) => write(scope, 'warn', args),
        error: (...args) => write(scope, 'error', args),
    };
}
