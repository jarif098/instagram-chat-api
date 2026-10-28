'use strict';

/**
 * Sanitizing Logger for InstaChat API
 * Automatically scrubs sensitive tokens, cookies, sessionids, and passwords from logs.
 */

// Patterns to scrub
const SENSITIVE_KEYS = [
  'cookie',
  'cookies',
  'cookiestring',
  'sessionid',
  'csrftoken',
  'x-csrftoken',
  '_csrftoken',
  'authorization',
  'password',
  'pass',
  'secret',
  'token'
];

function sanitizeString(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/(sessionid=)[^;,\s]+/gi, '$1[REDACTED]')
    .replace(/(csrftoken=)[^;,\s]+/gi, '$1[REDACTED]')
    .replace(/("sessionid":\s*")[^"]+(")/gi, '$1[REDACTED]$2')
    .replace(/("csrftoken":\s*")[^"]+(")/gi, '$1[REDACTED]$2')
    .replace(/("password":\s*")[^"]+(")/gi, '$1[REDACTED]$2')
    .replace(/("token":\s*")[^"]+(")/gi, '$1[REDACTED]$2');
}

function sanitizeObject(obj, seen = new WeakSet()) {
  if (obj === null || typeof obj !== 'object') {
    return typeof obj === 'string' ? sanitizeString(obj) : obj;
  }

  if (seen.has(obj)) {
    return '[Circular]';
  }
  seen.add(obj);

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeObject(item, seen));
  }

  const sanitized = {};
  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_KEYS.some((sensitive) => lowerKey.includes(sensitive))) {
      sanitized[key] = '[REDACTED]';
    } else {
      sanitized[key] = sanitizeObject(value, seen);
    }
  }
  return sanitized;
}

class Logger {
  constructor(options = {}) {
    this.debugEnabled = Boolean(options.debug);
    this.prefix = options.prefix || '[InstaChat]';
    this.writer = typeof options.writer === 'function' ? options.writer : null;
  }

  setDebug(enabled) {
    this.debugEnabled = Boolean(enabled);
  }

  _output(level, consoleMethod, ...args) {
    const sanitized = args.map((arg) => {
      if (arg instanceof Error) {
        const cleanMsg = sanitizeString(arg.message);
        const cleanStack = sanitizeString(arg.stack || '');
        const err = new Error(cleanMsg);
        err.stack = cleanStack;
        return err;
      }
      return typeof arg === 'object' ? sanitizeObject(arg) : sanitizeString(String(arg));
    });

    if (this.writer) {
      const msg = sanitized
        .map((s) => (s instanceof Error ? s.toString() : typeof s === 'object' ? JSON.stringify(s) : String(s)))
        .join(' ');
      this.writer(level, `${this.prefix} [${level.toUpperCase()}] ${msg}`);
      return;
    }

    consoleMethod(`${this.prefix} [${level.toUpperCase()}]`, ...sanitized);
  }

  debug(...args) {
    if (!this.debugEnabled) return;
    this._output('debug', console.debug, ...args);
  }

  info(...args) {
    this._output('info', console.log, ...args);
  }

  warn(...args) {
    this._output('warn', console.warn, ...args);
  }

  error(...args) {
    this._output('error', console.error, ...args);
  }
}

module.exports = {
  Logger,
  sanitizeString,
  sanitizeObject
};
