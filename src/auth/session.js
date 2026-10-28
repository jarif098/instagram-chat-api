'use strict';

const fs = require('fs');
const path = require('path');
const { AuthenticationError, ValidationError } = require('../utils/errors');
const { sanitizeObject } = require('../utils/logger');

/**
 * Manages Instagram session tokens, cookie serialization, validation, and persistence.
 */
class Session {
  constructor(options = {}) {
    this.sessionPath = options.sessionPath ? path.resolve(options.sessionPath) : null;
    this.userId = null;
    this.username = null;
    this.cookies = {};
    this.createdAt = null;
    this.expiresAt = null;
    this.logger = options.logger || null;
  }

  /**
   * Loads session from file or credentials object.
   *
   * @param {string|Object} source - File path string or session object
   */
  load(source = this.sessionPath) {
    if (!source) {
      throw new ValidationError('No session path or session object provided to Session.load()');
    }

    let data;
    if (typeof source === 'string') {
      const resolved = path.resolve(source);
      this.sessionPath = resolved;
      if (!fs.existsSync(resolved)) {
        throw new AuthenticationError(
          `Session file not found at ${resolved}. Please run the session extractor or provide valid cookies.`,
          { code: 'SESSION_FILE_NOT_FOUND' }
        );
      }

      try {
        const fileContent = fs.readFileSync(resolved, 'utf-8');
        data = JSON.parse(fileContent);
      } catch (err) {
        throw new AuthenticationError(`Failed to parse session JSON at ${resolved}: ${err.message}`, {
          code: 'INVALID_SESSION_FILE'
        });
      }
    } else if (typeof source === 'object' && source !== null) {
      data = source;
    } else {
      throw new ValidationError('Session source must be a file path string or an object');
    }

    this._populateFromData(data);
    this.validate();

    if (this.logger && typeof this.logger.debug === 'function') {
      this.logger.debug(`Session loaded for User ID: ${this.userId}`);
    }

    return this;
  }

  _populateFromData(data) {
    if (Array.isArray(data)) {
      // Handles browser extensions JSON export (Cookie-Editor, EditThisCookie, etc.):
      // [{ "name": "sessionid", "value": "..." }, ...]
      this.cookies = {};
      for (const item of data) {
        if (item && item.name && item.value !== undefined) {
          this.cookies[item.name] = String(item.value);
        }
      }
    } else if (typeof data === 'object' && data !== null) {
      if (typeof data.cookies === 'object' && data.cookies !== null) {
        if (Array.isArray(data.cookies)) {
          this.cookies = {};
          for (const item of data.cookies) {
            if (item && item.name && item.value !== undefined) {
              this.cookies[item.name] = String(item.value);
            }
          }
        } else {
          this.cookies = { ...data.cookies };
        }
      } else if (typeof data.cookieString === 'string') {
        this.cookies = Session.parseCookieString(data.cookieString);
      } else if (data.sessionid) {
        // Flat cookie dictionary: { sessionid: '...', csrftoken: '...', ds_user_id: '...' }
        this.cookies = { ...data };
      } else {
        this.cookies = {};
      }
    } else {
      this.cookies = {};
    }

    this.userId = (data && data.userId) || this.cookies.ds_user_id || null;
    this.username = (data && data.username) || null;
    this.createdAt = data && data.createdAt ? new Date(data.createdAt) : new Date();
    this.expiresAt = data && data.expiresAt ? new Date(data.expiresAt) : null;
  }

  /**
   * Validates required session cookies.
   */
  validate() {
    if (!this.cookies || typeof this.cookies !== 'object') {
      throw new AuthenticationError('Invalid session: cookies object is missing', { code: 'MISSING_COOKIES' });
    }

    const missing = [];
    if (!this.cookies.sessionid) missing.push('sessionid');
    if (!this.cookies.ds_user_id && !this.userId) missing.push('ds_user_id');

    // Note: if csrftoken is missing in cookies, a temporary dummy or placeholder can be obtained from IG landing page,
    // but in a valid saved web session, csrftoken is standard.
    if (!this.cookies.csrftoken) {
      missing.push('csrftoken');
    }

    if (missing.length > 0) {
      throw new AuthenticationError(
        `Session is missing required cookie(s): ${missing.join(', ')}. Please re-extract your session.`,
        { code: 'INCOMPLETE_SESSION', details: { missing } }
      );
    }

    if (!this.userId && this.cookies.ds_user_id) {
      this.userId = String(this.cookies.ds_user_id);
    }

    return true;
  }

  /**
   * Returns standard serialized Cookie header string.
   */
  getCookieString() {
    return Object.entries(this.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  /**
   * Returns CSRF token.
   */
  getCsrfToken() {
    return this.cookies.csrftoken || '';
  }

  /**
   * Updates cookies from HTTP Set-Cookie headers.
   *
   * @param {string[]|string} setCookieHeaders
   */
  updateFromSetCookie(setCookieHeaders) {
    if (!setCookieHeaders) return false;

    const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    let changed = false;

    for (const header of headers) {
      if (typeof header !== 'string') continue;
      const parts = header.split(';')[0].trim().split('=');
      if (parts.length >= 2) {
        const name = parts[0].trim();
        const value = parts.slice(1).join('=').trim();
        
        // Prevent clearing valid sessionid if server sends an empty/deleted cookie
        if (name === 'sessionid' && (!value || value === '""' || value === 'deleted')) {
          continue;
        }

        if (this.cookies[name] !== value) {
          this.cookies[name] = value;
          changed = true;
          if (name === 'ds_user_id') {
            this.userId = value;
          }
        }
      }
    }

    if (changed && this.sessionPath) {
      this.save(this.sessionPath);
    }

    return changed;
  }

  /**
   * Alias for updateFromSetCookie.
   *
   * @param {string[]|string} setCookieHeaders
   */
  updateFromSetCookieHeader(setCookieHeaders) {
    return this.updateFromSetCookie(setCookieHeaders);
  }

  /**
   * Saves current session to a JSON file.
   *
   * @param {string} [targetPath]
   */
  save(targetPath = this.sessionPath) {
    if (!targetPath) {
      return false;
    }

    const resolved = path.resolve(targetPath);
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const data = {
      userId: this.userId,
      username: this.username,
      cookies: this.cookies,
      cookieString: this.getCookieString(),
      createdAt: this.createdAt ? this.createdAt.toISOString() : new Date().toISOString(),
      expiresAt: this.expiresAt ? this.expiresAt.toISOString() : null
    };

    fs.writeFileSync(resolved, JSON.stringify(data, null, 2), 'utf-8');
    this.sessionPath = resolved;
    return true;
  }

  /**
   * Parses raw cookie string into an object.
   */
  static parseCookieString(str) {
    if (typeof str !== 'string') return {};
    const cookies = {};
    const pairs = str.split(';');
    for (const pair of pairs) {
      const idx = pair.indexOf('=');
      if (idx !== -1) {
        const key = pair.slice(0, idx).trim();
        const val = pair.slice(idx + 1).trim();
        if (key) {
          cookies[key] = val;
        }
      }
    }
    return cookies;
  }

  /**
   * Safely serializes session data for debugging without leaking tokens.
   */
  toSafeJSON() {
    return sanitizeObject({
      userId: this.userId,
      username: this.username,
      hasSessionId: Boolean(this.cookies.sessionid),
      hasCsrfToken: Boolean(this.cookies.csrftoken),
      cookiesCount: Object.keys(this.cookies).length,
      createdAt: this.createdAt,
      expiresAt: this.expiresAt
    });
  }
}

module.exports = Session;
