'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const RealtimeEngine = require('../../src/transport/realtime');
const Events = require('../../src/constants/events');

test('RealtimeEngine: dedupes seen messages and emits new message event', async () => {
  const emitted = [];
  const engine = new RealtimeEngine({
    transport: {},
    session: { userId: '10' },
    pollIntervalMs: 1000
  });

  engine.on(Events.MESSAGE, (msg) => emitted.push(msg));

  // Seed baseline
  engine.isInitialized = true;
  engine.seenMessageIds.add('mid.$seen_1');

  // New messages arriving
  const newMsg = { id: 'mid.$new_2', text: 'Hello new message', senderId: '20' };
  const oldMsg = { id: 'mid.$seen_1', text: 'Old message', senderId: '20' };

  engine._processThreadMessages('th_1', [oldMsg, newMsg]);

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].id, 'mid.$new_2');
  assert.equal(engine.seenMessageIds.has('mid.$new_2'), true);
});

test('RealtimeEngine: tracks and emits reaction event on messages', async () => {
  const reactionsEmitted = [];
  const engine = new RealtimeEngine({
    transport: {},
    session: { userId: '10' }
  });

  engine.on(Events.REACTION, (rec) => reactionsEmitted.push(rec));
  engine.isInitialized = true;

  const msgWithReaction = {
    id: 'mid.$msg_react',
    reactions: [{ senderId: '30', emoji: '❤️' }]
  };

  engine._processMessagesReactions('th_1', [msgWithReaction]);

  assert.equal(reactionsEmitted.length, 1);
  assert.equal(reactionsEmitted[0].emoji, '❤️');
  assert.equal(reactionsEmitted[0].senderId, '30');

  // Redundant poll should not re-emit duplicate reaction
  engine._processMessagesReactions('th_1', [msgWithReaction]);
  assert.equal(reactionsEmitted.length, 1);
});
