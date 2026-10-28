'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  validateThreadId,
  validateMessageId,
  validateTextMessage,
  validateUserId,
  validateUsername,
  validateSearchQuery,
  validateMediaFile
} = require('../../src/utils/validators');
const { ValidationError } = require('../../src/utils/errors');

test('Validators: validateThreadId trims and accepts valid thread IDs', () => {
  assert.equal(validateThreadId(' 123456789 '), '123456789');
  assert.throws(() => validateThreadId(''), ValidationError);
  assert.throws(() => validateThreadId(null), ValidationError);
});

test('Validators: validateMessageId trims and accepts valid message item IDs', () => {
  assert.equal(validateMessageId(' mid.$xyz123 '), 'mid.$xyz123');
  assert.throws(() => validateMessageId(''), ValidationError);
  assert.throws(() => validateMessageId(null), ValidationError);
});

test('Validators: validateTextMessage preserves text and enforces limits', () => {
  assert.equal(validateTextMessage('  hello world  '), '  hello world  ');
  assert.throws(() => validateTextMessage(''), ValidationError);
  assert.throws(() => validateTextMessage('a'.repeat(10001)), ValidationError);
});

test('Validators: validateUserId, validateUsername, and validateSearchQuery', () => {
  assert.equal(validateUserId(' 65842145265 '), '65842145265');
  assert.throws(() => validateUserId(''), ValidationError);

  assert.equal(validateUsername(' @eijah.noah '), 'eijah.noah');
  assert.equal(validateUsername('eijah.noah'), 'eijah.noah');
  assert.throws(() => validateUsername(''), ValidationError);

  assert.equal(validateSearchQuery('  nature vibes  '), 'nature vibes');
  assert.throws(() => validateSearchQuery(''), ValidationError);
});

test('Validators: validateMediaFile verifies existence and extensions', () => {
  const tmpFile = path.join(os.tmpdir(), `test_img_${Date.now()}.jpg`);
  fs.writeFileSync(tmpFile, Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]));

  try {
    const res = validateMediaFile(tmpFile, 'image');
    assert.equal(res.filePath, tmpFile);
    assert.equal(res.extension, '.jpg');

    assert.throws(
      () => validateMediaFile(tmpFile, 'video'),
      ValidationError
    );
    assert.throws(
      () => validateMediaFile(path.join(os.tmpdir(), 'non_existent_file.jpg')),
      ValidationError
    );
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
});
