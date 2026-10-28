'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Session = require('../../src/auth/session');
const { createSessionFromCookieString, createSessionFromCookies } = require('../../src/auth/credentials');
const { AuthenticationError } = require('../../src/utils/errors');

test('Session: parses cookie string into structured object', () => {
  const session = new Session();
  const raw = 'sessionid=65842145265%3Aabc123; csrftoken=tok_xyz; ds_user_id=65842145265; mid=mid_1';
  session.load({ cookieString: raw });

  assert.equal(session.cookies.sessionid, '65842145265%3Aabc123');
  assert.equal(session.cookies.csrftoken, 'tok_xyz');
  assert.equal(session.userId, '65842145265');
  assert.equal(session.getCsrfToken(), 'tok_xyz');
});

test('Session: loads from browser extension cookie array (Cookie-Editor format)', () => {
  const session = new Session();
  const cookieEditorList = [
    { name: 'sessionid', value: 'sess_val_123' },
    { name: 'csrftoken', value: 'csrf_val_456' },
    { name: 'ds_user_id', value: '99887766' }
  ];

  session.load({ cookies: cookieEditorList });
  assert.equal(session.cookies.sessionid, 'sess_val_123');
  assert.equal(session.cookies.csrftoken, 'csrf_val_456');
  assert.equal(session.userId, '99887766');
});

test('Session: loads from flat cookie JSON object', () => {
  const session = new Session();
  session.load({
    cookies: {
      sessionid: 'sess_flat_1',
      csrftoken: 'csrf_flat_2',
      ds_user_id: '112233'
    }
  });

  assert.equal(session.cookies.sessionid, 'sess_flat_1');
  assert.equal(session.cookies.csrftoken, 'csrf_flat_2');
  assert.equal(session.userId, '112233');
});

test('Session: throws AuthenticationError if sessionid is missing', () => {
  const session = new Session();
  assert.throws(
    () => session.load({ cookieString: 'csrftoken=tok_only;' }),
    AuthenticationError
  );
});

test('Session: throws AuthenticationError if csrftoken is missing', () => {
  const session = new Session();
  assert.throws(
    () => session.load({ cookieString: 'sessionid=sess_only;' }),
    AuthenticationError
  );
});

test('Session: updates rotated cookies from Set-Cookie header', () => {
  const session = new Session();
  session.load({ cookieString: 'sessionid=old_sess; csrftoken=old_csrf; ds_user_id=12345;' });

  session.updateFromSetCookieHeader([
    'csrftoken=new_rotated_csrf; Domain=.instagram.com; Path=/',
    'rur=RVA; Domain=.instagram.com; Path=/'
  ]);

  assert.equal(session.cookies.csrftoken, 'new_rotated_csrf');
  assert.equal(session.cookies.rur, 'RVA');
  assert.equal(session.cookies.sessionid, 'old_sess');
});

test('Session: credentials helper creates valid session from raw cookie string', () => {
  const raw = 'sessionid=helper_sess; csrftoken=helper_csrf; ds_user_id=445566';
  const session = createSessionFromCookieString(raw);

  assert.equal(session.cookies.sessionid, 'helper_sess');
  assert.equal(session.cookies.csrftoken, 'helper_csrf');
  assert.equal(session.userId, '445566');
});

test('Session: saves and loads from temporary file', () => {
  const tmpPath = path.join(os.tmpdir(), `test_session_${Date.now()}.json`);
  try {
    const session1 = new Session({ sessionPath: tmpPath });
    session1.load({ cookieString: 'sessionid=saved_sess; csrftoken=saved_csrf; ds_user_id=12345' });
    session1.save();

    const session2 = new Session({ sessionPath: tmpPath });
    session2.load(tmpPath);

    assert.equal(session2.cookies.sessionid, 'saved_sess');
    assert.equal(session2.cookies.csrftoken, 'saved_csrf');
    assert.equal(session2.userId, '12345');
  } finally {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
});
