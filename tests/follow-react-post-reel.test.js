'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const {
  InstaChatClient,
  Post,
  PostsService,
  UsersService,
  ReactionsService,
  Endpoints,
  REACTION_ALIASES,
  ValidationError,
  UnsupportedFeatureError,
  AuthenticationError,
  RateLimitError,
  NotFoundError,
  InstaChatError
} = require('../src');
const {
  validateCaption,
  validateCommentText,
  validateReactionEmoji,
  validateUserIdentifier
} = require('../src/utils/validators');

function createMockSession(overrides = {}) {
  return {
    userId: '100001',
    username: 'tester',
    cookies: {
      sessionid: '100001%3AsecretToken%3A28',
      csrftoken: 'csrf_test_token',
      ds_user_id: '100001'
    },
    _dtsg: 'NAf_test_dtsg',
    _lsd: 'lsd_test_token',
    getCsrfToken() {
      return this.cookies.csrftoken;
    },
    ...overrides
  };
}

function createMockTransport(handlers = {}) {
  const calls = [];
  return {
    calls,
    async get(url, config = {}) {
      calls.push({ method: 'GET', url, config });
      if (typeof handlers.get === 'function') {
        return handlers.get(url, config, calls);
      }
      return { data: {} };
    },
    async post(url, data, config = {}, isIdempotent = false) {
      calls.push({ method: 'POST', url, data, config, isIdempotent });
      if (typeof handlers.post === 'function') {
        return handlers.post(url, data, config, isIdempotent, calls);
      }
      return { data: { status: 'ok' } };
    }
  };
}

// =========================================================================
// 1. Validators & Helpers
// =========================================================================

test('validators: validateUserIdentifier parses numeric IDs, @handles, profile URLs, and User objects', () => {
  assert.deepEqual(validateUserIdentifier('25025320'), { type: 'id', value: '25025320', username: null });
  assert.deepEqual(validateUserIdentifier(25025320), { type: 'id', value: '25025320', username: null });
  assert.deepEqual(validateUserIdentifier('@Instagram'), { type: 'username', value: 'instagram', username: 'instagram' });
  assert.deepEqual(validateUserIdentifier('https://www.instagram.com/Instagram/?hl=en'), {
    type: 'username',
    value: 'instagram',
    username: 'instagram'
  });
  assert.deepEqual(validateUserIdentifier({ id: '999', username: 'Alice' }), {
    type: 'id',
    value: '999',
    username: 'alice'
  });
  assert.throws(() => validateUserIdentifier(''), ValidationError);
  assert.throws(() => validateUserIdentifier(null), ValidationError);
});

test('validators: validateReactionEmoji resolves named aliases and keeps raw Unicode emojis', () => {
  assert.equal(validateReactionEmoji('like'), '❤️');
  assert.equal(validateReactionEmoji('FIRE'), '🔥');
  assert.equal(validateReactionEmoji('laugh'), '😂');
  assert.equal(validateReactionEmoji('🚀'), '🚀');
  assert.equal(REACTION_ALIASES.heart, '❤️');
  assert.throws(() => validateReactionEmoji('   '), ValidationError);
});

test('validators: validateCaption and validateCommentText enforce limits', () => {
  assert.equal(validateCaption(''), '');
  assert.equal(validateCaption(null), '');
  assert.equal(validateCaption('Hello world'), 'Hello world');
  assert.throws(() => validateCaption('a'.repeat(2201)), ValidationError);

  assert.equal(validateCommentText('  Nice reel!  '), 'Nice reel!');
  assert.throws(() => validateCommentText('   '), ValidationError);
  assert.throws(() => validateCommentText('x'.repeat(2201)), ValidationError);
});

test('PostsService.getImageDimensions reads PNG and JPEG headers accurately', () => {
  // Minimal PNG header with IHDR width=640, height=480
  const png = Buffer.alloc(32);
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]).copy(png, 0);
  png.writeUInt32BE(640, 16);
  png.writeUInt32BE(480, 20);
  assert.deepEqual(PostsService.getImageDimensions(png), { width: 640, height: 480 });

  // Minimal JPEG header with SOF0 height=1350, width=1080
  const jpeg = Buffer.from([
    0xFF, 0xD8, // SOI
    0xFF, 0xC0, // SOF0
    0x00, 0x11, // length 17
    0x08,       // precision
    0x05, 0x46, // height = 1350
    0x04, 0x38, // width = 1080
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xFF, 0xD9  // EOI
  ]);
  assert.deepEqual(PostsService.getImageDimensions(jpeg), { width: 1080, height: 1350 });

  // Fallback for unknown buffer
  assert.deepEqual(PostsService.getImageDimensions(Buffer.from('not-an-image')), { width: 1080, height: 1080 });
});

test('PostsService.parseMediaReference decodes URLs, shortcodes, composite IDs, and Post objects', () => {
  const fromReelUrl = PostsService.parseMediaReference('https://www.instagram.com/reel/B_123456789/');
  assert.equal(fromReelUrl.detectedKind, 'reel');
  assert.equal(fromReelUrl.shortcode, 'B_123456789');
  assert.match(fromReelUrl.mediaId, /^\d+$/);

  const fromPostUrl = PostsService.parseMediaReference('https://www.instagram.com/p/B_123456789/');
  assert.equal(fromPostUrl.detectedKind, 'post');
  assert.equal(fromPostUrl.mediaId, fromReelUrl.mediaId);

  const fromComposite = PostsService.parseMediaReference('3456789012345_25025320');
  assert.equal(fromComposite.mediaId, '3456789012345');
  assert.equal(fromComposite.fullId, '3456789012345_25025320');
});

// =========================================================================
// 2. Follow / Unfollow / ToggleFollow / IsFollowing
// =========================================================================

test('UsersService: follow resolves @username, falls back to web/mobile endpoints, and returns normalized result', async () => {
  let postAttempts = 0;
  const transport = createMockTransport({
    get: async (url) => {
      if (url === Endpoints.USER_WEB_PROFILE) {
        return {
          data: {
            data: {
              user: { id: '25025320', username: 'instagram', full_name: 'Instagram' }
            }
          }
        };
      }
      return { data: {} };
    },
    post: async (url) => {
      postAttempts++;
      if (postAttempts === 1) {
        throw new Error('Primary friendships/create returned 404');
      }
      assert.equal(url, Endpoints.WEB_FOLLOW_USER('25025320'));
      return {
        data: {
          status: 'ok',
          friendship_status: { following: true, outgoing_request: false }
        }
      };
    }
  });

  const users = new UsersService({ transport, session: createMockSession() });
  const res = await users.follow('@instagram');

  assert.equal(res.success, true);
  assert.equal(res.userId, '25025320');
  assert.equal(res.username, 'instagram');
  assert.equal(res.following, true);
  assert.equal(res.requested, false);
  assert.equal(postAttempts, 2);
});

test('UsersService: unfollow falls back all the way to mobile Bearer IGT:2 route when web routes fail', async () => {
  let postAttempts = 0;
  const transport = createMockTransport({
    post: async (url, _data, config) => {
      postAttempts++;
      if (postAttempts < 3) {
        throw new Error(`Attempt ${postAttempts} failed`);
      }
      assert.equal(url, Endpoints.FRIENDSHIP_UNFOLLOW_MOBILE('25025320'));
      assert.ok(config.headers.Authorization.startsWith('Bearer IGT:2:'));
      return {
        data: {
          status: 'ok',
          friendship_status: { following: false, outgoing_request: false }
        }
      };
    }
  });

  const users = new UsersService({ transport, session: createMockSession() });
  const res = await users.unfollow('25025320');

  assert.equal(res.success, true);
  assert.equal(res.following, false);
  assert.equal(postAttempts, 3);
});

test('UsersService: toggleFollow and isFollowing work cleanly with numeric IDs and usernames', async () => {
  let currentlyFollowing = false;
  const transport = createMockTransport({
    get: async (url) => {
      if (url === Endpoints.FRIENDSHIP_STATUS('555')) {
        return { data: { following: currentlyFollowing, outgoing_request: false } };
      }
      return { data: {} };
    },
    post: async (url) => {
      if (url.includes('/create/')) {
        currentlyFollowing = true;
        return { data: { status: 'ok', friendship_status: { following: true } } };
      }
      if (url.includes('/destroy/')) {
        currentlyFollowing = false;
        return { data: { status: 'ok', friendship_status: { following: false } } };
      }
      return { data: { status: 'ok' } };
    }
  });

  const users = new UsersService({ transport, session: createMockSession() });
  assert.equal(await users.isFollowing('555'), false);

  const firstToggle = await users.toggleFollow('555');
  assert.equal(firstToggle.action, 'followed');
  assert.equal(firstToggle.following, true);
  assert.equal(await users.isFollowing('555'), true);

  const secondToggle = await users.toggleFollow('555');
  assert.equal(secondToggle.action, 'unfollowed');
  assert.equal(secondToggle.following, false);
});

test('UsersService: follow does not swallow AuthenticationError or RateLimitError into fallbacks', async () => {
  let attempts = 0;
  const transport = createMockTransport({
    post: async () => {
      attempts++;
      throw new RateLimitError('Action blocked', { retryAfter: 60 });
    }
  });

  const users = new UsersService({ transport, session: createMockSession() });
  await assert.rejects(() => users.follow('25025320'), RateLimitError);
  assert.equal(attempts, 1);
});

// =========================================================================
// 3. DM Message Reactions (react / unreact / aliases / fallback)
// =========================================================================

test('ReactionsService: react resolves aliases and sends GraphQL mutation; unreact falls back to REST', async () => {
  const transport = createMockTransport({
    post: async (url, data) => {
      const params = new URLSearchParams(data);
      if (url === Endpoints.GRAPHQL) {
        const vars = JSON.parse(params.get('variables'));
        if (vars.input.reaction_status === 'created') {
          assert.equal(vars.input.emoji, '🔥');
          return {
            data: {
              data: { xig_direct_reaction_send_with_slide_messaging_response: { ok: true } }
            }
          };
        }
        // Simulate transport failure on delete to verify REST fallback
        throw new Error('GraphQL temporary error');
      }
      assert.equal(url, Endpoints.BROADCAST_REACTION);
      assert.equal(params.get('reaction_status'), 'deleted');
      assert.equal(params.get('emoji'), '🔥');
      return { data: { status: 'ok' } };
    }
  });

  const reactions = new ReactionsService({ transport, session: createMockSession() });
  const addRes = await reactions.react('thread_1', 'msg_1', 'fire');
  assert.deepEqual(addRes, { success: true, threadId: 'thread_1', messageId: 'msg_1', emoji: '🔥' });

  const delRes = await reactions.unreact('thread_1', 'msg_1', 'fire');
  assert.deepEqual(delRes, { success: true, threadId: 'thread_1', messageId: 'msg_1', emoji: '🔥' });
});

test('ReactionsService: surfaces GraphQL error payloads instead of silently returning success', async () => {
  const transport = createMockTransport({
    post: async () => ({
      data: { errors: [{ message: 'Reaction forbidden' }] }
    })
  });

  const reactions = new ReactionsService({ transport, session: createMockSession() });
  await assert.rejects(() => reactions.deleteReaction('t1', 'm1', '❤️'), InstaChatError);
});

// =========================================================================
// 4. Posts & Reels Publishing, Fetching, Comments, Saves & Reactions
// =========================================================================

test('PostsService: createPost uploads photo binary and configures feed post returning normalized Post', async () => {
  const transport = createMockTransport({
    post: async (url, data, config) => {
      if (url.includes('/rupload_igphoto/')) {
        assert.ok(Buffer.isBuffer(data));
        const rparams = JSON.parse(config.headers['X-Instagram-Rupload-Params']);
        assert.equal(rparams.media_type, 1);
        assert.equal(rparams.upload_media_width, 800);
        assert.equal(rparams.upload_media_height, 600);
        return { data: { upload_id: rparams.upload_id, status: 'ok' } };
      }
      assert.equal(url, Endpoints.MEDIA_CONFIGURE);
      const body = new URLSearchParams(data);
      assert.equal(body.get('caption'), 'Hello Feed!');
      assert.equal(body.get('custom_accessibility_caption'), 'A test photo');
      return {
        data: {
          status: 'ok',
          media: {
            pk: '333000111222',
            id: '333000111222_100001',
            code: 'CxTestPost01',
            media_type: 1,
            caption: { text: 'Hello Feed!' },
            like_count: 0,
            comment_count: 0,
            original_width: 800,
            original_height: 600
          }
        }
      };
    }
  });

  const pngBuf = Buffer.alloc(32);
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]).copy(pngBuf, 0);
  pngBuf.writeUInt32BE(800, 16);
  pngBuf.writeUInt32BE(600, 20);

  const posts = new PostsService({ transport, session: createMockSession() });
  const created = await posts.createPost(pngBuf, {
    caption: 'Hello Feed!',
    altText: 'A test photo'
  });

  assert.ok(created instanceof Post);
  assert.equal(created.pk, '333000111222');
  assert.equal(created.code, 'CxTestPost01');
  assert.equal(created.url, 'https://www.instagram.com/p/CxTestPost01/');
  assert.equal(created.mediaType, 'image');
  assert.equal(created.caption, 'Hello Feed!');
});

test('PostsService: createCarouselPost uploads 2 images and calls configure_sidecar', async () => {
  let uploadCount = 0;
  const transport = createMockTransport({
    post: async (url, data) => {
      if (url.includes('/rupload_igphoto/')) {
        uploadCount++;
        return { data: { upload_id: `up_${uploadCount}`, status: 'ok' } };
      }
      assert.equal(url, Endpoints.MEDIA_CONFIGURE_SIDECAR);
      assert.equal(data.caption, 'Two slides');
      assert.equal(data.children_metadata.length, 2);
      return {
        data: {
          status: 'ok',
          media: {
            pk: '444000111',
            code: 'Caro1234567',
            media_type: 8,
            caption: { text: 'Two slides' },
            carousel_media: [{ pk: '1', media_type: 1 }, { pk: '2', media_type: 1 }]
          }
        }
      };
    }
  });

  const posts = new PostsService({ transport, session: createMockSession() });
  const slide1 = Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]);
  const slide2 = Readable.from([Buffer.from([0xFF, 0xD8, 0xFF, 0xD9])]);

  const carousel = await posts.createCarouselPost([slide1, { file: slide2, altText: 'Slide 2' }], {
    caption: 'Two slides'
  });

  assert.equal(uploadCount, 2);
  assert.equal(carousel.isCarousel, true);
  assert.equal(carousel.mediaType, 'carousel');
  assert.equal(carousel.carouselMedia.length, 2);

  await assert.rejects(() => posts.createCarouselPost([slide1]), ValidationError);
});

test('PostsService: createReel uploads video + cover and publishes via configure_to_clips', async () => {
  const seenUrls = [];
  const transport = createMockTransport({
    post: async (url) => {
      seenUrls.push(url);
      if (url.includes('rupload_igvideo') || url.includes('rupload_igphoto')) {
        return { data: { status: 'ok' } };
      }
      return {
        data: {
          status: 'ok',
          media: {
            pk: '555000111',
            code: 'ReelCode123',
            media_type: 2,
            product_type: 'clips',
            caption: { text: 'My Reel' }
          }
        }
      };
    }
  });

  const posts = new PostsService({ transport, session: createMockSession() });
  const reel = await posts.createReel(Buffer.from('fake-mp4-data'), {
    caption: 'My Reel',
    coverImage: Buffer.from([0xFF, 0xD8, 0xFF, 0xD9])
  });

  assert.equal(reel.isReel, true);
  assert.equal(reel.mediaType, 'reel');
  assert.equal(reel.url, 'https://www.instagram.com/reel/ReelCode123/');
  assert.ok(seenUrls.some((u) => u.includes('rupload_igvideo')));
  assert.ok(seenUrls.some((u) => u.includes('rupload_igphoto')));
  assert.ok(seenUrls.some((u) => u.includes('configure_to_clips')));
});

test('PostsService: reactReel supports heart likes, fallback chain, DM reactions, emoji comments, and guards unsupported raw emojis', async () => {
  let likeAttempts = 0;
  const dmCalls = [];

  const transport = createMockTransport({
    post: async (url, data) => {
      if (url.includes('/web/likes/')) {
        likeAttempts++;
        throw new Error('Web likes temporarily unavailable');
      }
      if (url.includes('/api/v1/media/') && url.endsWith('/like/')) {
        likeAttempts++;
        return { data: { status: 'ok' } };
      }
      if (url.includes('/unlike/')) {
        return { data: { status: 'ok' } };
      }
      if (url.includes('/comments/') && url.endsWith('/add/')) {
        const params = new URLSearchParams(data);
        return {
          data: {
            status: 'ok',
            id: 'cmt_999',
            text: params.get('comment_text')
          }
        };
      }
      return { data: { status: 'ok' } };
    }
  });

  const mockReactions = {
    async sendReaction(threadId, messageId, emoji) {
      dmCalls.push({ action: 'send', threadId, messageId, emoji });
      return { success: true, threadId, messageId, emoji };
    },
    async deleteReaction(threadId, messageId, emoji) {
      dmCalls.push({ action: 'delete', threadId, messageId, emoji });
      return { success: true, threadId, messageId, emoji };
    }
  };

  const posts = new PostsService({
    transport,
    session: createMockSession(),
    reactionsService: mockReactions
  });

  // 1. Native heart like on Reel URL (verifying fallback from web/likes -> media/like)
  const heartRes = await posts.reactReel('https://www.instagram.com/reel/B_123456789/', 'like');
  assert.equal(heartRes.success, true);
  assert.equal(heartRes.type, 'reel');
  assert.equal(heartRes.liked, true);
  assert.equal(heartRes.emoji, '❤️');
  assert.equal(likeAttempts, 2);

  // 2. Unlike Reel
  const unreactRes = await posts.unreactReel('https://www.instagram.com/reel/B_123456789/');
  assert.equal(unreactRes.success, true);
  assert.equal(unreactRes.liked, false);

  // 3. Custom emoji on Reel with asComment: true -> likes & comments emoji
  const emojiCommentRes = await posts.reactReel('https://www.instagram.com/reel/B_123456789/', 'fire', {
    asComment: true
  });
  assert.equal(emojiCommentRes.success, true);
  assert.equal(emojiCommentRes.action, 'emoji_comment');
  assert.equal(emojiCommentRes.emoji, '🔥');
  assert.equal(emojiCommentRes.commented, true);
  assert.equal(emojiCommentRes.comment.commentId, 'cmt_999');

  // 4. Custom emoji on shared Reel inside DM thread -> delegates to ReactionsService
  const dmReactRes = await posts.reactReel('https://www.instagram.com/reel/B_123456789/', 'laugh', {
    threadId: 'thread_42',
    messageId: 'item_99'
  });
  assert.equal(dmReactRes.action, 'dm_reaction');
  assert.equal(dmReactRes.emoji, '😂');
  assert.equal(dmCalls.length, 1);

  // 5. Custom emoji without asComment / threadId / fallbackToLike throws clear UnsupportedFeatureError
  await assert.rejects(
    () => posts.reactReel('https://www.instagram.com/reel/B_123456789/', '🔥'),
    UnsupportedFeatureError
  );

  // 6. Custom emoji with fallbackToLike: true falls back cleanly to heart like
  const fallbackRes = await posts.reactReel('https://www.instagram.com/reel/B_123456789/', '🔥', {
    fallbackToLike: true
  });
  assert.equal(fallbackRes.liked, true);
  assert.equal(fallbackRes.fallbackUsed, true);
  assert.equal(fallbackRes.requestedEmoji, '🔥');

  // 7. reactPost & unreactPost on Post URL + comment reply
  const postReactRes = await posts.reactPost('https://www.instagram.com/p/B_123456789/', '❤️');
  assert.equal(postReactRes.success, true);
  assert.equal(postReactRes.type, 'post');
  assert.equal(postReactRes.liked, true);

  const postUnreactRes = await posts.unreactPost('https://www.instagram.com/p/B_123456789/');
  assert.equal(postUnreactRes.success, true);
  assert.equal(postUnreactRes.type, 'post');
  assert.equal(postUnreactRes.liked, false);
});

test('PostsService: Story likes and Story emoji quick reactions work cleanly', async () => {
  const transport = createMockTransport({
    post: async (url, data) => {
      const params = new URLSearchParams(data);
      if (url === Endpoints.STORY_LIKE_WEB) {
        assert.equal(params.get('media_id'), '777888999');
        return { data: { status: 'ok' } };
      }
      if (url === Endpoints.BROADCAST_REEL_SHARE) {
        assert.equal(params.get('reaction_emoji'), '🔥');
        assert.equal(params.get('reel_id'), '25025320');
        return { data: { status: 'ok' } };
      }
      return { data: { status: 'ok' } };
    }
  });

  const posts = new PostsService({ transport, session: createMockSession() });

  const liked = await posts.reactStory('777888999', '❤️');
  assert.equal(liked.liked, true);
  assert.equal(liked.emoji, '❤️');

  const quick = await posts.reactStory('777888999_25025320', 'fire');
  assert.equal(quick.success, true);
  assert.equal(quick.action, 'story_emoji_reaction');
  assert.equal(quick.emoji, '🔥');
  assert.equal(quick.ownerId, '25025320');

  await assert.rejects(() => posts.reactStory('777888999', '🔥'), ValidationError);
});

test('PostsService: getPost, getUserPosts, getUserReels, comments, likers, save, and deletePost work end-to-end', async () => {
  const transport = createMockTransport({
    get: async (url) => {
      if (url.includes('/info/')) {
        return {
          data: {
            items: [{ pk: '12345', code: 'AbCdEf12345', media_type: 1, like_count: 42, caption: { text: 'Cap' } }]
          }
        };
      }
      if (url.includes('/feed/user/')) {
        return {
          data: {
            items: [{ pk: '1', media_type: 1 }, { pk: '2', media_type: 1 }],
            next_max_id: 'cursor_2',
            more_available: true
          }
        };
      }
      if (url.includes('/comments/')) {
        return {
          data: {
            comments: [{ pk: 'c1', text: 'Great!', comment_like_count: 3, user: { pk: '9', username: 'bob' } }],
            comment_count: 1
          }
        };
      }
      if (url.includes('/likers/')) {
        return {
          data: {
            users: [{ pk: '9', username: 'bob' }],
            user_count: 1
          }
        };
      }
      return { data: {} };
    },
    post: async (url) => {
      if (url === Endpoints.USER_CLIPS) {
        return {
          data: {
            items: [{ media: { pk: '9001', code: 'Clip1234567', media_type: 2, product_type: 'clips' } }],
            paging_info: { max_id: 'reel_next', more_available: true }
          }
        };
      }
      return { data: { status: 'ok', did_delete: true } };
    }
  });

  const users = new UsersService({ transport, session: createMockSession() });
  const posts = new PostsService({ transport, session: createMockSession(), usersService: users });

  const info = await posts.getPost('12345');
  assert.equal(info.likeCount, 42);
  assert.equal(info.caption, 'Cap');

  const feed = await posts.getUserPosts('25025320', { count: 2 });
  assert.equal(feed.posts.length, 2);
  assert.equal(feed.nextMaxId, 'cursor_2');
  assert.equal(feed.hasMore, true);

  const reels = await posts.getUserReels('25025320', { count: 1 });
  assert.equal(reels.reels.length, 1);
  assert.equal(reels.reels[0].isReel, true);
  assert.equal(reels.nextMaxId, 'reel_next');

  const comments = await posts.getPostComments('12345');
  assert.equal(comments.comments.length, 1);
  assert.equal(comments.comments[0].user.username, 'bob');

  const likers = await posts.getPostLikers('12345');
  assert.equal(likers.users.length, 1);
  assert.equal(likers.userCount, 1);

  assert.equal((await posts.savePost('12345')).saved, true);
  assert.equal((await posts.unsavePost('12345')).saved, false);
  assert.equal((await posts.likeComment('c1')).liked, true);
  assert.equal((await posts.unlikeComment('c1')).liked, false);
  assert.equal((await posts.deleteComment('12345', 'c1')).deleted, true);
  assert.equal((await posts.deletePost('12345')).deleted, true);
});

// =========================================================================
// 5. InstaChatClient Facade Integration Check
// =========================================================================

test('InstaChatClient exposes all follow, react, post, and reel react facade methods', () => {
  const client = new InstaChatClient({
    cookies: {
      sessionid: '100001%3Atoken%3A28',
      csrftoken: 'csrf_token',
      ds_user_id: '100001'
    }
  });

  const expectedMethods = [
    // Follow
    'follow',
    'unfollow',
    'followUser',
    'unfollowUser',
    'toggleFollow',
    'isFollowing',
    // Message React
    'react',
    'unreact',
    'sendReaction',
    'deleteReaction',
    // Post & Reel Create/Fetch/Delete
    'createPost',
    'postPhoto',
    'createCarouselPost',
    'postCarousel',
    'createReel',
    'postReel',
    'deletePost',
    'getPost',
    'getReel',
    'getUserPosts',
    'getUserReels',
    // Post & Reel & Story React / Comment / Save
    'likePost',
    'unlikePost',
    'reactPost',
    'unreactPost',
    'likeReel',
    'unlikeReel',
    'reactReel',
    'unreactReel',
    'likeStory',
    'unlikeStory',
    'reactStory',
    'commentOnPost',
    'commentOnReel',
    'deleteComment',
    'likeComment',
    'unlikeComment',
    'getPostComments',
    'getPostLikers',
    'savePost',
    'unsavePost'
  ];

  for (const method of expectedMethods) {
    assert.equal(typeof client[method], 'function', `Expected client.${method} to be a function`);
  }

  assert.ok(client.posts instanceof PostsService);
  assert.equal(client.posts.usersService, client.users);
  assert.equal(client.posts.reactionsService, client.reactions);
  assert.equal(client.reactions.conversationsService, client.conversations);
});
