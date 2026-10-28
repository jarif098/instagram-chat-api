'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ConversationsService = require('../../src/services/conversations');
const MessagesService = require('../../src/services/messages');
const ReactionsService = require('../../src/services/reactions');
const ReadReceiptsService = require('../../src/services/read-receipts');
const ThemesService = require('../../src/services/themes');
const MediaService = require('../../src/services/media');
const { UnsupportedFeatureError } = require('../../src/utils/errors');

test('ConversationsService: getInbox formats request and normalizes threads', async () => {
  const mockTransport = {
    get: async (url, config) => ({
      data: {
        inbox: {
          threads: [
            {
              thread_fbid: '123',
              thread_id: '456',
              users: [{ pk: '10', username: 'alice' }]
            }
          ],
          oldest_cursor: 'cursor_1',
          has_older: false,
          unseen_count: 0
        },
        status: 'ok'
      }
    })
  };

  const service = new ConversationsService({
    transport: mockTransport,
    session: { userId: '10' }
  });

  const res = await service.getInbox({ forceRest: true });
  assert.equal(res.conversations.length, 1);
  assert.equal(res.conversations[0].id, '123');
  assert.equal(res.hasOlder, false);
});

test('ConversationsService: findByUsername searches inbox', async () => {
  const service = new ConversationsService({
    transport: {},
    session: { userId: '10' }
  });

  service.getInbox = async () => ({
    conversations: [
      { id: '111', participants: [{ username: 'bob' }] },
      { id: '222', participants: [{ username: 'charlie' }] }
    ]
  });

  const found = await service.findByUsername('bob');
  assert.ok(found);
  assert.equal(found.id, '111');

  const notFound = await service.findByUsername('nonexistent');
  assert.equal(notFound, null);
});

test('MessagesService: sends text message with client_context and form encoding', async () => {
  let postUrl = '';
  let postBody = '';

  const mockTransport = {
    post: async (url, body) => {
      postUrl = url;
      postBody = body;
      return {
        data: {
          status: 'ok',
          item_id: 'mid.$broadcast_item_1',
          timestamp: 1793212800000000
        }
      };
    }
  };

  const service = new MessagesService({
    transport: mockTransport,
    session: { userId: '10', getCsrfToken: () => 'csrf_mock' }
  });

  const msg = await service.sendTextMessage('th_123', 'Hello world!', { forceRest: true });
  assert.ok(postUrl.includes('/broadcast/text/'));
  assert.ok(postBody.includes('Hello+world%21') || postBody.includes('Hello world'));
  assert.equal(msg.id, 'mid.$broadcast_item_1');
  assert.equal(msg.text, 'Hello world!');
});

test('MessagesService: throws UnsupportedFeatureError on E2EE threads', async () => {
  const service = new MessagesService({ transport: {}, session: {} });
  await assert.rejects(
    async () => service.sendTextMessage('th_123', 'Hello', { isEncrypted: true }),
    UnsupportedFeatureError
  );
});

test('MessagesService: replies to message item', async () => {
  let replyId = null;
  const service = new MessagesService({ transport: {}, session: {} });
  service.sendTextMessage = async (tId, text, opts) => {
    replyId = opts.replyToItemId;
    return { id: 'mid.$reply_msg', replyTo: { id: opts.replyToItemId } };
  };

  const res = await service.reply('th_1', 'mid.$orig', 'Replying here');
  assert.equal(replyId, 'mid.$orig');
  assert.equal(res.id, 'mid.$reply_msg');
});

test('ReactionsService: sends and deletes emoji reaction via GraphQL mutation', async () => {
  const calls = [];
  const mockTransport = {
    post: async (url, body, config) => {
      calls.push({ url, body, config });
      return {
        data: {
          data: {
            direct_send_reaction: {
              status: 'SUCCESS'
            }
          }
        }
      };
    }
  };

  const service = new ReactionsService({
    transport: mockTransport,
    session: { userId: '10', _dtsg: 'dtsg_val', _lsd: 'lsd_val', getCsrfToken: () => 'csrf_val' }
  });

  const res = await service.sendReaction('th_1', 'mid.$123', '🔥');
  assert.equal(res.success, true);
  assert.equal(res.emoji, '🔥');
  assert.ok(calls[0].url.includes('/api/graphql'));

  const delRes = await service.deleteReaction('th_1', 'mid.$123');
  assert.equal(delRes.success, true);
});

test('ReadReceiptsService: markSeen and sendTypingIndicator', async () => {
  const calls = [];
  const mockTransport = {
    post: async (url, body) => {
      calls.push({ url, body });
      return { data: { status: 'ok' } };
    }
  };

  const service = new ReadReceiptsService({
    transport: mockTransport,
    session: { getCsrfToken: () => 'c' }
  });

  const seen = await service.markSeen('th_1', 'mid.$item_99', { forceRest: true });
  assert.equal(seen.success, true);

  const typing = await service.sendTypingIndicator('th_1', true);
  assert.equal(typing.success, true);
});
