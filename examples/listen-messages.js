'use strict';

/**
 * Example: Realtime Event Listening (Incoming Messages, Reactions, Typing)
 */

const { InstaChatClient } = require('../src');

async function main() {
  const client = new InstaChatClient({
    pollIntervalMs: 3000,
    debug: false
  });

  client.on('ready', () => {
    console.log('>>> [InstaChat] Client is online and listening for direct messages...');
    console.log('>>> Send a direct message to this account from another device to test.');
  });

  // Listen for incoming messages
  client.on('message', async (message) => {
    console.log('\n[NEW MESSAGE RECEIVED]');
    console.log(`Thread ID: ${message.threadId}`);
    console.log(`From: ${message.sender.username || message.senderId}`);
    console.log(`Text: ${message.text}`);
    console.log(`Type: ${message.type}`);
    console.log(`Timestamp: ${message.createdAt}`);

    // Example auto-reply:
    if (!message.isSelf && message.text.toLowerCase() === 'ping') {
      console.log('Responding with "pong"...');
      await client.sendMessage(message.threadId, 'pong 🏓');
    }
  });

  // Listen for reactions
  client.on('reaction', (reaction) => {
    console.log('\n[REACTION RECEIVED]');
    console.log(`Thread: ${reaction.threadId}`);
    console.log(`Message ID: ${reaction.messageId}`);
    console.log(`Emoji: ${reaction.emoji}`);
    console.log(`By User ID: ${reaction.senderId}`);
  });

  // Rate limit notifications
  client.on('rate_limit', (err) => {
    console.warn(`[RATE LIMIT WARNING] Pausing for ${err.retryAfter} seconds. Reason: ${err.message}`);
  });

  // Authentication errors
  client.on('auth_error', (err) => {
    console.error('[AUTH ERROR] Session invalid:', err.message);
  });

  // General errors
  client.on('error', (err) => {
    console.error('[CLIENT ERROR]', err.message);
  });

  await client.connect();

  // Keep process alive
  process.on('SIGINT', async () => {
    console.log('\nStopping listener...');
    await client.disconnect();
    process.exit(0);
  });
}

if (require.main === module) {
  main().catch(console.error);
}
