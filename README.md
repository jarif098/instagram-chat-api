# InstaChat API by JARiF

> **Unofficial Instagram Direct Messaging Library for Node.js**  
> *A lightweight, modular, event-driven Node.js library built from the ground up for Instagram Web direct messaging.*

---

## ⚠️ Legal & Platform Disclaimer

**This library is unofficial and is NOT affiliated with, sponsored by, or endorsed by Instagram or Meta Platforms, Inc.**

Interacting with Instagram via private internal endpoints (`direct_v2`) is subject to Meta's Terms of Service and Platform Policies. Unofficial automation may trigger account security checkpoints (`checkpoint_required`), temporary action blocks, or permanent account suspensions.

- Always test with secondary or dedicated development accounts.
- Do not use this library for cold messaging, spam, or high-velocity automation.
- Private web interfaces are undocumented and may change or break at Meta's discretion without notice.

---

## ✨ Features

- **Event-Driven Architecture:** Idiomatic Node.js `EventEmitter` API supporting real-time event subscriptions (`message`, `reaction`, `message_edit`, `message_unsent`, `read_receipt`, `thread_update`, `rate_limit`, `auth_error`, etc.).
- **Direct Messaging & Group Management Capabilities:**
  - Retrieve inbox conversations, pending message requests (`PolarisDirectMessageRequestQuery`),thread details (`IGDThreadDetailQuery`), and in-thread message search.
  - Create 1:1 or group threads (`useCreateOpenGroupThreadOffMsysMutation`), set group title & cover image, add/remove participants, promote/demote admins, mute, pin, leave, or delete threads, and accept/decline message requests.
  - Send direct text messages with full Unicode, emoji, and rich `@mentions` support.
  - Reply to, edit (`IGDirectEditMessageMutation`), forward (`IGDMediaForwardPublisherMutation`), pin/unpin, and unsend messages.
  - Send and remove emoji reactions (`IGDirectReactionSendMutation`).
  - Mark messages as seen via modern Web GraphQL (`useIGDMarkThreadAsReadMutation`) and broadcast typing indicators.
  - Inspect, set, and clear custom chat nicknames (`NicknamesService`).
  - Browse, search, inspect, switch, randomize, and reset chat themes via Instagram Web GraphQL (42 verified built-in presets + live 75+ theme catalog).
  - Share GIPHY GIFs, store stickers, rich preview links, posts, Reels, Stories, user profiles (with automatic shortcode/URL -> numeric `mediaId` decoding), and interactive DM polls (`SharingService`).
  - Upload photos, videos (`messenger_video`), and voice/audio clips via Instagram's resumable upload protocol (`rupload`) + GraphQL publishing.
  - Download media attachments from threads.
- **Users, Profiles, Friendships & Moderation API:**
  - Look up rich Instagram user profiles by `@username` or numeric User ID (bio, follower/following/post counts, HD profile picture, verification, privacy, business category, pronouns).
  - Search Instagram users globally by keyword or handle.
  - Inspect single or batch friendship statuses (`following`, `followedBy`, pending requests, close friends, restricted).
  - Follow, unfollow, remove followers, paginate follower/following lists, manage incoming follow requests (list, approve, ignore), block/unblock, restrict/unrestrict, and mute/unmute posts & stories.
- **Instagram Direct Notes API:**
  - View active 24-hour status notes across mutual followers and close friends (`getNotes`).
  - Retrieve current viewer's active note (`getMyNote`) or search notes by username (`getNoteByUser`).
  - Publish new text notes with custom visibility scope (`createNote`, up to 60 characters, `MUTUAL_FOLLOWERS` or `CLOSE_FRIENDS`).
  - Like and unlike notes in the inbox tray (`likeNote`, `unlikeNote`).
  - Delete active notes (`deleteNote`).
  - Send direct message replies to note authors referencing the active note (`replyToNote`).
- **Resilient Transport:** Built-in exponential backoff retry with full jitter, server `Retry-After` adherence, non-idempotent operation safeguards, and automated Set-Cookie rotation tracking.
- **Security & Privacy by Design:** Automated secret redaction across loggers, errors, and memory representations. No passwords or tokens logged or committed to version control.
- **Developer-Friendly:** Written in CommonJS (`require`), fully tested with Node.js built-in test runner (`node:test`), and zero external binary dependencies.

---

## 📊 Feature Compatibility Matrix

| Feature | Status | Transport / Endpoint | Notes |
|---|---|---|---|
| **Session Import** | Supported | Local file / Cookie map | Import via `session.json` or string |
| **Session Health Check** | Supported | `GET /api/v1/direct_v2/inbox/?limit=1` | Automatic validation on `.connect()` |
| **Get Inbox Threads** | Supported | `GET /api/v1/direct_v2/inbox/` | Full participant and message metadata |
| **Get Thread History** | Supported | `GET /api/v1/direct_v2/threads/{id}/` | Full history with pagination cursors |
| **Send Text Message** | Supported | `POST /api/v1/direct_v2/threads/broadcast/text/` | With deduplication `client_context` |
| **Reply to Message** | Supported | `POST /api/v1/direct_v2/threads/broadcast/text/` | Contextual replies with `replied_to_item_id` |
| **Reactions (Emoji / Like)** | Supported | `POST /api/v1/direct_v2/threads/broadcast/reaction/` | Custom Unicode emojis + standard like |
| **Unsend Message** | Supported | `POST /api/v1/direct_v2/threads/{id}/items/{id}/delete/` | Deletes user-sent message items |
| **Mark Seen (Read Receipts)** | Supported | `POST /api/v1/direct_v2/threads/{id}/items/{id}/seen/` | Updates server-side read cursor |
| **Typing Indicator** | Supported | `POST /api/v1/direct_v2/threads/{id}/activity_status_update/` | Sends typing / stopped typing status |
| **Chat Themes (List / Search / Set / Reset)** | Supported | `POST /api/graphql` (`IGDInboxInfoThemesDialogQuery` & `useIGDUpdateChatThemeOffMsysMutation`) | 42 built-in presets + 75+ live themes, current theme check, random & reset |
| **Send Image Attachment** | Supported | Multi-stage `/rupload_igphoto/` + configure | Supports JPEG / PNG (up to 15MB) |
| **Send Video Attachment** | Supported | Multi-stage `/rupload_igvideo/` + configure | Supports MP4/H.264 (up to 50MB) |
| **Send Audio Attachment** | Supported | Multi-stage `/rupload_igvoice/` + configure | Supports MP3 / AAC / M4A (up to 25MB) |
| **Download Media** | Supported | Direct CDN Stream GET | Downloads photos and audio to disk |
| **Get User Profile (Username / ID)** | Supported | `GET /api/v1/users/web_profile_info/` & `/users/{id}/info/` | Bio, counts, HD avatar, verification & privacy |
| **Search Users** | Supported | `GET /api/v1/web/search/topsearch/` | Global user & handle discovery |
| **Friendship Status & Follow/Unfollow** | Supported | `GET/POST /api/v1/friendships/...` | Single/batch status, follow, unfollow, followers/following |
| **Instagram Direct Notes (Get / Post / Delete / Like / Reply)** | Supported | `POST /graphql/query` (`InboxTrayRequest`) & `POST /api/v1/notes/...` | Full 24h status notes, music metadata, audience scope (mutual/close friends), like, and DM replies via `Bearer IGT:2` mobile protocol bridge |
| **Realtime Incoming Messages** | Supported | Adaptive Polling (with Deduplication) | Reliable, zero binary deps, configurable interval |
| **Realtime MQTT WebSocket** | Unsupported | `wss://edge-chat.instagram.com/chat` | Proprietary binary Thrift protocol; high breakage risk |
| **End-to-End Encrypted (E2EE)** | Blocked | Meta Signal E2EE Threads | E2EE chats require device-level keys not exposed via web REST |

---

## 📦 Requirements

- **Node.js:** `>= 18.0.0` (LTS recommended)
- **Module System:** CommonJS (`require` / `module.exports`)

---

## 🚀 Installation

```bash
npm install
```

> [!NOTE]
> The production package has only **one runtime dependency**: `axios`. No headless browsers, Chromium binaries, or Puppeteer are installed in the production tree.

---

## 🔑 Authentication Setup

Instagram Web uses cookie-based authentication (`sessionid`, `csrftoken`, `ds_user_id`). Direct headless username/password submissions trigger automated bot challenges (reCAPTCHA v2/Enterprise, device integrity checks).

### 1. Exporting Session Cookies

The safest and most reliable way to authenticate without triggering bot checkpoints is by using active browser session cookies (`sessionid`, `csrftoken`, `ds_user_id`):

- **Option A (Browser Extension):** Install [Cookie-Editor](https://cookie-editor.com/) in Chrome or Firefox, go to `instagram.com`, click **Export -> Export as JSON**, and save it as `cookie.json` in your project root.
- **Option B (Browser DevTools):** Open Instagram in your browser -> Press `F12` -> Go to **Application** -> **Cookies** -> `https://www.instagram.com` -> Copy `sessionid`, `csrftoken`, and `ds_user_id`.

### 2. Loading Session in Code

```javascript
const { InstaChatClient } = require('instachat-api');

// Method 1: Load from cookie.json / session.json file (Recommended)
const client = new InstaChatClient({
  sessionPath: './cookie.json'
});

// Method 2: Pass cookies directly in code or environment variables
const client = new InstaChatClient({
  cookies: {
    sessionid: process.env.IG_SESSION_ID,
    csrftoken: process.env.IG_CSRF_TOKEN,
    ds_user_id: process.env.IG_USER_ID
  }
});
```

---

## 🛠️ Configuration

You can configure `InstaChatClient` via a `config.json` file in your project root or by passing an options object to the constructor.

### Example `config.json`
```json
{
  "sessionPath": "./data/session.json",
  "pollIntervalMs": 3000,
  "requestTimeoutMs": 15000,
  "maxRetries": 2,
  "debug": false
}
```

### Configuration Options
| Option | Type | Default | Description |
|---|---|---|---|
| `sessionPath` | `string` | `./data/session.json` | Path to serialized session JSON file. |
| `pollIntervalMs` | `number` | `3000` | Realtime polling interval in milliseconds (min `1000`). |
| `requestTimeoutMs` | `number` | `15000` | HTTP request timeout in milliseconds. |
| `maxRetries` | `number` | `2` | Maximum retry attempts for transient network failures. |
| `debug` | `boolean` | `false` | Enable verbose, sanitized debug logging. |
| `userAgent` | `string` | Desktop Chrome | Custom desktop browser User-Agent string. |

---

## 💡 Quick Start & Usage Examples

### 1. Basic Connection & Listening to Incoming Messages

```javascript
const { InstaChatClient } = require('instachat-api');

const client = new InstaChatClient({
  sessionPath: './data/session.json'
});

client.on('ready', () => {
  console.log('Client is ready for direct messaging!');
});

client.on('message', async (message) => {
  console.log(`[New message] ${message.sender.username}: ${message.text}`);

  // Auto-reply to "ping"
  if (!message.isSelf && message.text.toLowerCase() === 'ping') {
    await client.sendMessage(message.threadId, 'pong 🏓');
  }
});

client.on('reaction', (reaction) => {
  console.log(`[Reaction] ${reaction.senderId} reacted with ${reaction.emoji} on message ${reaction.messageId}`);
});

client.on('rate_limit', (err) => {
  console.warn(`Rate limit encountered. Backing off for ${err.retryAfter}s...`);
});

client.on('auth_error', (err) => {
  console.error('Session expired or checkpoint required:', err.message);
});

async function run() {
  await client.connect();
}

run().catch(console.error);
```

### 2. Sending Messages, Replies, and Unsending

```javascript
// Send a text message
const message = await client.sendMessage(threadId, 'Hello from InstaChat API!');

// Reply to a specific message
const reply = await client.reply(threadId, message.id, 'Replying to previous message!');

// Add a reaction
await client.sendReaction(threadId, message.id, '🔥');

// Mark as seen (read receipt)
await client.markSeen(threadId, message.id);

// Broadcast typing indicator
await client.sendTypingIndicator(threadId, true);

// Unsend (delete) user message
await client.unsendMessage(threadId, reply.id);
```

### 3. Sending Media (Images, Videos, Audio)

```javascript
// Send image (JPEG / PNG up to 15MB)
await client.sendImage(threadId, './photos/vacation.jpg');

// Send video (MP4 up to 50MB)
await client.sendVideo(threadId, './videos/clip.mp4');

// Send voice clip (MP3 / AAC / M4A up to 25MB)
await client.sendAudio(threadId, './audio/voice_note.mp3');

// Download a media attachment to disk
await client.downloadMedia(message.media.url, './downloads/photo.jpg');
```

### 4. Managing Chat Themes

```javascript
// List built-in verified themes (merged with live catalog once fetched)
const themes = client.getAvailableThemes();
// [ { id: 'default', themeId: '3259963564026002', name: 'Default', colors: [...] }, ... ]

// Fetch live selectable themes catalog (75+ themes) & current thread theme via GraphQL
const { themes: liveThemes, currentTheme } = await client.fetchChatThemes(threadId);
console.log('Active theme:', currentTheme?.name);

// Inspect only the current thread theme
const active = await client.getChatTheme(threadId);

// Search themes by name, slug, subtitle, or alias
const purpleThemes = await client.searchChatThemes('lavender', { threadId });

// Set conversation theme by slug, display name, alias, #index, numeric FBID, or 'random'
await client.setChatTheme(threadId, 'lavender');
await client.setChatTheme(threadId, 'Lo-Fi');
await client.setChatTheme(threadId, '#5');
await client.setChatTheme(threadId, 'random');

// Reset conversation back to Instagram's Default theme
await client.resetChatTheme(threadId);
```

### 5. Users, Profiles, Search & Friendships

```javascript
// Fetch rich profile by @username or numeric user ID
const profile = await client.getUserByUsername('instagram');
console.log(profile.fullName, profile.followerCount, profile.profilePicUrlHd);

const userById = await client.getUserById('25025320');

// Search Instagram users globally
const matches = await client.searchUsers('photography', { limit: 10 });

// Check single or batch friendship status
const status = await client.getFriendshipStatus(profile.id);
const batchStatuses = await client.getFriendshipStatuses(['25025320', '123456789']);

// Follow / Unfollow / Paginate followers & following
await client.followUser(profile.id);
await client.unfollowUser(profile.id);
const { users: followers, nextMaxId } = await client.getFollowers(profile.id, { count: 20 });
const { users: following } = await client.getFollowing(profile.id, { count: 20 });

// Moderation & Follow Requests
const { users: pendingReqs } = await client.getPendingFollowRequests();
await client.approveFollowRequest(userId);
await client.ignoreFollowRequest(userId);
await client.blockUser(userId);
await client.unblockUser(userId);
await client.restrictUser(userId);
await client.unrestrictUser(userId);
await client.muteUserMedia(userId, { posts: true, stories: true });
```

### 6. Group Management, Advanced Message Actions, Nicknames & Native Sharing

```javascript
// Create a group thread & manage members/admins
const group = await client.createGroupThread(['12345678', '@friend_handle'], 'Project Launch');
await client.setThreadTitle(group.id, 'Launch Room 🚀');
await client.addParticipants(group.id, ['98765432']);
await client.promoteAdmin(group.id, '12345678');
await client.muteThread(group.id, true);
await client.pinThread(group.id, true);

// Edit, pin, forward & mention
const msg = await client.sendMessage(group.id, 'Hey @friend_handle!', {
  mentions: [{ userId: '12345678', username: 'friend_handle' }]
});
await client.editMessage(group.id, msg.id, 'Hey @friend_handle — updated!');
await client.pinMessage(group.id, msg.id);
await client.forwardMessage(group.id, msg.id, targetThreadId, { text: msg.text });

// Custom chat nicknames
await client.setNickname(group.id, '12345678', 'Tech Lead');
const nicknames = await client.getNicknames(group.id);

// Native GIFs, stickers, links, Reel/Post/Profile shares & DM Polls
await client.sendGif(group.id, 'celebration');
await client.sendLink(group.id, 'Docs live at https://nodejs.org');
await client.shareReel(group.id, 'https://www.instagram.com/reel/C8abc123XYZ/', { text: 'Must watch' });
await client.sharePost(group.id, 'https://www.instagram.com/p/C8abc123XYZ/');
await client.shareProfile(group.id, '@instagram');
const poll = await client.createPoll(group.id, 'Deploy tonight?', ['Yes', 'Tomorrow']);
await client.votePoll(group.id, poll.pollId, ['0']);
```

### 7. Managing Instagram Direct Notes

> [!NOTE]
> `NotesService` automatically bridges your `cookie.json` session to Instagram's mobile Notes protocol using `Bearer IGT:2` token encoding and `InboxTrayRequest` GraphQL queries—no username/password login or mobile device required.

```javascript
const { NoteAudience } = require('instachat-api');

// View active 24h notes from mutual connections and close friends in DM tray
const notes = await client.getNotes();
for (const note of notes) {
  console.log(`[${note.user?.username}]: "${note.text}" (Expires in ${Math.round(note.remainingMs / 60000)}m)`);
  if (note.media) console.log(`  🎵 Track: ${note.media.title} by ${note.media.artist}`);
}

// Post a new Note (1 to 60 characters)
const myNewNote = await client.createNote('Building open-source tools with Node.js 🚀', {
  audience: NoteAudience.MUTUAL_FOLLOWERS // or NoteAudience.CLOSE_FRIENDS
});

// Inspect your own active note
const myActiveNote = await client.getMyNote();
console.log('Active Note:', myActiveNote?.text);

// Find a note by specific username
const friendNote = await client.getNoteByUser('friend_handle');

// Like or unlike a note
await client.likeNote(friendNote.id);
await client.unlikeNote(friendNote.id);

// Reply to a note directly via DM
await client.replyToNote(friendNote.id, 'Awesome choice of track!');

// Delete your active note
await client.deleteNote();
```

---

## 📡 Event Reference

`InstaChatClient` inherits from `EventEmitter` and emits the following events:

| Event | Payload | Description |
|---|---|---|
| `ready` | `{ userId, username }` | Client has verified session and initialized message baselines. |
| `connected` | `{ userId, username }` | Emitted when connection is established. |
| `disconnected` | `string` | Emitted when connection or polling is terminated. |
| `message` | `Message` | Emitted when a new incoming message item is detected. |
| `reaction` | `Object` | Emitted when a reaction is added or updated on a message. |
| `message_edit` | `Object` | Emitted when an existing message's text is edited (`previousText`, `newText`). |
| `message_unsent` | `Object` | Emitted when a message in a tracked thread is unsent/deleted. |
| `read_receipt` | `Object` | Emitted when a participant's read watermark advances (`userId`, `timestamp`). |
| `thread_update` | `Object` | Emitted when a tracked thread's title or theme changes (`changes`). |
| `message_update` | `Object` | Emitted alongside message state / edit updates. |
| `rate_limit` | `RateLimitError` | Emitted when HTTP 429 or feedback_required is encountered. |
| `auth_error` | `AuthenticationError` | Emitted when session expires or triggers a checkpoint. |
| `error` | `Error` | Emitted for general transport or processing errors. |

---

## 🛡️ Error Handling & Class Hierarchy

All errors thrown by the library inherit from `InstaChatError`:

```text
InstaChatError
├── AuthenticationError     (Invalid cookies, expired session, checkpoint_required)
├── RateLimitError          (HTTP 429, feedback_required, includes .retryAfter)
├── NetworkError            (Connection drop, timeout, includes .isTimeout)
├── ValidationError         (Invalid arguments, oversized media, bad extension)
├── UnsupportedFeatureError (Attempting to message E2EE chats)
└── NotFoundError           (Thread or message item does not exist, HTTP 404)
```

Example handling:

```javascript
try {
  await client.sendMessage(threadId, 'Test');
} catch (err) {
  if (err instanceof RateLimitError) {
    console.warn(`Please wait ${err.retryAfter} seconds before retrying.`);
  } else if (err instanceof AuthenticationError) {
    console.error('Session is no longer valid. Re-authentication required.');
  } else if (err instanceof UnsupportedFeatureError) {
    console.error(`Cannot complete action: ${err.message}`);
  } else {
    console.error(`Unexpected error: ${err.message}`);
  }
}
```

---

## 🧪 Testing

The library uses Node.js's native test runner (`node:test`) with zero external testing dependencies.

```bash
# Run unit tests
npm test

# Run conditional live integration tests
npm run test:integration
```

All 68 unit tests mock network boundaries and validate:
- Configuration and schema validation
- Session loading, cookie parsing, rotation, and persistence
- Response normalization for users, messages, reactions, replies, mentions, shares, notes, and threads
- Group management, message actions (edit/pin/forward), nicknames, moderation, sharing, and GraphQL/REST parity
- Instagram Direct Notes tray fetching, creating (mutual & close friends), deleting, liking, and DM replies
- Media file validation (size limits, extensions, MIME types)
- Resilient exponential backoff retry logic and non-idempotent guards
- Sliding-window message deduplication, edit/unsend/read-receipt detection, and baseline initialization
- Automated secret and token redaction across loggers and crash dumps

---

## 📂 Project Structure

```text
Project_Instagram/
├── src/
│   ├── index.js                  # Main library entry point
│   ├── client.js                 # InstaChatClient facade & EventEmitter
│   ├── auth/
│   │   ├── session.js            # Session validation, cookie persistence & rotation
│   │   └── credentials.js        # Helper for importing manual cookies
│   ├── transport/
│   │   ├── http.js               # Centralized Axios transport with secret redaction
│   │   └── realtime.js           # Adaptive polling engine with sliding-window dedup
│   ├── services/
│   │   ├── conversations.js      # Inbox, pending requests, thread details & in-thread search
│   │   ├── threads.js            # Group creation, title/photo, members, admins, mute, pin, leave/delete
│   │   ├── messages.js           # Send text, @mentions, replies, edit, pin/unpin, forward, unsend
│   │   ├── media.js              # Multi-stage rupload + GraphQL image/video/audio pipeline
│   │   ├── sharing.js            # Native GIFs, stickers, links, post/reel/story/profile shares & polls
│   │   ├── reactions.js          # Send and remove emoji reactions
│   │   ├── read-receipts.js      # GraphQL/REST mark seen & typing indicators
│   │   ├── themes.js             # Chat theme catalog & switcher
│   │   ├── nicknames.js          # Custom participant nicknames
│   │   ├── users.js              # Profiles, search, friendships, follow requests & moderation
│   │   └── notes.js              # 24h Direct Notes (get, post, delete, like, reply)
│   ├── models/
│   │   ├── user.js               # Normalized user model
│   │   ├── message.js            # Normalized message model
│   │   ├── conversation.js       # Normalized thread model
│   │   └── note.js               # Normalized note model
│   ├── utils/
│   │   ├── errors.js             # Typed error hierarchy
│   │   ├── logger.js             # Sanitizing logger with secret redaction
│   │   ├── retry.js              # Exponential backoff retry utility
│   │   └── validators.js         # Input, note, and media validators
│   └── constants/
│       ├── events.js             # Event constants
│       └── endpoints.js          # Instagram Web direct_v2 endpoints
├── examples/
│   ├── login.js                  # Authentication and health check example
│   ├── conversations.js          # Fetching and paginating inbox example
│   ├── send-message.js           # Sending text, replying, and unsending example
│   ├── send-media.js             # Uploading images, videos, and audio example
│   ├── notes.js                  # Viewing, posting, and deleting Instagram Notes
│   └── listen-messages.js        # Realtime event listener example
├── tests/
│   ├── unit/                     # 69 Comprehensive unit tests
│   └── integration/              # Controlled conditional live tests
├── docs/
│   ├── protocol-research.md      # Detailed protocol analysis of direct_v2
│   ├── authentication.md         # Comprehensive authentication architecture guide
│   ├── feature-compatibility.md  # Detailed feature compatibility matrix
│   └── known-limitations.md      # Known platform limitations & security guide
├── config.example.json           # Template configuration file
├── .gitignore                    # Git ignore excluding sessions, logs & node_modules
├── package.json                  # Production package definition (zero browser deps)
└── README.md                     # Project documentation
```

---

## 🔒 Security Best Practices

1. **Never commit session files:** Ensure `session.json` and any files matching `session*.json` are listed in `.gitignore`.
2. **Never log cleartext credentials:** The built-in `Logger` automatically masks `sessionid`, `csrftoken`, and authorization headers.
3. **Respect rate limits:** Keep request delays natural. Emulating humans means not polling faster than 2–3 seconds and pacing message sends by at least 2–5 seconds.

---

## 📄 License

MIT License. See [LICENSE](LICENSE) for details.
