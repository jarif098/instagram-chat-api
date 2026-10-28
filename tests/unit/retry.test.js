'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { withRetry } = require('../../src/utils/retry');
const { AuthenticationError, ValidationError } = require('../../src/utils/errors');

test('withRetry: successfully executes idempotent operation on first try', async () => {
  let count = 0;
  const result = await withRetry(async () => {
    count++;
    return 'ok';
  });

  assert.equal(result, 'ok');
  assert.equal(count, 1);
});

test('withRetry: retries on retryable network error and succeeds', async () => {
  let count = 0;
  const result = await withRetry(
    async () => {
      count++;
      if (count < 3) {
        const err = new Error('ECONNRESET');
        err.code = 'ECONNRESET';
        throw err;
      }
      return 'recovered';
    },
    { maxRetries: 3, baseDelayMs: 10 }
  );

  assert.equal(result, 'recovered');
  assert.equal(count, 3);
});

test('withRetry: fails immediately on non-retryable error without retrying', async () => {
  let count = 0;
  await assert.rejects(
    async () => {
      await withRetry(
        async () => {
          count++;
          throw new AuthenticationError('Session expired');
        },
        { maxRetries: 3, baseDelayMs: 10 }
      );
    },
    AuthenticationError
  );

  assert.equal(count, 1);
});
