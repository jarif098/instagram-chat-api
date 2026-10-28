'use strict';

/**
 * Smart Exponential Backoff Retry Utility
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Determines whether an error is transient and safe to retry.
 * Only idempotent methods or safe read calls should be retried automatically.
 */
function isRetryableError(error, isIdempotent = true) {
  if (!error) return false;

  // Never retry authentication errors or explicit client validation errors
  if (error.code === 'AUTH_ERROR' || error.code === 'VALIDATION_ERROR' || error.code === 'UNSUPPORTED_FEATURE') {
    return false;
  }

  // Network timeouts or connection drops
  if (error.isTimeout || ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNABORTED'].includes(error.code)) {
    return isIdempotent;
  }

  const status = error.status || (error.response && error.response.status);

  // Rate limiting (429) can be retried if Retry-After is respected
  if (status === 429) {
    return true;
  }

  // Server errors (500, 502, 503, 504) are transient
  if (status >= 500 && status <= 599) {
    return isIdempotent;
  }

  return false;
}

/**
 * Executes an async operation with exponential backoff and jitter.
 *
 * @param {Function} fn - Async operation to execute
 * @param {Object} options
 * @param {number} options.maxRetries - Maximum retry attempts
 * @param {number} options.baseDelayMs - Initial delay in ms
 * @param {number} options.maxDelayMs - Maximum delay cap in ms
 * @param {boolean} options.isIdempotent - Whether operation is safe to retry on failure
 * @param {Object} [options.logger] - Optional logger instance
 */
async function withRetry(fn, options = {}) {
  const maxRetries = options.maxRetries !== undefined ? options.maxRetries : 2;
  const baseDelayMs = options.baseDelayMs || 1000;
  const maxDelayMs = options.maxDelayMs || 10000;
  const isIdempotent = options.isIdempotent !== undefined ? options.isIdempotent : true;
  const logger = options.logger;

  let attempt = 0;

  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;

      if (attempt > maxRetries || !isRetryableError(err, isIdempotent)) {
        throw err;
      }

      // Check if server specified Retry-After
      let delayMs = baseDelayMs * Math.pow(2, attempt - 1);
      if (err.retryAfter && typeof err.retryAfter === 'number' && err.retryAfter > 0) {
        delayMs = err.retryAfter * 1000;
      } else {
        // Add full jitter (0 to 50% random jitter)
        const jitter = Math.random() * (delayMs * 0.5);
        delayMs = Math.min(maxDelayMs, delayMs + jitter);
      }

      if (logger && typeof logger.debug === 'function') {
        logger.debug(`Retry attempt ${attempt}/${maxRetries} after ${Math.round(delayMs)}ms. Reason: ${err.message}`);
      }

      await sleep(delayMs);
    }
  }
}

module.exports = {
  sleep,
  isRetryableError,
  withRetry
};
