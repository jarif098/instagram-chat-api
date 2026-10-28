'use strict';

const InstaChatClient = require('../src/client');

(async () => {
  const client = new InstaChatClient({ sessionPath: './cookie.json' });
  await client.connect();

  const threadId = '1118689617483421';
  const thread = await client.conversations.getThread(threadId);
  console.log('Thread title:', thread.conversation.title);
  console.log('Messages count:', thread.messages.length);
  for (const m of thread.messages.slice(0, 5)) {
    console.log({
      id: m.id,
      text: m.text,
      senderId: m.senderId,
      type: m.type,
      rawItemType: m.raw.item_type,
      repliedTo: m.repliedToMessage ? m.repliedToMessage.id : null
    });
  }

  await client.disconnect();
})();
