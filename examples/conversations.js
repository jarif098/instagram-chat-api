'use strict';

/**
 * Example: Retrieving and Paginating Conversations
 */

const { InstaChatClient } = require('../src');

async function main() {
  const client = new InstaChatClient();

  await client.connect();

  console.log('\n--- Fetching Direct Inbox Conversations ---');
  const inbox = await client.getInbox({ limit: 10 });
  console.log(`Found ${inbox.conversations.length} conversation(s). Unread count: ${inbox.unseenCount}`);

  for (const conv of inbox.conversations) {
    console.log(`\nThread ID: ${conv.id}`);
    console.log(`Title: ${conv.title}`);
    console.log(`Participants: ${conv.participants.map((p) => p.username).join(', ')}`);
    console.log(`Unread: ${conv.hasUnread}`);
    if (conv.lastMessage) {
      console.log(`Last Message: [${conv.lastMessage.sender.username || conv.lastMessage.senderId}]: ${conv.lastMessage.text}`);
    }
  }

  // Find thread by username
  const targetUsername = 'instagram';
  const found = await client.findConversationByUsername(targetUsername);
  if (found) {
    console.log(`\nFound thread with @${targetUsername}: Thread ID ${found.id}`);
  }

  await client.disconnect();
}

if (require.main === module) {
  main().catch(console.error);
}
