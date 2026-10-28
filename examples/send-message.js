'use strict';

/**
 * Example: Sending Text Messages, Replies, and Unsending
 */

const { InstaChatClient } = require('../src');

async function main() {
  const client = new InstaChatClient();

  await client.connect();

  const targetThreadId = process.env.TARGET_THREAD_ID || '12345678901234567';

  // 1. Send simple text message
  console.log(`Sending message to thread ${targetThreadId}...`);
  const message = await client.sendMessage(targetThreadId, 'Hello from InstaChat API! 🚀');
  console.log(`Sent message ID: ${message.id} at ${message.createdAt}`);

  // 2. Reply to the message
  console.log(`Replying to message ${message.id}...`);
  const reply = await client.reply(targetThreadId, message.id, 'Replying to previous message! 💬');
  console.log(`Sent reply ID: ${reply.id}`);

  // 3. Send emoji reaction
  console.log('Sending ❤️ reaction...');
  await client.sendReaction(targetThreadId, message.id, '🔥');
  console.log('Reaction added!');

  // 4. Mark seen
  await client.markSeen(targetThreadId, message.id);
  console.log('Marked as seen.');

  // 5. Unsend the reply after 3 seconds
  setTimeout(async () => {
    console.log(`Unsending reply ${reply.id}...`);
    await client.unsendMessage(targetThreadId, reply.id);
    console.log('Reply unsent successfully.');
    await client.disconnect();
  }, 3000);
}

if (require.main === module) {
  main().catch(console.error);
}
