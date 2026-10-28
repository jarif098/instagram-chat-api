'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateConfig } = require('../../src/utils/validators');
const { ValidationError } = require('../../src/utils/errors');

test('validateConfig: validates and accepts valid configuration options', () => {
  const validConfig = {
    sessionPath: './cookie.json',
    pollIntervalMs: 3000,
    requestTimeoutMs: 15000,
    maxRetries: 2,
    debug: false
  };

  assert.doesNotThrow(() => validateConfig(validConfig));
});

test('validateConfig: rejects invalid pollIntervalMs', () => {
  assert.throws(
    () => validateConfig({ pollIntervalMs: 200 }),
    (err) => err instanceof ValidationError && err.message.includes('pollIntervalMs')
  );
});

test('validateConfig: rejects invalid maxRetries', () => {
  assert.throws(
    () => validateConfig({ maxRetries: -1 }),
    (err) => err instanceof ValidationError && err.message.includes('maxRetries')
  );
});

test('validateConfig: rejects invalid requestTimeoutMs', () => {
  assert.throws(
    () => validateConfig({ requestTimeoutMs: 500 }),
    (err) => err instanceof ValidationError && err.message.includes('requestTimeoutMs')
  );
});
