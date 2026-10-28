'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const UsersService = require('../../src/services/users');
const InstaChatClient = require('../../src/client');
const { NotFoundError } = require('../../src/utils/errors');

test('UsersService: getUserByUsername fetches profile and throws on not found', async () => {
  const mockTransport = {
    get: async (url, config = {}) => {
      const usernameParam = (config.params && config.params.username) || (url.includes('username=') ? url.split('username=')[1] : null);
      if (usernameParam === 'ada' || url.includes('username=ada')) {
        return {
          data: {
            data: {
              user: {
                id: '424242',
                username: 'ada',
                full_name: 'Ada Lovelace',
                is_verified: true,
                edge_followed_by: { count: 15000 },
                edge_follow: { count: 120 }
              }
            }
          }
        };
      }
      return { data: { data: { user: null } } };
    }
  };

  const service = new UsersService({ transport: mockTransport, session: {} });
  const profile = await service.getUserByUsername('ada');
  assert.equal(profile.id, '424242');
  assert.equal(profile.username, 'ada');
  assert.equal(profile.isVerified, true);
  assert.equal(profile.followerCount, 15000);

  await assert.rejects(
    async () => service.getUserByUsername('missing_user'),
    NotFoundError
  );
});

test('UsersService: searchUsers handles topsearch wrapper', async () => {
  const mockTransport = {
    get: async (url) => ({
      data: {
        users: [
          { user: { pk: '101', username: 'ada_official', is_verified: true } },
          { user: { pk: '102', username: 'ada_priv', is_private: true } }
        ]
      }
    })
  };

  const service = new UsersService({ transport: mockTransport, session: {} });
  const results = await service.searchUsers('ada');
  assert.equal(results.length, 2);
  assert.equal(results[0].username, 'ada_official');
  assert.equal(results[1].username, 'ada_priv');
});

test('UsersService: friendship status, follow, unfollow, and followers', async () => {
  const calls = [];
  const mockTransport = {
    get: async (url) => {
      calls.push({ method: 'GET', url });
      if (url.includes('/friendships/show/')) {
        return {
          data: {
            following: true,
            followed_by: true,
            is_private: false,
            status: 'ok'
          }
        };
      }
      if (url.includes('/followers/')) {
        return {
          data: {
            users: [{ pk: '201', username: 'fan_1' }],
            status: 'ok'
          }
        };
      }
      return { data: { status: 'ok' } };
    },
    post: async (url, body) => {
      calls.push({ method: 'POST', url, body });
      if (url.includes('/friendships/create/')) {
        return { data: { friendship_status: { following: true }, status: 'ok' } };
      }
      if (url.includes('/friendships/destroy/')) {
        return { data: { friendship_status: { following: false }, status: 'ok' } };
      }
      return { data: { status: 'ok' } };
    }
  };

  const service = new UsersService({
    transport: mockTransport,
    session: { getCsrfToken: () => 'c' }
  });

  const status = await service.getFriendshipStatus('555');
  assert.equal(status.userId, '555');
  assert.equal(status.following, true);
  assert.equal(status.followedBy, true);

  const follow = await service.followUser('555');
  assert.equal(follow.friendshipStatus.following, true);

  const unfollow = await service.unfollowUser('555');
  assert.equal(unfollow.friendshipStatus.following, false);

  const followers = await service.getFollowers('555');
  assert.equal(followers.users.length, 1);
});

test('InstaChatClient: exposes UsersService methods on facade', () => {
  const client = new InstaChatClient({ cookies: { sessionid: 's', csrftoken: 'c', ds_user_id: '123' } });
  assert.equal(typeof client.getUserByUsername, 'function');
  assert.equal(typeof client.getUserById, 'function');
  assert.equal(typeof client.searchUsers, 'function');
  assert.equal(typeof client.getFriendshipStatus, 'function');
  assert.equal(typeof client.followUser, 'function');
  assert.equal(typeof client.unfollowUser, 'function');
});
