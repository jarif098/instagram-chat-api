'use strict';

/**
 * Example: Follow / Unfollow, Message Reactions, Publishing Posts & Reels, and Post / Reel / Story Reactions
 */

const { InstaChatClient } = require('../src');

async function main() {
  const client = new InstaChatClient();
  await client.connect();

  // 1. Follow / Unfollow by @username, profile URL, or numeric userId
  console.log('\n--- Follow / Unfollow ---');
  const followRes = await client.follow('@instagram');
  console.log('Followed:', followRes.username, 'ID:', followRes.userId, 'Following:', followRes.following);
  const followingCheck = await client.isFollowing('@instagram');
  console.log('Is following @instagram:', followingCheck);

  // 2. React to a DM message (supports emoji or named aliases like 'fire', 'laugh', 'like')
  const threadId = process.env.TARGET_THREAD_ID;
  const messageId = process.env.TARGET_MESSAGE_ID;
  if (threadId && messageId) {
    console.log('\n--- DM Message Reaction ---');
    await client.react(threadId, messageId, 'fire'); // sends 🔥
    await client.unreact(threadId, messageId, '🔥');
  }

  // 3. Publish a Feed Post (local path, Buffer, Stream, or HTTPS URL)
  if (process.env.POST_IMAGE_PATH) {
    console.log('\n--- Publishing Photo Post ---');
    const published = await client.createPost(process.env.POST_IMAGE_PATH, {
      caption: 'Posted via instagram-chat-api! 🚀',
      altText: 'Demo photo upload'
    });
    console.log('Published Post ID:', published.id, 'URL:', published.url);
  }

  // 4. Fetch & React (Like / Comment / Save) to a Post
  if (process.env.POST_URL) {
    console.log('\n--- Post Info & React ---');
    const post = await client.getPost(process.env.POST_URL);
    console.log(`Post by @${post.user?.username}: ${post.likeCount} likes, ${post.commentCount} comments`);

    await client.reactPost(process.env.POST_URL, '❤️'); // Native like
    await client.commentOnPost(process.env.POST_URL, 'Awesome post! 🔥');
    await client.savePost(process.env.POST_URL);
  }

  // 5. React to a Reel (by Reel URL, shortcode, or numeric media ID)
  if (process.env.REEL_URL) {
    console.log('\n--- Reel React ---');
    // Native heart like on the Reel
    await client.reactReel(process.env.REEL_URL, '❤️');

    // Or react with custom emoji as a comment (+ like)
    await client.reactReel(process.env.REEL_URL, '🔥', { asComment: true });

    // Remove like from the Reel
    await client.unreactReel(process.env.REEL_URL);
  }

  // 6. List a user's Posts & Reels
  const { posts } = await client.getUserPosts('@instagram', { count: 5 });
  const { reels } = await client.getUserReels('@instagram', { count: 5 });
  console.log(`\nFetched ${posts.length} post(s) and ${reels.length} reel(s) from @instagram.`);

  await client.disconnect();
}

if (require.main === module) {
  main().catch(console.error);
}
