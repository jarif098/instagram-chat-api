'use strict';

/**
 * Example: Looking up User Profiles, Searching Users, and Checking Friendship Status
 */

const { InstaChatClient } = require('../src');

async function main() {
  const client = new InstaChatClient();
  await client.connect();

  const targetHandle = 'instagram';
  console.log(`\n--- Fetching Profile for @${targetHandle} ---`);
  const profile = await client.getUserByUsername(targetHandle);
  console.log(`Name: ${profile.fullName} (@${profile.username})${profile.isVerified ? ' ✓' : ''}`);
  console.log(`User ID: ${profile.id}`);
  console.log(`Followers: ${profile.followerCount} | Following: ${profile.followingCount} | Posts: ${profile.mediaCount}`);
  console.log(`Bio: ${profile.biography}`);

  console.log(`\n--- Checking Friendship Status with @${targetHandle} ---`);
  const status = await client.getFriendshipStatus(profile.id);
  console.log('Following:', status.following, '| Followed By:', status.followedBy);

  console.log('\n--- Searching Users ("creators") ---');
  const matches = await client.searchUsers('creators', { limit: 5 });
  for (const user of matches) {
    console.log(`- @${user.username} (${user.fullName || 'No name'}) [ID: ${user.id}]`);
  }

  await client.disconnect();
}

if (require.main === module) {
  main().catch(console.error);
}
