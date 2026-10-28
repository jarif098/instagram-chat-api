'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  InstaChatClient,
  Events,
  Endpoints,
  Message,
  Conversation,
  ConversationsService,
  ThreadsService,
  MessagesService,
  MediaService,
  SharingService,
  ReadReceiptsService,
  NicknamesService,
  UsersService,
  ValidationError
} = require('../../src');
const RealtimeEngine = require('../../src/transport/realtime');

// --- 1. Models & Normalizers ---

test('Models: Message normalizes edits, pins, forwards, mentions, GIFs, links, reels, and polls', () => {
  const msg = Message.fromRaw({
    item_id: 'mid_900',
    thread_id: 'thread_1',
    user_id: '777',
    item_type: 'link',
    is_pinned: true,
    igd_is_forwarded: true,
    slide_edit_history: [{ text_body: 'Old text', timestamp_ms: '1729500000000' }],
    mentions: [{ mentioned_user_id: '888', username: 'bob', offset: 0, length: 4 }],
    link: {
      text: '@bob check https://example.com',
      link_context: {
        link_url: 'https://example.com',
        link_title: 'Example'
      }
    }
  }, '777');

  assert.equal(msg.isSelf, true);
  assert.equal(msg.isPinned, true);
  assert.equal(msg.isForwarded, true);
  assert.equal(msg.isEdited, true);
  assert.equal(msg.editHistory.length, 1);
  assert.equal(msg.editHistory[0].text, 'Old text');
  assert.equal(msg.mentions.length, 1);
  assert.equal(msg.mentions[0].userId, '888');
  assert.equal(msg.share.type, 'link');
  assert.equal(msg.share.url, 'https://example.com');

  const pollMsg = Message.fromRaw({
    item_id: 'poll_item_1',
    item_type: 'group_poll',
    group_poll: {
      poll_id: 'p_55',
      question: 'Best language?',
      options: [
        { id: '1', text: 'JavaScript', count: 5 },
        { id: '2', text: 'Rust', count: 3 }
      ]
    }
  });
  assert.equal(pollMsg.share.type, 'poll');
  assert.equal(pollMsg.share.pollId, 'p_55');
  assert.equal(pollMsg.share.options.length, 2);
});

test('Models: Conversation normalizes nicknames, adminUserIds, pinnedMessages, and readReceipts', () => {
  const conv = Conversation.fromRaw({
    as_ig_direct_thread: {
      thread_fbid: '111868',
      thread_id: '3402823668417103009',
      thread_title: 'Dev Squad',
      is_group: true,
      is_pinned: true,
      admin_user_ids: ['101'],
      users: [
        { id: '101', username: 'alice', interop_messaging_user_fbid: 'eimu_101' },
        { id: '202', username: 'bob', interop_messaging_user_fbid: 'eimu_202' }
      ],
      nicknames: [
        { participant_fbid: 'eimu_202', nickname: 'Bobby' }
      ],
      slide_read_receipts: [
        { participant_eimu_id: 'eimu_202', watermark_timestamp_ms: '1729500050000' }
      ],
      slide_messages: {
        edges: [
          {
            node: {
              id: 'mid_pinned_1',
              sender_fbid: 'eimu_101',
              text_body: 'Welcome rules!',
              timestamp_ms: '1729500000000',
              is_pinned: true
            }
          }
        ]
      }
    }
  }, '101');

  assert.equal(conv.id, '111868');
  assert.equal(conv.v2Id, '3402823668417103009');
  assert.equal(conv.isPinned, true);
  assert.deepEqual(conv.adminUserIds, ['101']);
  assert.equal(conv.nicknames['202'], 'Bobby');
  assert.equal(conv.pinnedMessages.length, 1);
  assert.equal(conv.pinnedMessages[0].id, 'mid_pinned_1');
  assert.equal(conv.readReceipts.length, 1);
  assert.equal(conv.readReceipts[0].userId, '202');
  assert.equal(conv.readReceipts[0].timestamp, 1729500050000);
});

// --- 2. Pillar 1: Group & Thread Management + Message Requests ---

test('ThreadsService: creates group via GraphQL and executes title, participants, admin, mute, pin, leave, delete', async () => {
  const calls = [];
  const session = {
    userId: '100',
    _dtsg: 'NAfdtsg',
    _lsd: 'lsd123',
    getCsrfToken: () => 'csrf_tok',
    _threadIgidMap: new Map([['gql_thread_1', 'v2_thread_1']]),
    _userInteropFbidMap: new Map([['201', 'eimu_201'], ['202', 'eimu_202']])
  };

  const mockTransport = {
    post: async (url, body) => {
      calls.push({ url, body });
      if (url === Endpoints.GRAPHQL && body.includes('useCreateOpenGroupThreadOffMsysMutation')) {
        return {
          data: {
            data: {
              xig_ig_direct_create_thread: {
                id: 'gql_thread_1',
                as_ig_direct_thread: {
                  id: 'gql_thread_1',
                  thread_key: 'gql_thread_1',
                  thread_subtype: 1
                }
              }
            }
          }
        };
      }
      return { data: { status: 'ok' } };
    }
  };

  const threads = new ThreadsService({ transport: mockTransport, session });

  const created = await threads.createGroupThread(['201', '202'], 'Core Team');
  assert.equal(created.id, 'gql_thread_1');
  assert.equal(created.title, 'Core Team');
  assert.ok(calls[0].body.includes('eimu_201'));
  assert.ok(calls[1].url.includes('/threads/v2_thread_1/update_title/'));

  const addRes = await threads.addParticipants('gql_thread_1', ['203']);
  assert.equal(addRes.success, true);
  assert.ok(calls.at(-1).url.includes('/threads/v2_thread_1/add_user/'));

  const remRes = await threads.removeParticipant('gql_thread_1', '203');
  assert.equal(remRes.success, true);
  assert.ok(calls.at(-1).url.includes('/threads/v2_thread_1/remove_users/'));

  const adminRes = await threads.promoteAdmin('gql_thread_1', '201');
  assert.equal(adminRes.success, true);
  assert.ok(calls.at(-1).url.includes('/threads/v2_thread_1/add_admins/'));

  const demoteRes = await threads.demoteAdmin('gql_thread_1', '201');
  assert.equal(demoteRes.success, true);
  assert.ok(calls.at(-1).url.includes('/threads/v2_thread_1/remove_admins/'));

  const muteRes = await threads.muteThread('gql_thread_1', true);
  assert.equal(muteRes.muted, true);
  assert.ok(calls.at(-1).url.includes('/threads/v2_thread_1/mute/'));

  const pinRes = await threads.pinThread('gql_thread_1', true);
  assert.equal(pinRes.pinned, true);
  assert.ok(calls.at(-1).url.includes('/threads/v2_thread_1/pin_thread/'));

  const imgRes = await threads.setImage('gql_thread_1', Buffer.alloc(512));
  assert.equal(imgRes.success, true);
  assert.ok(calls.at(-1).url.includes('/threads/v2_thread_1/broadcast/update_thread_image/'));

  const leaveRes = await threads.leaveThread('gql_thread_1');
  assert.equal(leaveRes.success, true);
  assert.ok(calls.at(-1).url.includes('/threads/v2_thread_1/leave/'));

  const delRes = await threads.deleteThread('gql_thread_1');
  assert.equal(delRes.success, true);
  assert.ok(calls.at(-1).url.includes('/threads/v2_thread_1/hide/'));
});

test('ConversationsService: pending requests GraphQL + accept/decline + searchInThread', async () => {
  const calls = [];
  const session = {
    userId: '100',
    _dtsg: 'NAfdtsg',
    _lsd: 'lsd123',
    getCsrfToken: () => 'csrf_tok'
  };

  const mockTransport = {
    get: async (url, config) => {
      calls.push({ method: 'GET', url, config });
      if (url === Endpoints.IN_THREAD_SEARCH) {
        return {
          data: {
            status: 'ok',
            items: [{ item_id: 'found_1', user_id: '202', text: 'deployment ready' }],
            has_more: false
          }
        };
      }
      return { data: { status: 'ok' } };
    },
    post: async (url, body) => {
      calls.push({ method: 'POST', url, body });
      if (body.includes('PolarisDirectMessageRequestQuery')) {
        return {
          data: {
            data: {
              get_slide_mailbox_for_iris_subscription: {
                threads_by_folder: {
                  edges: [{ node: { as_ig_direct_thread: { id: 'req_thread_1', thread_title: 'New Request' } } }],
                  page_info: { end_cursor: null, has_next_page: false }
                }
              }
            }
          }
        };
      }
      if (body.includes('useIGDirectAcceptMessageRequestMutation')) {
        return {
          data: {
            data: {
              ig_direct_accept_message_request: {
                id: 'req_thread_1',
                folder: 0,
                system_folder: 'INBOX'
              }
            }
          }
        };
      }
      return { data: { status: 'ok' } };
    }
  };

  const convService = new ConversationsService({ transport: mockTransport, session });

  const pending = await convService.getPendingInbox();
  assert.equal(pending.conversations.length, 1);
  assert.equal(pending.conversations[0].id, 'req_thread_1');

  const accepted = await convService.acceptMessageRequest('req_thread_1');
  assert.equal(accepted.success, true);
  assert.equal(accepted.threadId, 'req_thread_1');

  const declined = await convService.declineMessageRequest('req_thread_2');
  assert.equal(declined.success, true);
  assert.ok(calls.at(-1).url.includes('/threads/req_thread_2/decline/'));

  const searched = await convService.searchInThread('thread_99', 'deployment');
  assert.equal(searched.messages.length, 1);
  assert.equal(searched.messages[0].text, 'deployment ready');
});

// --- 3. Pillar 2: Advanced Message Actions ---

test('MessagesService: editMessage, pin/unpin, forwardMessage, and rich @mentions', async () => {
  const calls = [];
  const session = {
    userId: '100',
    _dtsg: 'NAfdtsg',
    _lsd: 'lsd123',
    getCsrfToken: () => 'csrf_tok'
  };

  const mockTransport = {
    post: async (url, body) => {
      calls.push({ url, body });
      if (body.includes('IGDirectTextSendMutation')) {
        return {
          data: {
            data: {
              xig_direct_text_send_with_slide_messaging_response: {
                id: 'mid_sent_1',
                message_id: 'mid_sent_1',
                timestamp_ms: '1729500000000'
              }
            }
          }
        };
      }
      if (body.includes('IGDirectEditMessageMutation')) {
        return {
          data: {
            data: {
              direct_edit_message_with_slide_messaging_response: {
                id: 'mid_sent_1',
                message_id: 'mid_sent_1',
                timestamp_ms: '1729500010000'
              }
            }
          }
        };
      }
      if (body.includes('IGDMediaForwardPublisherMutation')) {
        return {
          data: {
            data: {
              xig_direct_media_send_with_slide_messaging_response: {
                id: 'mid_fwd_media_1',
                message_id: 'mid_fwd_media_1',
                timestamp_ms: '1729500020000'
              }
            }
          }
        };
      }
      return { data: { status: 'ok', item_id: 'rest_fwd_1' } };
    }
  };

  const msgService = new MessagesService({
    transport: mockTransport,
    session,
    conversationsService: {
      resolveRestThreadId: (id) => id,
      getThread: async () => ({
        conversation: {
          pinnedMessages: [Message.fromRaw({ item_id: 'pin_1', text: 'Pinned!', is_pinned: true })]
        }
      })
    }
  });

  // Rich @mentions auto-offset calculation
  const sent = await msgService.sendTextMessage('thread_1', 'Hey @alice welcome!', {
    mentions: [{ userId: '555', username: 'alice' }]
  });
  assert.equal(sent.id, 'mid_sent_1');
  assert.equal(sent.mentions.length, 1);
  assert.equal(sent.mentions[0].offset, 4);
  assert.equal(sent.mentions[0].length, 6);

  // Edit message via IGDirectEditMessageMutation
  const edited = await msgService.editMessage('thread_1', 'mid_sent_1', 'Hey @alice welcome aboard!');
  assert.equal(edited.id, 'mid_sent_1');
  assert.equal(edited.text, 'Hey @alice welcome aboard!');
  assert.equal(edited.isEdited, true);

  // Pin / Unpin / Get Pinned
  const pinRes = await msgService.pinMessage('thread_1', 'mid_sent_1');
  assert.equal(pinRes.pinned, true);
  const unpinRes = await msgService.unpinMessage('thread_1', 'mid_sent_1');
  assert.equal(unpinRes.pinned, false);
  const pinnedList = await msgService.getPinnedMessages('thread_1');
  assert.equal(pinnedList.length, 1);

  // Forward media via GraphQL & item via REST
  const fwdMedia = await msgService.forwardMessage('thread_1', 'mid_1', 'thread_2', {
    attachmentFbid: '998877'
  });
  assert.equal(fwdMedia.id, 'mid_fwd_media_1');
  assert.equal(fwdMedia.isForwarded, true);

  const fwdRest = await msgService.forwardMessage('thread_1', 'mid_2', 'thread_2', { forceRest: true });
  assert.equal(fwdRest.isForwarded, true);
  assert.ok(calls.at(-1).url.includes('/broadcast/forward/'));
});

// --- 4. Pillar 3: Custom Chat Nicknames ---

test('NicknamesService: getNicknames, setNickname, clearNickname, and length validation', async () => {
  const calls = [];
  const session = { userId: '100', _dtsg: 'NAfdtsg', _lsd: 'lsd', getCsrfToken: () => 'csrf' };
  const mockTransport = {
    post: async (url, body) => {
      calls.push({ url, body });
      if (body.includes('IGDInboxInfoNicknamesDialogQuery')) {
        return {
          data: {
            data: {
              get_slide_thread_nullable: {
                as_ig_direct_thread: {
                  id: 'thread_nick',
                  users: [{ id: '202', interop_messaging_user_fbid: 'eimu_202' }],
                  nicknames: [{ participant_fbid: 'eimu_202', nickname: 'Captain' }]
                }
              }
            }
          }
        };
      }
      return { data: { status: 'ok' } };
    }
  };

  const nicknames = new NicknamesService({ transport: mockTransport, session });

  const map = await nicknames.getNicknames('thread_nick');
  assert.equal(map['202'], 'Captain');

  const setRes = await nicknames.setNickname('thread_nick', '202', 'Boss');
  assert.equal(setRes.nickname, 'Boss');
  assert.ok(calls.at(-1).url.includes('/set_user_nickname/'));

  const clearRes = await nicknames.clearNickname('thread_nick', '202');
  assert.equal(clearRes.nickname, '');

  await assert.rejects(
    () => nicknames.setNickname('thread_nick', '202', 'x'.repeat(40)),
    (err) => err instanceof ValidationError
  );
});

// --- 5. Pillar 4 (Moderation): Block, Restrict, Follow Requests, Mute Media ---

test('UsersService: block, unblock, restrict, unrestrict, approve/ignore follow requests, and mute media', async () => {
  const calls = [];
  const session = { userId: '100', _dtsg: 'NAfdtsg', _lsd: 'lsd', getCsrfToken: () => 'csrf' };
  const mockTransport = {
    get: async (url) => {
      calls.push({ url });
      return { data: { users: [{ pk: '301', username: 'requester' }] } };
    },
    post: async (url, body) => {
      calls.push({ url, body });
      if (body.includes('PolarisFollowRequestButtonsApproveMutation')) {
        return { data: { data: { xdt_friendships_approve_user: { __typename: 'XDTApproveUserFollowRequestResponse' } } } };
      }
      if (body.includes('PolarisFollowRequestButtonsIgnoreMutation')) {
        return { data: { data: { xdt_friendships_ignore_user: { __typename: 'XDTIgnoreUserFollowRequestResponse' } } } };
      }
      if (body.includes('usePolarisUnrestrictMutation')) {
        return { data: { data: { xdt_api__v1__restrict_action__unrestrict: { pk: '301', friendship_status: { is_restricted: false } } } } };
      }
      return { data: { status: 'ok' } };
    }
  };

  const users = new UsersService({ transport: mockTransport, session });

  const reqs = await users.getPendingFollowRequests();
  assert.equal(reqs.users.length, 1);
  assert.equal(reqs.users[0].username, 'requester');

  const approved = await users.approveFollowRequest('301');
  assert.equal(approved.friendshipStatus.followedBy, true);

  const ignored = await users.ignoreFollowRequest('301');
  assert.equal(ignored.friendshipStatus.incomingRequest, false);

  const blocked = await users.blockUser('301');
  assert.equal(blocked.friendshipStatus.blocking, true);
  assert.ok(calls.at(-1).url.includes('/web/friendships/301/block/'));

  const unblocked = await users.unblockUser('301');
  assert.equal(unblocked.friendshipStatus.blocking, false);

  const restricted = await users.restrictUser('301');
  assert.equal(restricted.isRestricted, true);
  assert.ok(calls.at(-1).url.includes('/restrict_action/restrict/'));

  const unrestricted = await users.unrestrictUser('301');
  assert.equal(unrestricted.isRestricted, false);

  const muted = await users.muteUserMedia('301', { posts: true, stories: true });
  assert.equal(muted.friendshipStatus.muting, true);
  assert.ok(calls.at(-1).body.includes('target_posts_author_id=301'));
  assert.ok(calls.at(-1).body.includes('target_reel_author_id=301'));

  const unmuted = await users.unmuteUserMedia('301', { posts: true });
  assert.equal(unmuted.friendshipStatus.muting, false);
});

// --- 6. Pillar 5: Native Sharing, GIFs, Stickers, Polls & GraphQL Video ---

test('SharingService: shortcode decoder, GIFs, stickers, links, posts, reels, stories, profiles, and polls', async () => {
  // Shortcode -> numeric 64-bit mediaId math check ("B" = 1 -> 1)
  const decoded = SharingService.resolveMediaId('https://www.instagram.com/reel/C8abc123XYZ/');
  assert.match(decoded, /^\d+$/);
  assert.equal(SharingService.resolveMediaId('34567890123_999'), '34567890123');

  const session = { userId: '100', _dtsg: 'NAfdtsg', _lsd: 'lsd', getCsrfToken: () => 'csrf' };
  const mockTransport = {
    get: async () => ({
      data: {
        results: [{ id: 'giphy_cat_1', title: 'Cat Dance', images: { fixed_height: { url: 'https://g.co/cat.gif' } } }]
      }
    }),
    post: async (url, body) => {
      if (body.includes('IGDirectAnimatedMediaSendMutation')) {
        return { data: { data: { direct_animated_media_send: { id: 'm_gif', message_id: 'm_gif' } } } };
      }
      if (body.includes('IGDirectStoreStickerSendMutation')) {
        return { data: { data: { direct_store_sticker_send_with_slide_response: { id: 'm_stk', message_id: 'm_stk', timestamp_ms: '1729500000000' } } } };
      }
      if (body.includes('IGDirectLinkShareMutation')) {
        return { data: { data: { direct_link_share_with_slide_response: { id: 'm_lnk', message_id: 'm_lnk', timestamp_ms: '1729500000000' } } } };
      }
      if (body.includes('IGDirectMediaShareMutation')) {
        return { data: { data: { direct_media_share_with_slide_response: { id: 'm_post', message_id: 'm_post', timestamp_ms: '1729500000000' } } } };
      }
      if (body.includes('IGDirectReelShareMutation')) {
        return { data: { data: { xig_direct_clip_share_with_slide_msg_response: { id: 'm_reel', message_id: 'm_reel', timestamp_ms: '1729500000000' } } } };
      }
      if (body.includes('IGDirectStoryShareMutation')) {
        return { data: { data: { direct_story_share_with_slide_response: { id: 'm_story', message_id: 'm_story', timestamp_ms: '1729500000000' } } } };
      }
      return { data: { status: 'ok', item_id: 'rest_item_1', poll_id: 'poll_777' } };
    }
  };

  const sharing = new SharingService({
    transport: mockTransport,
    session,
    usersService: { getUserByUsername: async () => ({ id: '444', username: 'jarifcreates' }) }
  });

  const gifMsg = await sharing.sendGif('thread_1', 'funny cat');
  assert.equal(gifMsg.id, 'm_gif');
  assert.equal(gifMsg.media.type, 'gif');

  const stkMsg = await sharing.sendSticker('thread_1', '9001');
  assert.equal(stkMsg.id, 'm_stk');
  assert.equal(stkMsg.media.type, 'sticker');

  const linkMsg = await sharing.sendLink('thread_1', 'Read https://nodejs.org now');
  assert.equal(linkMsg.id, 'm_lnk');
  assert.equal(linkMsg.share.url, 'https://nodejs.org');

  const postMsg = await sharing.sharePost('thread_1', 'https://www.instagram.com/p/C8abc123XYZ/');
  assert.equal(postMsg.id, 'm_post');
  assert.equal(postMsg.share.type, 'post');

  const reelMsg = await sharing.shareReel('thread_1', 'https://www.instagram.com/reel/C8abc123XYZ/', { text: 'Watch this!' });
  assert.equal(reelMsg.id, 'm_reel');
  assert.equal(reelMsg.share.type, 'reel');

  const storyMsg = await sharing.shareStory('thread_1', '3456789012', { reelId: '444' });
  assert.equal(storyMsg.id, 'm_story');
  assert.equal(storyMsg.share.type, 'story');

  const profMsg = await sharing.shareProfile('thread_1', '@jarifcreates');
  assert.equal(profMsg.share.type, 'profile');
  assert.equal(profMsg.share.userId, '444');

  const poll = await sharing.createPoll('thread_1', 'Ship v2?', ['Yes', 'Absolutely']);
  assert.equal(poll.success, true);
  assert.equal(poll.pollId, 'poll_777');

  const vote = await sharing.votePoll('thread_1', 'poll_777', ['0']);
  assert.equal(vote.success, true);
});

test('MediaService: sends video via modern messenger_video + IGDirectMediaSendMutation', async () => {
  const calls = [];
  const media = new MediaService({
    session: { userId: '100', _dtsg: 'NAfdtsg', _lsd: 'lsd', getCsrfToken: () => 'csrf' },
    transport: {
      post: async (url, body, config) => {
        calls.push({ url, body, config });
        if (url.includes('/messenger_video/')) {
          return { data: { media_id_str: 'vid_fbid_555' } };
        }
        return {
          data: {
            data: {
              xig_direct_media_send_with_slide_messaging_response: {
                id: 'mid_vid_1',
                message_id: 'mid_vid_1',
                timestamp_ms: '1729500000000'
              }
            }
          }
        };
      }
    }
  });

  const sent = await media.sendVideo('thread_1', Buffer.alloc(1024));
  assert.equal(sent.id, 'mid_vid_1');
  assert.equal(sent.media.type, 'video');
  assert.ok(calls[0].url.includes('/messenger_video/'));
  assert.ok(calls[1].body.includes('vid_fbid_555'));
});

// --- 7. Pillar 6: Modern GraphQL Read Receipts & Realtime Events ---

test('ReadReceiptsService: markSeen executes useIGDMarkThreadAsReadMutation when GraphQL responds', async () => {
  let capturedBody = '';
  const service = new ReadReceiptsService({
    session: {
      _dtsg: 'NAfdtsg',
      _lsd: 'lsd',
      getCsrfToken: () => 'csrf',
      _threadIgidMap: new Map([['fbid_1', 'igid_999']])
    },
    transport: {
      post: async (url, body) => {
        capturedBody = body;
        return {
          data: {
            data: {
              xig_direct_item_seen_mutation_with_slide_messaging_response: {
                participant_eimu_id: 'eimu_1',
                watermark_timestamp_ms: '1729500999000'
              }
            }
          }
        };
      }
    }
  });

  const res = await service.markSeen('fbid_1', 'mid_50');
  assert.equal(res.success, true);
  assert.equal(res.watermarkTimestampMs, '1729500999000');
  assert.ok(capturedBody.includes('igid_999'));
});

test('RealtimeEngine: emits MESSAGE_EDIT, MESSAGE_UNSENT, READ_RECEIPT, and THREAD_UPDATE', async () => {
  let step = 0;
  const mockConversationsService = {
    getInbox: async () => {
      step++;
      if (step === 1) {
        return {
          conversations: [
            {
              id: 't_1',
              title: 'Alpha Group',
              themeId: 'default',
              lastActivityAt: 1000,
              readReceipts: [{ userId: '202', timestamp: 1000 }],
              messages: [
                { id: 'm_2', senderId: '202', text: 'Typo text', timestamp: 1000, reactions: [] },
                { id: 'm_1', senderId: '100', text: 'Anchor msg', timestamp: 900, reactions: [] }
              ]
            }
          ]
        };
      }
      if (step === 2) {
        // m_2 edited, read receipt advanced, title & theme updated
        return {
          conversations: [
            {
              id: 't_1',
              title: 'Omega Group',
              themeId: 'cyberpunk',
              lastActivityAt: 2000,
              readReceipts: [{ userId: '202', timestamp: 2000 }],
              messages: [
                { id: 'm_2', senderId: '202', text: 'Fixed text!', isEdited: true, editHistory: [{ text: 'Typo text' }], timestamp: 1000, reactions: [] },
                { id: 'm_1', senderId: '100', text: 'Anchor msg', timestamp: 900, reactions: [] }
              ]
            }
          ]
        };
      }
      // Step 3: m_2 unsent (vanished while older anchor m_1 remains)
      return {
        conversations: [
          {
            id: 't_1',
            title: 'Omega Group',
            themeId: 'cyberpunk',
            lastActivityAt: 3000,
            readReceipts: [{ userId: '202', timestamp: 2000 }],
            messages: [
              { id: 'm_1', senderId: '100', text: 'Anchor msg', timestamp: 900, reactions: [] }
            ]
          }
        ]
      };
    }
  };

  const engine = new RealtimeEngine({
    session: { userId: '100' },
    conversationsService: mockConversationsService,
    pollIntervalMs: 1000
  });

  const edits = [];
  const unsents = [];
  const receipts = [];
  const threadUpdates = [];

  engine.on(Events.MESSAGE_EDIT, (e) => edits.push(e));
  engine.on(Events.MESSAGE_UNSENT, (u) => unsents.push(u));
  engine.on(Events.READ_RECEIPT, (r) => receipts.push(r));
  engine.on(Events.THREAD_UPDATE, (t) => threadUpdates.push(t));

  await engine.initializeBaseline();
  assert.equal(edits.length, 0);
  assert.equal(receipts.length, 0);

  await engine.pollOnce();
  assert.equal(edits.length, 1);
  assert.equal(edits[0].previousText, 'Typo text');
  assert.equal(edits[0].newText, 'Fixed text!');
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].userId, '202');
  assert.equal(threadUpdates.length, 1);
  assert.equal(threadUpdates[0].changes.title.to, 'Omega Group');
  assert.equal(threadUpdates[0].changes.themeId.to, 'cyberpunk');

  await engine.pollOnce();
  assert.equal(unsents.length, 1);
  assert.equal(unsents[0].messageId, 'm_2');
});

test('InstaChatClient: exposes all 6 core feature pillars on top-level client facade', () => {
  const client = new InstaChatClient({
    cookies: { sessionid: 'mock_sess', csrftoken: 'mock_csrf', ds_user_id: '100' }
  });

  const expectedMethods = [
    // Group & Thread Management + Requests
    'createConversation', 'createGroupThread', 'setThreadTitle', 'setThreadImage',
    'addParticipants', 'removeParticipant', 'promoteAdmin', 'demoteAdmin',
    'leaveThread', 'deleteThread', 'muteThread', 'pinThread',
    'searchInThread', 'acceptMessageRequest', 'declineMessageRequest',
    // Advanced Message Actions
    'editMessage', 'pinMessage', 'unpinMessage', 'getPinnedMessages', 'forwardMessage',
    // Custom Chat Nicknames
    'getNicknames', 'setNickname', 'clearNickname',
    // Native Sharing, GIFs, Stickers & Polls
    'searchGifs', 'sendGif', 'sendSticker', 'sendLink',
    'sharePost', 'shareMedia', 'shareReel', 'shareStory', 'shareProfile',
    'createPoll', 'votePoll',
    // User Moderation & Follow Requests
    'getPendingFollowRequests', 'approveFollowRequest', 'ignoreFollowRequest',
    'blockUser', 'unblockUser', 'restrictUser', 'unrestrictUser',
    'muteUserMedia', 'unmuteUserMedia'
  ];

  for (const method of expectedMethods) {
    assert.equal(typeof client[method], 'function', `Expected client.${method} to be a function`);
  }
});
