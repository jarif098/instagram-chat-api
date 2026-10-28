# Feature Compatibility Matrix

This document provides a realistic assessment of all Instagram Direct Messaging capabilities supported by `instachat-api`, based on reverse-engineered web protocol observations and controlled testing.

## Compatibility Matrix

| Feature | Status | Primary Endpoint / Mechanism | Transport | Test Status | Limitations & Notes |
|---|---|---|---|---|---|
| **Session Import (Cookies)** | **Supported** | Local file / Object configuration | Local I/O | Unit & Integration Tested | Loads `sessionid`, `csrftoken`, `ds_user_id` without browser binaries. |
| **Session Health Verification** | **Supported** | `GET /api/v1/direct_v2/inbox/?limit=1` | HTTP GET | Unit & Integration Tested | Validates session validity and handles expiration / checkpoint detection. |
| **Retrieve Inbox Threads** | **Supported** | `GET /api/v1/direct_v2/inbox/` | HTTP GET | Unit & Integration Tested | Full thread metadata, participants, snippet preview, unread counts. |
| **Inbox Pagination** | **Supported** | `GET /api/v1/direct_v2/inbox/?cursor={cursor}` | HTTP GET | Unit Tested | Paginate older threads using `oldest_cursor`. |
| **Retrieve Thread History** | **Supported** | `GET /api/v1/direct_v2/threads/{thread_id}/` | HTTP GET | Unit & Integration Tested | Returns full message list, item types, reactions, and sender details. |
| **Thread Message Pagination** | **Supported** | `GET /api/v1/direct_v2/threads/{thread_id}/?cursor={cursor}` | HTTP GET | Unit Tested | Retrieves older messages backwards in time. |
| **Send Text Message** | **Supported** | `POST /api/graphql` (`IGDirectTextSendMutation`) + REST fallback | GraphQL / REST | Unit & Integration Tested | Full UTF-8 support, emojis, rich `@mentions` (`options.mentions`), client deduplication. |
| **Reply to Message** | **Supported** | `POST /api/graphql` (`IGDirectTextSendMutation`) + REST fallback | GraphQL / REST | Unit Tested | Contextual replies with `replyToItemId` and quoted `replyTo` resolution. |
| **Edit Message** | **Supported** | `POST /api/graphql` (`IGDirectEditMessageMutation`) + REST fallback | GraphQL / REST | Unit Tested | Edits sent messages (within Instagram's 15-minute edit window). |
| **Forward Message** | **Supported** | `IGDirectTextSendMutation` / `IGDMediaForwardPublisherMutation` + `/broadcast/forward/` | GraphQL / REST | Unit Tested | Forwards text and media items across threads. |
| **Pin / Unpin / Get Pinned Messages** | **Supported** | `POST /api/v1/direct_v2/threads/{id}/items/{id}/pin|unpin/` | HTTP POST / GraphQL | Unit Tested | Pins or unpins messages and reads `conversation.pinnedMessages`. |
| **Send Reaction (Emoji/Like)** | **Supported** | `POST /api/graphql` (`IGDirectReactionSendMutation`) + REST fallback | GraphQL / REST | Unit Tested | Supports default like (`❤️`) and custom Unicode emojis. |
| **Delete / Remove Reaction** | **Supported** | `POST /api/graphql` (`IGDirectReactionSendMutation` `deleted`) + REST fallback | GraphQL / REST | Unit Tested | Removes reaction placed by the authenticated user. |
| **Unsend Message** | **Supported** | `POST /api/graphql` (`IGDMessageUnsendDialogOffMsysMutation`) + REST fallback | GraphQL / REST | Unit Tested | Permitted only for messages originally sent by the authorized user. |
| **Mark Seen (Read Receipt)** | **Supported** | `POST /api/graphql` (`useIGDMarkThreadAsReadMutation`) + REST fallback | GraphQL / REST | Unit Tested | Updates server-side read watermark via GraphQL with REST fallback. |
| **Typing Indicator** | **Supported** | `POST /api/v1/direct_v2/threads/{id}/activity_status_update/` | HTTP POST | Unit Tested | Sends `activity_status: 1` (typing) and `activity_status: 0` (stopped). |
| **Group & Thread Management** | **Supported** | `useCreateOpenGroupThreadOffMsysMutation` + `/direct_v2/threads/{id}/...` | GraphQL / REST | Unit Tested | Create group/1:1, set title & photo, add/remove members, promote/demote admins, mute, pin, leave, delete, in-thread search. |
| **Message Requests Inbox** | **Supported** | `PolarisDirectMessageRequestQuery` & `useIGDirectAcceptMessageRequestMutation` | GraphQL / REST | Unit Tested | List pending DM requests and accept or decline threads. |
| **Custom Chat Nicknames** | **Supported** | `IGDInboxInfoNicknamesDialogQuery` + `/set_user_nickname/` | GraphQL / REST | Unit Tested | Inspect, set (up to 32 chars), and clear participant nicknames. |
| **Native GIFs, Stickers, Links & Shares** | **Supported** | `IGDirectAnimatedMediaSendMutation`, `IGDirectStoreStickerSendMutation`, `IGDirectLinkShareMutation`, `IGDirectMediaShareMutation`, `IGDirectReelShareMutation`, `IGDirectStoryShareMutation` | GraphQL / REST | Unit Tested | GIPHY search/send, stickers, rich links, post/reel/story/profile shares (with automatic shortcode -> mediaId decoding), and DM polls. |
| **Send Image Attachment** | **Supported** | `messenger_image` + `IGDirectMediaSendMutation` (+ REST fallback) | Rupload + GraphQL | Unit & Integration Tested | Validates JPEG/PNG/WebP/GIF formats, uploads binary stream, publishes attachment. |
| **Send Video Attachment** | **Supported** | `messenger_video` + `IGDirectMediaSendMutation` (+ REST fallback) | Rupload + GraphQL | Unit Tested | Supports MP4/MOV video via modern GraphQL & legacy configure fallback. |
| **Send Audio Attachment** | **Supported** | `messenger_audio` + `IGDirectMediaSendMutation` (+ REST fallback) | Rupload + GraphQL | Unit Tested | Supports voice notes and audio clips (AAC/M4A/MP3/WAV). |
| **Download Media** | **Supported** | Direct CDN stream GET | HTTP GET | Unit Tested | Downloads original photo/video/audio URLs provided in thread items. |
| **Set / Reset Chat Theme** | **Supported** | `POST /api/graphql` (`useIGDUpdateChatThemeOffMsysMutation`) | GraphQL POST (+ REST fallback) | Unit Tested | Switches or resets themes by name, slug, alias, `#index`, `random`, or numeric FBID. |
| **List / Search / Inspect Chat Themes** | **Supported** | `POST /api/graphql` (`IGDInboxInfoThemesDialogQuery`) | GraphQL POST (+ 42 built-in presets) | Unit Tested | Live catalog of 75+ selectable themes + active thread theme & gradient inspection. |
| **Get User Profile (Username)** | **Supported** | `GET /api/v1/users/web_profile_info/?username={u}` | HTTP GET | Unit Tested | Full bio, follower/following/media counts, HD avatar, badges, pronouns. |
| **Get User Profile (User ID)** | **Supported** | `GET /api/v1/users/{id}/info/` | HTTP GET | Unit Tested | Resolves numeric user ID to full `User` profile with web fallback. |
| **Search Users** | **Supported** | `GET /api/v1/web/search/topsearch/` | HTTP GET | Unit Tested | Searches users globally with `/api/v1/users/search/` fallback. |
| **Check Friendship Status** | **Supported** | `GET /api/v1/friendships/show/{id}/` & `POST .../show_many/` | HTTP GET/POST | Unit Tested | Returns following, followedBy, pending requests, bestie, restricted, blocking. |
| **Follow / Unfollow / Remove Follower** | **Supported** | `POST /api/v1/friendships/create|destroy|remove_follower/{id}/` | HTTP POST | Unit Tested | Supports public follow, private follow requests, unfollow, and follower removal. |
| **List Followers / Following** | **Supported** | `GET /api/v1/friendships/{id}/followers|following/` | HTTP GET | Unit Tested | Cursor-paginated via `nextMaxId`. |
| **User Moderation & Follow Requests** | **Supported** | `PolarisFollowRequestButtonsApprove|IgnoreMutation`, `usePolarisUnrestrictMutation`, `/web/friendships/{id}/block|unblock/` | GraphQL / REST | Unit Tested | Block/unblock, restrict/unrestrict, pending follow requests, approve/ignore, mute/unmute posts & stories. |
| **Realtime Events (`message`, `reaction`, `message_edit`, `message_unsent`, `read_receipt`, `thread_update`)** | **Supported (Adaptive Polling)** | Adaptive GraphQL + REST Polling (`PolarisDirectInboxQuery` & `IGDThreadDetailQuery`) | HTTP Loop | Unit & Integration Tested | Zero external binary dependencies; sliding-window dedup; edit/unsend/receipt/theme diffing. |
| **Realtime MQTT WebSocket** | **Unsupported / Blocked** | `wss://edge-chat.instagram.com/chat` | MQTT/Thrift | Documented Limitation | Binary thrift schema changes frequently; requires proprietary Meta JS runtime tokens. |
| **End-to-End Encrypted (E2EE) Chats** | **Unsupported / Blocked** | Meta Signal Protocol / E2EE threads | Client-side crypto | Documented Limitation | Chats flagged as E2EE cannot be read via standard REST endpoints without device keys. |
| **Direct Password Login** | **Restricted / Externalized** | `POST /api/v1/web/accounts/login/ajax/` | HTTP POST | Externalized to Research | Triggers CAPTCHA & checkpoint challenges in automated scripts. Use `research/session-extractor.js`. |

## Status Legend
- **Supported:** Fully implemented and verified in the production library.
- **Unsupported / Blocked:** Intentionally excluded or unsupported due to platform-level encryption, rapid protocol obsolescence, or security barriers.
- **Restricted / Externalized:** Handled safely via external research tools or manual import rather than unattended runtime execution.
