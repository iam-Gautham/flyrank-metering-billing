/**
 * Structured Operational Logger with secret redaction and safe log formatting.
 */

const SENSITIVE_KEYS = ['password', 'secret', 'token', 'authorization', 'api_key', 'apikey', 'credit_card'];

/**
 * Recursively redacts sensitive values from log metadata objects.
 */
function redactObject(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(redactObject);

  const clean = {};
  for (const [key, val] of Object.entries(obj)) {
    const isSensitive = SENSITIVE_KEYS.some((s) => key.toLowerCase().includes(s));
    if (isSensitive) {
      clean[key] = '[REDACTED]';
    } else if (typeof val === 'object' && val !== null) {
      clean[key] = redactObject(val);
    } else {
      clean[key] = val;
    }
  }
  return clean;
}

function formatLog(level, component, message, meta = null) {
  const timestamp = new Date().toISOString();
  const cleanMeta = meta ? redactObject(meta) : null;
  return JSON.stringify({
    timestamp,
    level,
    component,
    message,
    ...(cleanMeta ? { meta: cleanMeta } : {}),
  });
}

const logger = {
  info: (component, message, meta) => {
    console.log(formatLog('INFO', component, message, meta));
  },
  warn: (component, message, meta) => {
    console.warn(formatLog('WARN', component, message, meta));
  },
  error: (component, message, meta) => {
    console.error(formatLog('ERROR', component, message, meta));
  },
  redactObject,
};

module.exports = logger;
