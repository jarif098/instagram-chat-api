'use strict';

const Session = require('./session');
const { ValidationError } = require('../utils/errors');

/**
 * Creates a Session instance from a raw cookie string (e.g. copied from DevTools).
 *
 * @param {string} cookieString - e.g. "sessionid=...; csrftoken=...; ds_user_id=..."
 * @param {Object} [options]
 * @returns {Session}
 */
function createSessionFromCookieString(cookieString, options = {}) {
  if (typeof cookieString !== 'string' || !cookieString.trim()) {
    throw new ValidationError('Cookie string must be a non-empty string');
  }

  const cookies = Session.parseCookieString(cookieString);
  const session = new Session(options);
  session.load({
    userId: cookies.ds_user_id || options.userId || null,
    cookies,
    createdAt: new Date().toISOString()
  });

  return session;
}

/**
 * Creates a Session instance from an object of cookie key-values.
 *
 * @param {Object} cookieMap - e.g. { sessionid: '...', csrftoken: '...', ds_user_id: '...' }
 * @param {Object} [options]
 * @returns {Session}
 */
function createSessionFromCookies(cookieMap, options = {}) {
  if (typeof cookieMap !== 'object' || cookieMap === null) {
    throw new ValidationError('Cookie map must be a valid object');
  }

  const session = new Session(options);
  session.load({
    userId: cookieMap.ds_user_id || options.userId || null,
    cookies: cookieMap,
    createdAt: new Date().toISOString()
  });

  return session;
}

module.exports = {
  createSessionFromCookieString,
  createSessionFromCookies
};
