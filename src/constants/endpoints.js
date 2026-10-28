'use strict';

/**
 * Instagram Web Direct Messaging Endpoints
 */
const BASE_URL = 'https://www.instagram.com';
const API_BASE_URL = 'https://i.instagram.com';

const Endpoints = Object.freeze({
  BASE_URL,
  API_BASE_URL,

  // Inbox & Threads
  INBOX: `${API_BASE_URL}/api/v1/direct_v2/inbox/`,
  PENDING_INBOX: `${API_BASE_URL}/api/v1/direct_v2/pending_inbox/`,
  THREAD: (threadId) => `${API_BASE_URL}/api/v1/direct_v2/threads/${threadId}/`,
  CREATE_GROUP_THREAD: `${API_BASE_URL}/api/v1/direct_v2/create_group_thread/`,
  IN_THREAD_SEARCH: `${API_BASE_URL}/api/v1/direct_v2/in_thread_message_search/`,

  // Group & Thread Management
  THREAD_UPDATE_TITLE: (threadId) => `${API_BASE_URL}/api/v1/direct_v2/threads/${threadId}/update_title/`,
  THREAD_UPDATE_IMAGE: (threadId) => `${API_BASE_URL}/api/v1/direct_v2/threads/${threadId}/broadcast/update_thread_image/`,
  THREAD_ADD_USERS: (threadId) => `${API_BASE_URL}/api/v1/direct_v2/threads/${threadId}/add_user/`,
  THREAD_REMOVE_USERS: (threadId) => `${API_BASE_URL}/api/v1/direct_v2/threads/${threadId}/remove_users/`,
  THREAD_ADD_ADMINS: (threadId) => `${API_BASE_URL}/api/v1/direct_v2/threads/${threadId}/add_admins/`,
  THREAD_REMOVE_ADMINS: (threadId) => `${API_BASE_URL}/api/v1/direct_v2/threads/${threadId}/remove_admins/`,
  THREAD_LEAVE: (threadId) => `${API_BASE_URL}/api/v1/direct_v2/threads/${threadId}/leave/`,
  THREAD_HIDE: (threadId) => `${API_BASE_URL}/api/v1/direct_v2/threads/${threadId}/hide/`,
  THREAD_MUTE: (threadId) => `${API_BASE_URL}/api/v1/direct_v2/threads/${threadId}/mute/`,
  THREAD_UNMUTE: (threadId) => `${API_BASE_URL}/api/v1/direct_v2/threads/${threadId}/unmute/`,
  THREAD_PIN: (threadId) => `${API_BASE_URL}/api/v1/direct_v2/threads/${threadId}/pin_thread/`,
  THREAD_UNPIN: (threadId) => `${API_BASE_URL}/api/v1/direct_v2/threads/${threadId}/unpin_thread/`,
  THREAD_APPROVE: (threadId) => `${API_BASE_URL}/api/v1/direct_v2/threads/${threadId}/approve/`,
  THREAD_DECLINE: (threadId) => `${API_BASE_URL}/api/v1/direct_v2/threads/${threadId}/decline/`,
  THREAD_APPROVE_MULTIPLE: `${API_BASE_URL}/api/v1/direct_v2/threads/approve_multiple/`,
  THREAD_DECLINE_MULTIPLE: `${API_BASE_URL}/api/v1/direct_v2/threads/decline_multiple/`,
  THREAD_SET_NICKNAME: (threadId) => `${API_BASE_URL}/api/v1/direct_v2/threads/${threadId}/set_user_nickname/`,

  // Messaging Actions
  BROADCAST_TEXT: `${API_BASE_URL}/api/v1/direct_v2/threads/broadcast/text/`,
  BROADCAST_REACTION: `${API_BASE_URL}/api/v1/direct_v2/threads/broadcast/reaction/`,
  BROADCAST_FORWARD: `${API_BASE_URL}/api/v1/direct_v2/threads/broadcast/forward/`,
  BROADCAST_LINK: `${API_BASE_URL}/api/v1/direct_v2/threads/broadcast/link/`,
  BROADCAST_MEDIA_SHARE: `${API_BASE_URL}/api/v1/direct_v2/threads/broadcast/media_share/`,
  BROADCAST_CLIP_SHARE: `${API_BASE_URL}/api/v1/direct_v2/threads/broadcast/clip/`,
  BROADCAST_STORY_SHARE: `${API_BASE_URL}/api/v1/direct_v2/threads/broadcast/story_share/`,
  BROADCAST_PROFILE: `${API_BASE_URL}/api/v1/direct_v2/threads/broadcast/profile/`,
  BROADCAST_ANIMATED_MEDIA: `${API_BASE_URL}/api/v1/direct_v2/threads/broadcast/animated_media/`,
  BROADCAST_STICKER: `${API_BASE_URL}/api/v1/direct_v2/threads/broadcast/static_stickers/`,
  GIPHY_DIRECT_SEARCH: `${API_BASE_URL}/api/v1/direct_v2/giphy_gifs/`,
  THREAD_CREATE_POLL: (threadId) => `${API_BASE_URL}/api/v1/direct_v2/threads/${threadId}/group_poll/create/`,
  THREAD_VOTE_POLL: (threadId, pollId) => `${API_BASE_URL}/api/v1/direct_v2/threads/${threadId}/group_poll/${pollId}/vote/`,
  THREAD_REACTION: (threadId, itemId) => `${API_BASE_URL}/api/v1/direct_v2/threads/${threadId}/items/${itemId}/send_reaction/`,
  DELETE_REACTION: (threadId, itemId) => `${API_BASE_URL}/api/v1/direct_v2/threads/${threadId}/items/${itemId}/delete_reaction/`,
  DELETE_MESSAGE: (threadId, itemId) => `${API_BASE_URL}/api/v1/direct_v2/threads/${threadId}/items/${itemId}/delete/`,
  EDIT_MESSAGE: (threadId, itemId) => `${API_BASE_URL}/api/v1/direct_v2/threads/${threadId}/items/${itemId}/edit_message/`,
  PIN_MESSAGE: (threadId, itemId) => `${API_BASE_URL}/api/v1/direct_v2/threads/${threadId}/items/${itemId}/pin/`,
  UNPIN_MESSAGE: (threadId, itemId) => `${API_BASE_URL}/api/v1/direct_v2/threads/${threadId}/items/${itemId}/unpin/`,
  SEEN_MESSAGE: (threadId, itemId) => `${API_BASE_URL}/api/v1/direct_v2/threads/${threadId}/items/${itemId}/seen/`,
  ACTIVITY_STATUS: (threadId) => `${API_BASE_URL}/api/v1/direct_v2/threads/${threadId}/activity_status_update/`,
  SET_THEME: (threadId) => `${API_BASE_URL}/api/v1/direct_v2/threads/${threadId}/set_theme/`,

  // Media Upload (Rupload pipeline)
  RUPLOAD_MESSENGER_IMAGE: (uploadId) => `https://rupload.instagram.com/messenger_image/${uploadId}`,
  RUPLOAD_MESSENGER_VIDEO: (uploadId) => `https://rupload.instagram.com/messenger_video/${uploadId}`,
  RUPLOAD_MESSENGER_AUDIO: (uploadId) => `https://rupload.instagram.com/messenger_audio/${uploadId}`,
  RUPLOAD_MESSENGER_GIF: (uploadId) => `https://rupload.instagram.com/messenger_gif/${uploadId}`,
  RUPLOAD_PHOTO: (uploadId) => `${API_BASE_URL}/rupload_igphoto/${uploadId}`,
  RUPLOAD_VIDEO: (uploadId) => `https://rupload.instagram.com/rupload_igvideo/${uploadId}`,
  RUPLOAD_VOICE: (uploadId) => `${API_BASE_URL}/rupload_igvoice/${uploadId}`,
  CONFIGURE_PHOTO: `${API_BASE_URL}/api/v1/direct_v2/threads/broadcast/configure_photo/`,
  CONFIGURE_VIDEO: `${API_BASE_URL}/api/v1/direct_v2/threads/broadcast/configure_video/`,
  CONFIGURE_VOICE: `${API_BASE_URL}/api/v1/direct_v2/threads/broadcast/configure_voice/`,

  // Users, Profiles, Search, Moderation & Friendships
  USER_WEB_PROFILE: `${BASE_URL}/api/v1/users/web_profile_info/`,
  USER_INFO: (userId) => `${API_BASE_URL}/api/v1/users/${userId}/info/`,
  USER_INFO_WEB: (userId) => `${BASE_URL}/api/v1/users/${userId}/info/`,
  SEARCH_USERS: `${BASE_URL}/api/v1/web/search/topsearch/`,
  SEARCH_USERS_V1: `${API_BASE_URL}/api/v1/users/search/`,
  FRIENDSHIP_STATUS: (userId) => `${BASE_URL}/api/v1/friendships/show/${userId}/`,
  FRIENDSHIP_STATUS_MANY: `${BASE_URL}/api/v1/friendships/show_many/`,
  FRIENDSHIP_FOLLOW: (userId) => `${BASE_URL}/api/v1/friendships/create/${userId}/`,
  FRIENDSHIP_UNFOLLOW: (userId) => `${BASE_URL}/api/v1/friendships/destroy/${userId}/`,
  FRIENDSHIP_REMOVE_FOLLOWER: (userId) => `${BASE_URL}/api/v1/friendships/remove_follower/${userId}/`,
  FRIENDSHIP_FOLLOWERS: (userId) => `${BASE_URL}/api/v1/friendships/${userId}/followers/`,
  FRIENDSHIP_FOLLOWING: (userId) => `${BASE_URL}/api/v1/friendships/${userId}/following/`,
  FRIENDSHIP_PENDING_REQUESTS: `${BASE_URL}/api/v1/friendships/pending/`,
  FRIENDSHIP_APPROVE_REQUEST: (userId) => `${BASE_URL}/api/v1/friendships/approve/${userId}/`,
  FRIENDSHIP_IGNORE_REQUEST: (userId) => `${BASE_URL}/api/v1/friendships/ignore/${userId}/`,
  FRIENDSHIP_MUTE_MEDIA: `${BASE_URL}/api/v1/friendships/mute_posts_or_story_from_follow/`,
  FRIENDSHIP_UNMUTE_MEDIA: `${BASE_URL}/api/v1/friendships/unmute_posts_or_story_from_follow/`,
  WEB_BLOCK_USER: (userId) => `${BASE_URL}/api/v1/web/friendships/${userId}/block/`,
  WEB_UNBLOCK_USER: (userId) => `${BASE_URL}/api/v1/web/friendships/${userId}/unblock/`,
  FRIENDSHIP_BLOCK: (userId) => `${BASE_URL}/api/v1/friendships/block/${userId}/`,
  FRIENDSHIP_UNBLOCK: (userId) => `${BASE_URL}/api/v1/friendships/unblock/${userId}/`,
  RESTRICT_USER: `${BASE_URL}/api/v1/restrict_action/restrict/`,
  UNRESTRICT_USER: `${BASE_URL}/api/v1/restrict_action/unrestrict/`,

  // Web client identifiers
  WEB_APP_ID: '936619743392459',
  ASBD_ID: '359341',

  // Modern Web GraphQL
  GRAPHQL: `${BASE_URL}/api/graphql`,
  GRAPHQL_DOCS: Object.freeze({
    INBOX: '27909866362025854',
    MESSAGE_REQUESTS: '39282737491373568',
    SEND_TEXT: '26911679871773184',
    SEND_MEDIA: '25766288509716264',
    EDIT_MESSAGE: '32480262318254796',
    UNSEND_MESSAGE: '26948700068153789',
    FORWARD_MEDIA: '29536362899300769',
    REACTION: '24374451552236906',
    MARK_READ: '27399783383056109',
    MARK_READ_VALIDATION: '35211594988486314',
    THREAD_DETAIL: '29697953149788513',
    CREATE_THREAD: '27529949946640544',
    ACCEPT_REQUEST: '36571001125823973',
    THEMES_CATALOG: '38559398347039873',
    SET_THEME: '27105231055765011',
    SEND_GIF: '32089613413987432',
    SEND_STICKER: '24640017885680534',
    SEND_AVATAR_STICKER: '24914262484908659',
    SHARE_LINK: '27277149101947973',
    SHARE_MEDIA: '27442850591982122',
    SHARE_REEL: '26212720875066239',
    SHARE_STORY: '26219781510996267',
    SHARE_STORY_REPLY: '26536543495958378',
    NICKNAMES_DIALOG: '37638783522379473',
    EDIT_THREAD_NAME_DIALOG: '35260317140280682',
    LEAVE_GROUP_DIALOG: '26916415887952019',
    GROUP_MEMBERSHIP_DIALOG: '38459217280393010',
    APPROVE_FOLLOW: '29064527116474163',
    IGNORE_FOLLOW: '27152710251093953',
    UNRESTRICT_USER: '29456204210646604'
  })
});

module.exports = Endpoints;
