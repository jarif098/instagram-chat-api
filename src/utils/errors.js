'use strict';

/**
 * Base error class for all InstaChat API errors.
 */
class InstaChatError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = options.code || 'INSTACHAT_ERROR';
    this.status = options.status || null;
    this.details = options.details || null;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Authentication error (expired session, invalid cookies, checkpoint required, MFA).
 */
class AuthenticationError extends InstaChatError {
  constructor(message, options = {}) {
    super(message, { ...options, code: options.code || 'AUTH_ERROR' });
    this.checkpointRequired = Boolean(options.checkpointRequired);
    this.checkpointUrl = options.checkpointUrl || null;
  }
}

/**
 * Rate limit / action block error.
 */
class RateLimitError extends InstaChatError {
  constructor(message, options = {}) {
    super(message, { ...options, code: options.code || 'RATE_LIMIT_ERROR', status: options.status || 429 });
    this.retryAfter = options.retryAfter || null;
    this.feedbackRequired = Boolean(options.feedbackRequired);
  }
}

/**
 * Network / connectivity / timeout error.
 */
class NetworkError extends InstaChatError {
  constructor(message, options = {}) {
    super(message, { ...options, code: options.code || 'NETWORK_ERROR' });
    this.isTimeout = Boolean(options.isTimeout);
  }
}

/**
 * Validation error (invalid arguments, illegal file types, oversize limits).
 */
class ValidationError extends InstaChatError {
  constructor(message, options = {}) {
    super(message, { ...options, code: options.code || 'VALIDATION_ERROR' });
    this.field = options.field || null;
  }
}

/**
 * Unsupported feature error (e.g. End-to-End Encrypted chats, unavailable web features).
 */
class UnsupportedFeatureError extends InstaChatError {
  constructor(message, options = {}) {
    super(message, { ...options, code: options.code || 'UNSUPPORTED_FEATURE' });
    this.feature = options.feature || null;
  }
}

/**
 * Not found error (thread not found, message item not found).
 */
class NotFoundError extends InstaChatError {
  constructor(message, options = {}) {
    super(message, { ...options, code: options.code || 'NOT_FOUND', status: 404 });
    this.resourceId = options.resourceId || null;
  }
}

module.exports = {
  InstaChatError,
  AuthenticationError,
  RateLimitError,
  NetworkError,
  ValidationError,
  UnsupportedFeatureError,
  NotFoundError
};
