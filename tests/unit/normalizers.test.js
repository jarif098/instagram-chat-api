'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const User = require('../../src/models/user');
const Message = require('../../src/models/message');
const Conversation = require('../../src/models/conversation');

test('User model: normalizes mobile and web user objects', () => {
  const user = new User({
    pk: '65842145265',
    username: 'eijah.noah',
    full_name: 'Eijah Noah',
    profile_pic_url: 'https://cdn.example/pfp.jpg',
    is_verified: true,
    is_private: false,
    interop_messaging_user_fbid: '17844052083193266'
  });

  assert.equal(user.id, '65842145265');
  assert.equal(user.username, 'eijah.noah');
  assert.equal(user.fullName, 'Eijah Noah');
  assert.equal(user.isVerified, true);
  assert.equal(user.isPrivate, false);
  assert.equal(user.interopFbid, '17844052083193266');
});

test('Message model: extracts text, reply details, timestamp, and sender correctly', () => {
  const msg = Message.fromRaw(
    {
      item_id: 'mid.$test1234',
      thread_id: 'th_999',
      user_id: '12345',
      timestamp: 1793212800000000,
      item_type: 'text',
      text: 'Hello world',
      replied_to_message: {
        item_id: 'mid.$prev001',
        user_id: '67890',
        text: 'Previous text'
      }
    },
    '12345'
  );

  assert.equal(msg.id, 'mid.$test1234');
  assert.equal(msg.messageID, 'mid.$test1234');
  assert.equal(msg.threadId, 'th_999');
  assert.equal(msg.senderId, '12345');
  assert.equal(msg.isSelf, true);
  assert.equal(msg.text, 'Hello world');
  assert.ok(msg.replyTo);
  assert.equal(msg.replyTo.id, 'mid.$prev001');
  assert.equal(msg.replyTo.text, 'Previous text');
});

test('Conversation model: normalizes thread details, users, and admin status', () => {
  const conv = Conversation.fromRaw(
    {
      thread_fbid: '1118689617483421',
      thread_id: '340282366841710301281152781854613673629',
      thread_title: 'Project Group',
      is_group: true,
      muted: false,
      admin_user_ids: ['65842145265'],
      users: [
        { pk: '65842145265', username: 'eijah.noah' },
        { pk: '78902667824', username: 'jarifcreates' }
      ]
    },
    '65842145265'
  );

  assert.equal(conv.id, '1118689617483421');
  assert.equal(conv.v2Id, '340282366841710301281152781854613673629');
  assert.equal(conv.title, 'Project Group');
  assert.equal(conv.isGroup, true);
  assert.equal(conv.adminUserIds.includes('65842145265'), true);
  assert.equal(conv.participants.length, 2);
  assert.equal(conv.isViewerAdmin, true);
});
