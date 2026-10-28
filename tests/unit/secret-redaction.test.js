'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Logger, sanitizeString, sanitizeObject } = require('../../src/utils/logger');

test('sanitizeString: redacts sessionid and csrftoken from strings', () => {
  const raw = 'Cookie: sessionid=65842145265%3Asecret123; csrftoken=tok_abc456; ds_user_id=65842145265';
  const clean = sanitizeString(raw);
  assert.equal(clean.includes('secret123'), false);
  assert.equal(clean.includes('tok_abc456'), false);
  assert.equal(clean.includes('[REDACTED]'), true);
  assert.equal(clean.includes('65842145265'), true);
});

test('sanitizeObject: redacts sensitive keys from objects and nested structures', () => {
  const obj = {
    sessionid: 'secret_1',
    csrftoken: 'secret_2',
    authorization: 'Bearer secret_3',
    nested: {
      password: 'mypassword',
      token: 'tok_1',
      publicInfo: 'hello'
    }
  };

  const sanitized = sanitizeObject(obj);
  assert.equal(sanitized.sessionid, '[REDACTED]');
  assert.equal(sanitized.csrftoken, '[REDACTED]');
  assert.equal(sanitized.authorization, '[REDACTED]');
  assert.equal(sanitized.nested.password, '[REDACTED]');
  assert.equal(sanitized.nested.token, '[REDACTED]');
  assert.equal(sanitized.nested.publicInfo, 'hello');
});

test('Logger: formats without throwing and masks errors', () => {
  const logs = [];
  const logger = new Logger({
    debug: true,
    prefix: '[Test]',
    writer: (level, msg) => logs.push({ level, msg })
  });

  logger.info('Connected with sessionid=12345abcdef');
  logger.debug('Debug trace');
  logger.error('Error occurred:', new Error('Invalid csrftoken=tok_secret'));

  assert.equal(logs.length, 3);
  assert.equal(logs[0].msg.includes('12345abcdef'), false);
  assert.equal(logs[2].msg.includes('tok_secret'), false);
});
