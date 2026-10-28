'use strict';

const EventEmitter = require('events');
const fs = require('fs');

const Events = require('./constants/events');
const Session = require('./auth/session');
const HttpTransport = require('./transport/http');
const RealtimeEngine = require('./transport/realtime');
const ConversationsService = require('./services/conversations');
const ThreadsService = require('./services/threads');
const MessagesService = require('./services/messages');
const MediaService = require('./services/media');
const SharingService = require('./services/sharing');
const ReactionsService = require('./services/reactions');
const ReadReceiptsService = require('./services/read-receipts');
const ThemesService = require('./services/themes');
const NicknamesService = require('./services/nicknames');
const UsersService = require('./services/users');
const { Logger } = require('./utils/logger');
const { validateConfig } = require('./utils/validators');
const { AuthenticationError } = require('./utils/errors');

class InstaChatClient extends EventEmitter {
  constructor(options = {}) {
    super();

    // 1. Resolve configuration
    let fileConfig = {};
    const configPath = options.configPath || (fs.existsSync('./config.json') ? './config.json' : null);
    if (configPath && fs.existsSync(configPath)) {
      try {
        fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      } catch (err) {
        throw new Error(`Failed to parse configuration file at ${configPath}: ${err.message}`);
      }
    }

    // Auto-detect default session/cookie file if not explicitly set
    let defaultSessionPath = options.sessionPath || options.cookiePath || fileConfig.sessionPath || fileConfig.cookiePath;
    if (!defaultSessionPath) {
      const candidates = [
        './cookie.json',
        './cookies.json',
        './data/cookie.json',
        './data/cookies.json',
        './data/session.json',
        './session.json'
      ];
      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
          defaultSessionPath = candidate;
          break;
        }
      }
      if (!defaultSessionPath) {
        defaultSessionPath = './data/session.json';
      }
    }

    this.config = {
      sessionPath: defaultSessionPath,
      pollIntervalMs: 3000,
      requestTimeoutMs: 15000,
      maxRetries: 2,
      debug: false,
      ...fileConfig,
      ...options
    };

    if (options.cookiePath) {
      this.config.sessionPath = options.cookiePath;
    }

    validateConfig(this.config);

    // 2. Initialize logger
    this.logger = new Logger({
      debug: this.config.debug,
      prefix: '[InstaChat]'
    });

    // 3. Initialize session
    this.session = new Session({
      sessionPath: this.config.sessionPath,
      logger: this.logger
    });

    if (this.config.cookies) {
      this.session.load({
        userId: this.config.userId,
        cookies: this.config.cookies
      });
    } else if (this.config.cookieString) {
      this.session.load({
        userId: this.config.userId,
        cookieString: this.config.cookieString
      });
    }

    // 4. Initialize transport layer
    this.transport = new HttpTransport({
      session: this.session,
      logger: this.logger,
      requestTimeoutMs: this.config.requestTimeoutMs,
      maxRetries: this.config.maxRetries,
      userAgent: this.config.userAgent
    });

    // 5. Initialize services
    this.conversations = new ConversationsService({
      transport: this.transport,
      session: this.session,
      logger: this.logger
    });

    this.users = new UsersService({
      transport: this.transport,
      session: this.session,
      logger: this.logger
    });

    this.threads = new ThreadsService({
      transport: this.transport,
      session: this.session,
      logger: this.logger,
      conversationsService: this.conversations,
      usersService: this.users
    });

    this.messages = new MessagesService({
      transport: this.transport,
      session: this.session,
      logger: this.logger,
      conversationsService: this.conversations
    });

    this.media = new MediaService({
      transport: this.transport,
      session: this.session,
      logger: this.logger
    });

    this.sharing = new SharingService({
      transport: this.transport,
      session: this.session,
      logger: this.logger,
      conversationsService: this.conversations,
      usersService: this.users
    });

    this.reactions = new ReactionsService({
      transport: this.transport,
      session: this.session,
      logger: this.logger
    });

    this.readReceipts = new ReadReceiptsService({
      transport: this.transport,
      session: this.session,
      logger: this.logger,
      conversationsService: this.conversations
    });

    this.themes = new ThemesService({
      transport: this.transport,
      session: this.session,
      logger: this.logger,
      conversationsService: this.conversations
    });

    this.nicknames = new NicknamesService({
      transport: this.transport,
      session: this.session,
      logger: this.logger,
      conversationsService: this.conversations
    });

    // 6. Initialize realtime polling engine
    this.realtime = new RealtimeEngine({
      transport: this.transport,
      session: this.session,
      logger: this.logger,
      conversationsService: this.conversations,
      pollIntervalMs: this.config.pollIntervalMs
    });

    this._forwardRealtimeEvents();

    this.isConnected = false;
    this.isReady = false;
  }

  _forwardRealtimeEvents() {
    this.realtime.on(Events.MESSAGE, (msg) => this.emit(Events.MESSAGE, msg));
    this.realtime.on(Events.REACTION, (rec) => this.emit(Events.REACTION, rec));
    this.realtime.on(Events.MESSAGE_UPDATE, (update) => this.emit(Events.MESSAGE_UPDATE, update));
    this.realtime.on(Events.MESSAGE_EDIT, (edit) => this.emit(Events.MESSAGE_EDIT, edit));
    this.realtime.on(Events.MESSAGE_UNSENT, (unsent) => this.emit(Events.MESSAGE_UNSENT, unsent));
    this.realtime.on(Events.READ_RECEIPT, (receipt) => this.emit(Events.READ_RECEIPT, receipt));
    this.realtime.on(Events.THREAD_UPDATE, (update) => this.emit(Events.THREAD_UPDATE, update));
    this.realtime.on(Events.TYPING, (typing) => this.emit(Events.TYPING, typing));
    this.realtime.on(Events.RATE_LIMIT, (err) => this.emit(Events.RATE_LIMIT, err));
    this.realtime.on(Events.AUTH_ERROR, (err) => {
      this.isConnected = false;
      this.isReady = false;
      this.emit(Events.AUTH_ERROR, err);
      this.emit(Events.DISCONNECTED, 'Authentication failed');
    });
    this.realtime.on(Events.ERROR, (err) => this.emit(Events.ERROR, err));
  }

  /**
   * Connects the client by loading the session, verifying authentication health,
   * initializing message baselines, and beginning realtime listening.
   */
  async connect() {
    this.logger.info('Connecting to Instagram Direct messaging...');

    // Load session from disk if not loaded in-memory
    if (!this.session.cookies.sessionid) {
      if (!this.session.sessionPath) {
        throw new AuthenticationError('No session cookies or sessionPath provided.');
      }
      this.session.load(this.session.sessionPath);
    }

    // Health check verification
    try {
      this.logger.debug('Verifying session health via Instagram profile state...');
      const response = await this.transport.get('https://www.instagram.com/data/shared_data/');
      const viewer = response.data && response.data.config && response.data.config.viewer;

      if (!viewer) {
        throw new AuthenticationError(
          'Instagram session has expired or been terminated by Meta (sessionid is deleted or invalid). Please log in to Instagram in your browser and copy your fresh sessionid cookie.',
          { code: 'SESSION_EXPIRED' }
        );
      }

      this.session.userId = String(viewer.id || this.session.userId);
      this.session.username = viewer.username || this.session.username;
      this.logger.info(`Session verified! Logged in as @${viewer.username} (${viewer.id})`);
    } catch (err) {
      this.emit(Events.AUTH_ERROR, err);
      throw err;
    }

    this.isConnected = true;
    this.emit(Events.CONNECTED, { userId: this.session.userId, username: this.session.username });

    // Initialize baseline and start realtime polling
    await this.realtime.initializeBaseline();
    this.realtime.start();

    this.isReady = true;
    this.emit(Events.READY, { userId: this.session.userId, username: this.session.username });
    this.logger.info(`Instagram messaging client ready! User ID: ${this.session.userId}`);

    return this;
  }

  /**
   * Disconnects the client and stops listening.
   */
  async disconnect() {
    this.realtime.stop();
    this.isConnected = false;
    this.isReady = false;
    this.emit(Events.DISCONNECTED, 'Client disconnected');
    this.logger.info('Client disconnected successfully.');
  }

  get userId() {
    return this.session ? this.session.userId : null;
  }

  get username() {
    return this.session ? this.session.username : null;
  }

  // --- Conversations & Message Requests API ---

  async getConversations(options = {}) {
    const res = await this.conversations.getInbox(options);
    return res.conversations;
  }

  async getInbox(options = {}) {
    return this.conversations.getInbox(options);
  }

  async getPendingConversations(options = {}) {
    return this.conversations.getPendingInbox(options);
  }

  async acceptMessageRequest(conversationId, options = {}) {
    return this.conversations.acceptMessageRequest(conversationId, options);
  }

  async declineMessageRequest(conversationId) {
    return this.conversations.declineMessageRequest(conversationId);
  }

  async getMessages(conversationId, options = {}) {
    const res = await this.conversations.getThread(conversationId, options);
    return res.messages;
  }

  async getConversation(conversationId, options = {}) {
    const res = await this.conversations.getThread(conversationId, options);
    return res.conversation;
  }

  async findConversationByUsername(username) {
    return this.conversations.findByUsername(username);
  }

  async searchInThread(conversationId, query, options = {}) {
    return this.conversations.searchInThread(conversationId, query, options);
  }

  // --- Group & Thread Management API ---

  async createConversation(recipients, options = {}) {
    return this.threads.createThread(recipients, options);
  }

  async createGroupThread(recipients, title = null, options = {}) {
    return this.threads.createGroupThread(recipients, title, options);
  }

  async setThreadTitle(conversationId, title) {
    return this.threads.setTitle(conversationId, title);
  }

  async setThreadImage(conversationId, fileInput, options = {}) {
    return this.threads.setImage(conversationId, fileInput, options);
  }

  async addParticipants(conversationId, userIds) {
    return this.threads.addParticipants(conversationId, userIds);
  }

  async removeParticipant(conversationId, userIds) {
    return this.threads.removeParticipant(conversationId, userIds);
  }

  async promoteAdmin(conversationId, userIds) {
    return this.threads.promoteAdmin(conversationId, userIds);
  }

  async demoteAdmin(conversationId, userIds) {
    return this.threads.demoteAdmin(conversationId, userIds);
  }

  async leaveThread(conversationId) {
    return this.threads.leaveThread(conversationId);
  }

  async deleteThread(conversationId) {
    return this.threads.deleteThread(conversationId);
  }

  async muteThread(conversationId, muted = true) {
    return this.threads.muteThread(conversationId, muted);
  }

  async pinThread(conversationId, pinned = true) {
    return this.threads.pinThread(conversationId, pinned);
  }

  // --- Messaging & Advanced Message Actions API ---

  /**
   * Resolves whether an attachment item is image, audio, or video.
   *
   * @private
   * @param {any} item
   * @param {Object} [options]
   * @returns {'image'|'audio'|'video'}
   */
  _resolveAttachmentType(item, options = {}) {
    if (options.isAudio || options.audio || options.voice || (item && (item.isAudio || item.audio || item.voice))) {
      return 'audio';
    }
    if (options.isVideo || options.video || (item && (item.isVideo || item.video))) {
      return 'video';
    }
    if (options.isImage || options.image || (item && (item.isImage || item.image))) {
      return 'image';
    }

    const filePathOrUrl = (typeof item === 'string')
      ? item
      : (item && item.path && typeof item.path === 'string')
        ? item.path
        : (item && item.url && typeof item.url === 'string')
          ? item.url
          : '';

    if (filePathOrUrl) {
      const clean = filePathOrUrl.toLowerCase();
      if (/\.(mp3|m4a|wav|ogg|aac|flac|opus)(\?|$)/i.test(clean) || clean.includes('type=mp3') || clean.includes('type=audio')) {
        return 'audio';
      }
      if (/\.(mp4|mov|avi|mkv|webm)(\?|$)/i.test(clean) || clean.includes('type=mp4') || clean.includes('type=video')) {
        return 'video';
      }
    }

    if (Buffer.isBuffer(item) && item.length >= 4) {
      if (item[0] === 0x49 && item[1] === 0x44 && item[2] === 0x33) return 'audio';
      if (item[0] === 0xFF && (item[1] & 0xE0) === 0xE0) return 'audio';
      if (item.slice(0, 4).toString() === 'OggS') return 'audio';
    }

    return 'image';
  }

  /**
   * Sends a single media attachment to a conversation.
   *
   * @private
   * @param {string} conversationId
   * @param {any} item
   * @param {Object} [options]
   * @returns {Promise<Message>}
   */
  async _sendSingleAttachment(conversationId, item, options = {}) {
    let rawAttachment = item;
    let itemOpts = { ...options };

    if (item && typeof item === 'object' && !Buffer.isBuffer(item) && typeof item.pipe !== 'function' && !item[Symbol.asyncIterator]) {
      if (item.attachment) {
        rawAttachment = item.attachment;
        itemOpts = { ...itemOpts, ...item };
      } else if (item.url) {
        rawAttachment = item.url;
        itemOpts = { ...itemOpts, ...item };
      } else if (item.stream) {
        rawAttachment = item.stream;
        itemOpts = { ...itemOpts, ...item };
      }
    }

    const type = this._resolveAttachmentType(rawAttachment, itemOpts);
    if (type === 'audio') {
      return this.sendAudio(conversationId, rawAttachment, itemOpts);
    } else if (type === 'video') {
      return this.sendVideo(conversationId, rawAttachment, itemOpts);
    } else {
      return this.sendImage(conversationId, rawAttachment, itemOpts);
    }
  }

  /**
   * Sends a message (text, media attachment, or combined { body, attachment }) to a conversation.
   *
   * @param {string} conversationId
   * @param {string|Object|Buffer|import('stream').Readable} textOrPayload
   * @param {Object} [options]
   * @returns {Promise<Message>}
   */
  async sendMessage(conversationId, textOrPayload, options = {}) {
    let payload = textOrPayload;
    if (Buffer.isBuffer(textOrPayload) || (textOrPayload && (typeof textOrPayload.pipe === 'function' || textOrPayload[Symbol.asyncIterator]))) {
      payload = { attachment: textOrPayload };
    }

    if (typeof payload === 'object' && payload !== null) {
      const { body, attachment, attachments, ...restOpts } = payload;
      const mergedOpts = { ...restOpts, ...options };
      const rawAttachments = attachments || attachment;
      const results = { attachments: [] };

      if (rawAttachments) {
        const list = Array.isArray(rawAttachments) ? rawAttachments : [rawAttachments];
        for (const item of list) {
          if (item) {
            const sent = await this._sendSingleAttachment(conversationId, item, mergedOpts);
            results.attachments.push(sent);
          }
        }
      }

      if (body !== undefined && body !== null && String(body).length > 0) {
        // If attachments were sent as a reply, send text directly in thread without repeating quote
        const textOpts = results.attachments.length > 0 && mergedOpts.replyToItemId && !mergedOpts.replyTextAlso
          ? { ...mergedOpts, replyToItemId: null }
          : mergedOpts;
        results.text = await this.messages.sendTextMessage(conversationId, String(body), textOpts);
      }

      const primary = results.text || (results.attachments && results.attachments[0]) || null;
      if (primary && results.attachments.length > 0 && results.text) {
        primary.textMessage = results.text;
        primary.attachmentMessages = results.attachments;
        primary.attachments = results.attachments;
        primary.attachment = results.attachments[0];
        primary.body = String(body);
        primary.unsend = async () => {
          const promises = [];
          for (const att of results.attachments) {
            if (att && (att.id || att.messageID)) {
              promises.push(this.unsendMessage(conversationId, att.id || att.messageID));
            }
          }
          if (results.text && (results.text.id || results.text.messageID)) {
            promises.push(this.unsendMessage(conversationId, results.text.id || results.text.messageID));
          }
          return Promise.allSettled(promises);
        };
      }

      return primary;
    }

    return this.messages.sendTextMessage(conversationId, textOrPayload, options);
  }

  async sendAttachment(conversationId, attachment, options = {}) {
    return this.sendMessage(conversationId, { attachment, ...options });
  }

  async reply(conversationId, messageId, textOrPayload, options = {}) {
    return this.sendMessage(conversationId, textOrPayload, {
      ...options,
      replyToItemId: messageId
    });
  }

  async editMessage(conversationId, messageId, newText, options = {}) {
    return this.messages.editMessage(conversationId, messageId, newText, options);
  }

  async unsendMessage(conversationId, messageId) {
    return this.messages.unsend(conversationId, messageId);
  }

  async pinMessage(conversationId, messageId) {
    return this.messages.pinMessage(conversationId, messageId);
  }

  async unpinMessage(conversationId, messageId) {
    return this.messages.unpinMessage(conversationId, messageId);
  }

  async getPinnedMessages(conversationId) {
    return this.messages.getPinnedMessages(conversationId);
  }

  async forwardMessage(fromConversationId, messageId, toConversationId, options = {}) {
    return this.messages.forwardMessage(fromConversationId, messageId, toConversationId, options);
  }

  // --- Reactions API ---

  async sendReaction(conversationId, messageId, emoji = '❤️') {
    return this.reactions.sendReaction(conversationId, messageId, emoji);
  }

  async deleteReaction(conversationId, messageId) {
    return this.reactions.deleteReaction(conversationId, messageId);
  }

  // --- Read Receipts & Activity API ---

  async markSeen(conversationId, messageId, options = {}) {
    return this.readReceipts.markSeen(conversationId, messageId, options);
  }

  async sendTypingIndicator(conversationId, isTyping = true) {
    return this.readReceipts.sendTypingIndicator(conversationId, isTyping);
  }

  // --- Media API ---

  async sendImage(conversationId, filePathOrUrlOrBuffer, options = {}) {
    return this.media.sendImage(conversationId, filePathOrUrlOrBuffer, options);
  }

  async sendImageFromUrl(conversationId, imageUrl, options = {}) {
    return this.media.sendImageFromUrl(conversationId, imageUrl, options);
  }

  async sendVideo(conversationId, filePath, options = {}) {
    return this.media.sendVideo(conversationId, filePath, options);
  }

  async sendAudio(conversationId, filePathOrUrlOrBuffer, options = {}) {
    return this.media.sendAudio(conversationId, filePathOrUrlOrBuffer, options);
  }

  async sendAudioFromUrl(conversationId, audioUrl, options = {}) {
    return this.media.sendAudioFromUrl(conversationId, audioUrl, options);
  }

  async downloadMedia(mediaUrl, destinationPath) {
    return this.media.downloadMedia(mediaUrl, destinationPath);
  }

  // --- Native Sharing, GIFs, Stickers & Polls API ---

  async searchGifs(query, options = {}) {
    return this.sharing.searchGifs(query, options);
  }

  async sendGif(conversationId, gifIdOrQuery, options = {}) {
    return this.sharing.sendGif(conversationId, gifIdOrQuery, options);
  }

  async sendSticker(conversationId, stickerId, options = {}) {
    return this.sharing.sendSticker(conversationId, stickerId, options);
  }

  async sendLink(conversationId, textOrUrl, options = {}) {
    return this.sharing.sendLink(conversationId, textOrUrl, options);
  }

  async sharePost(conversationId, mediaIdOrUrl, options = {}) {
    return this.sharing.sharePost(conversationId, mediaIdOrUrl, options);
  }

  async shareMedia(conversationId, mediaIdOrUrl, options = {}) {
    return this.sharing.sharePost(conversationId, mediaIdOrUrl, options);
  }

  async shareReel(conversationId, mediaIdOrUrl, options = {}) {
    return this.sharing.shareReel(conversationId, mediaIdOrUrl, options);
  }

  async shareStory(conversationId, storyMediaId, options = {}) {
    return this.sharing.shareStory(conversationId, storyMediaId, options);
  }

  async shareProfile(conversationId, userIdOrUsername, options = {}) {
    return this.sharing.shareProfile(conversationId, userIdOrUsername, options);
  }

  async createPoll(conversationId, question, pollOptions) {
    return this.sharing.createPoll(conversationId, question, pollOptions);
  }

  async votePoll(conversationId, pollId, optionIds) {
    return this.sharing.votePoll(conversationId, pollId, optionIds);
  }

  // --- Custom Chat Nicknames API ---

  async getNicknames(conversationId, options = {}) {
    return this.nicknames.getNicknames(conversationId, options);
  }

  async setNickname(conversationId, userId, nickname) {
    return this.nicknames.setNickname(conversationId, userId, nickname);
  }

  async clearNickname(conversationId, userId) {
    return this.nicknames.clearNickname(conversationId, userId);
  }

  // --- Themes API ---

  async setChatTheme(conversationId, themeId, options = {}) {
    return this.themes.setTheme(conversationId, themeId, options);
  }

  async resetChatTheme(conversationId, options = {}) {
    return this.themes.resetTheme(conversationId, options);
  }

  getAvailableThemes() {
    return this.themes.getAvailableThemes();
  }

  async fetchChatThemes(conversationId = null, options = {}) {
    return this.themes.fetchSelectableThemes(conversationId, options);
  }

  async getChatTheme(conversationId) {
    return this.themes.getThreadTheme(conversationId);
  }

  async searchChatThemes(query, options = {}) {
    return this.themes.searchThemes(query, options);
  }

  // --- Users, Profiles, Moderation & Friendships API ---

  async getUserByUsername(username) {
    return this.users.getUserByUsername(username);
  }

  async getProfile(username) {
    return this.users.getUserByUsername(username);
  }

  async getUserById(userId) {
    return this.users.getUserById(userId);
  }

  async searchUsers(query, options = {}) {
    return this.users.searchUsers(query, options);
  }

  async getFriendshipStatus(userId) {
    return this.users.getFriendshipStatus(userId);
  }

  async getFriendshipStatuses(userIds) {
    return this.users.getFriendshipStatuses(userIds);
  }

  async followUser(userId) {
    return this.users.followUser(userId);
  }

  async unfollowUser(userId) {
    return this.users.unfollowUser(userId);
  }

  async removeFollower(userId) {
    return this.users.removeFollower(userId);
  }

  async getFollowers(userId, options = {}) {
    return this.users.getFollowers(userId, options);
  }

  async getFollowing(userId, options = {}) {
    return this.users.getFollowing(userId, options);
  }

  async getPendingFollowRequests(options = {}) {
    return this.users.getPendingFollowRequests(options);
  }

  async approveFollowRequest(userId, options = {}) {
    return this.users.approveFollowRequest(userId, options);
  }

  async ignoreFollowRequest(userId, options = {}) {
    return this.users.ignoreFollowRequest(userId, options);
  }

  async blockUser(userId) {
    return this.users.blockUser(userId);
  }

  async unblockUser(userId) {
    return this.users.unblockUser(userId);
  }

  async restrictUser(userId) {
    return this.users.restrictUser(userId);
  }

  async unrestrictUser(userId, options = {}) {
    return this.users.unrestrictUser(userId, options);
  }

  async muteUserMedia(userId, options = {}) {
    return this.users.muteUserMedia(userId, options);
  }

  async unmuteUserMedia(userId, options = {}) {
    return this.users.unmuteUserMedia(userId, options);
  }
}

module.exports = InstaChatClient;
