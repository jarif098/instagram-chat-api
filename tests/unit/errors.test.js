'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  InstaChatError,
  AuthenticationError,
  ValidationError,
  NotFoundError,
  RateLimitError,
  NetworkError,
  UnsupportedFeatureError
} = require('../../src/utils/errors');

test('Error hierarchy: inherits from InstaChatError and maintains custom properties', () => {
  const base = new InstaChatError('Base error', { code: 'BASE', details: { foo: 'bar' } });
  assert.equal(base instanceof Error, true);
  assert.equal(base instanceof InstaChatError, true);
  assert.equal(base.code, 'BASE');
  assert.deepEqual(base.details, { foo: 'bar' });

  const auth = new AuthenticationError('Session expired', { code: 'SESSION_EXPIRED' });
  assert.equal(auth instanceof InstaChatError, true);
  assert.equal(auth instanceof AuthenticationError, true);
  assert.equal(auth.code, 'SESSION_EXPIRED');

  const val = new ValidationError('Bad param', { field: 'threadId' });
  assert.equal(val instanceof ValidationError, true);
  assert.equal(val.field, 'threadId');

  const notFound = new NotFoundError('Thread not found', { resourceId: '123' });
  assert.equal(notFound instanceof NotFoundError, true);
  assert.equal(notFound.resourceId, '123');

  const rate = new RateLimitError('Too many requests', { retryAfter: 30 });
  assert.equal(rate instanceof RateLimitError, true);
  assert.equal(rate.retryAfter, 30);

  const net = new NetworkError('Connection timeout', { status: 504 });
  assert.equal(net instanceof NetworkError, true);
  assert.equal(net.status, 504);

  const unsupp = new UnsupportedFeatureError('E2EE unsupported', { feature: 'E2EE' });
  assert.equal(unsupp instanceof UnsupportedFeatureError, true);
  assert.equal(unsupp.feature, 'E2EE');
});
