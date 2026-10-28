'use strict';

const EventEmitter = require('events');
const Events = require('../constants/events');

class RealtimeEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    this.transport = options.transport;
    this.session = options.session;
    this.logger = options.logger;
    this.conversationsService = options.conversationsService;

    this.pollIntervalMs = options.pollIntervalMs || 3000;
    this.isRunning = false;
    this.timer = null;
    this.isPolling = false;

    // Deduplication cache: Set of seen message IDs (sliding window up to 10,000 items)
    this.seenMessageIds = new Set();
    this.maxSeenCache = 10000;

    // Reaction deduplication & active interactive watch tracking
    this.seenReactions = new Set();
    this.watchedReactionThreads = new Map(); // threadId -> { expiresAt, lastCheckedAt }
    this.watchedReactionMessages = new Set(); // messageIDs sent by bot awaiting reactions
    this.initializedReactionThreads = new Set();

    // Rich state tracking for edits, unsends, read receipts, and thread metadata changes
    this.messageSnapshots = new Map(); // messageId -> { text, editCount, senderId }
    this.threadMessageWindows = new Map(); // threadId -> string[] (ordered message IDs)
    this.emittedUnsentIds = new Set();
    this.readReceiptWatermarks = new Map(); // `${threadId}:${userId}` -> timestamp
    this.threadMetaSnapshots = new Map(); // threadId -> { title, themeId, muted }

    // Track thread activity timestamps
    this.threadActivity = new Map();

    // High water mark for message timestamps
    this.latestTimestamp = 0;
    this.isInitialized = false;
  }

  /**
   * Registers a bot-sent message & thread for active reaction polling so `onReact` / `onReaction`
   * triggers promptly even when Instagram's inbox summary omits reaction changes.
   *
   * @param {string} threadId
   * @param {string} [messageId]
   * @param {number} [durationMs=900000] - Watch window (default 15 minutes)
   */
  watchReactionMessage(threadId, messageId = null, durationMs = 15 * 60 * 1000) {
    if (threadId) {
      const cleanThread = String(threadId).trim();
      const existing = this.watchedReactionThreads.get(cleanThread);
      this.watchedReactionThreads.set(cleanThread, {
        expiresAt: Date.now() + durationMs,
        lastCheckedAt: existing ? existing.lastCheckedAt : 0
      });
    }
    if (messageId) {
      this.watchedReactionMessages.add(String(messageId).trim());
      if (this.watchedReactionMessages.size > 2000) {
        const first = this.watchedReactionMessages.values().next().value;
        this.watchedReactionMessages.delete(first);
      }
    }
  }

  /**
   * Initializes the deduplication baseline with current inbox state so existing messages
   * are not falsely emitted as new incoming events.
   */
  async initializeBaseline() {
    try {
      if (this.logger && typeof this.logger.debug === 'function') {
        this.logger.debug('Initializing realtime baseline from current inbox...');
      }

      const inbox = await this.conversationsService.getInbox({ limit: 20 });
      if (inbox && Array.isArray(inbox.conversations)) {
        for (const conv of inbox.conversations) {
          this.threadActivity.set(conv.id, conv.lastActivityAt);
          this._seedThreadMeta(conv);
          this._processReadReceipts(conv, false);

          if (Array.isArray(conv.messages)) {
            this.threadMessageWindows.set(
              conv.id,
              conv.messages.map((m) => m && m.id).filter(Boolean)
            );
            for (const msg of conv.messages) {
              this._recordSeen(msg.id);
              this._recordMessageSnapshot(msg);
              if (msg.timestamp > this.latestTimestamp) {
                this.latestTimestamp = msg.timestamp;
              }
              if (Array.isArray(msg.reactions)) {
                for (const r of msg.reactions) {
                  this._recordReactionSeen(conv.id, msg.id, r.senderId, r.emoji);
                }
              }
            }
          }
        }
      }
      this.isInitialized = true;
    } catch (err) {
      if (this.logger) {
        this.logger.warn(`Failed to initialize realtime baseline: ${err.message}`);
      }
      this.isInitialized = true;
    }
  }

  _recordSeen(id) {
    if (!id) return;
    this.seenMessageIds.add(id);
    if (this.seenMessageIds.size > this.maxSeenCache) {
      const iterator = this.seenMessageIds.values();
      for (let i = 0; i < 1000; i++) {
        this.seenMessageIds.delete(iterator.next().value);
      }
    }
  }

  _recordMessageSnapshot(msg) {
    if (!msg || !msg.id) return;
    const editCount = Array.isArray(msg.editHistory) ? msg.editHistory.length : (msg.isEdited ? 1 : 0);
    this.messageSnapshots.set(msg.id, {
      text: typeof msg.text === 'string' ? msg.text : '',
      editCount,
      senderId: msg.senderId || ''
    });
    if (this.messageSnapshots.size > this.maxSeenCache) {
      const iterator = this.messageSnapshots.keys();
      for (let i = 0; i < 1000; i++) {
        this.messageSnapshots.delete(iterator.next().value);
      }
    }
  }

  _seedThreadMeta(conv) {
    if (!conv || !conv.id) return;
    this.threadMetaSnapshots.set(conv.id, {
      title: conv.title || null,
      themeId: conv.themeId || null,
      muted: Boolean(conv.muted)
    });
  }

  /**
   * Detects and emits THREAD_UPDATE when a tracked thread's title or theme changes.
   *
   * @param {Object} conv
   */
  _processThreadMetaChanges(conv) {
    if (!conv || !conv.id) return;
    const prev = this.threadMetaSnapshots.get(conv.id);
    const next = {
      title: conv.title || null,
      themeId: conv.themeId || null,
      muted: Boolean(conv.muted)
    };
    this.threadMetaSnapshots.set(conv.id, next);

    if (!this.isInitialized || !prev) return;

    const changes = {};
    let changed = false;
    if (prev.title !== null && next.title !== null && prev.title !== next.title) {
      changes.title = { from: prev.title, to: next.title };
      changed = true;
    }
    if (prev.themeId !== next.themeId) {
      changes.themeId = { from: prev.themeId, to: next.themeId };
      changed = true;
    }

    if (changed) {
      this.emit(Events.THREAD_UPDATE, {
        threadId: conv.id,
        changes,
        conversation: conv,
        timestamp: Date.now()
      });
    }
  }

  /**
   * Detects and emits READ_RECEIPT when a participant's read watermark advances.
   *
   * @param {Object} conv
   * @param {boolean} [shouldEmit=true]
   */
  _processReadReceipts(conv, shouldEmit = true) {
    if (!conv || !conv.id || !Array.isArray(conv.readReceipts)) return;
    const currentUserId = this.session && this.session.userId ? String(this.session.userId) : null;

    for (const receipt of conv.readReceipts) {
      if (!receipt || !receipt.userId) continue;
      const ts = Number(receipt.timestamp || 0);
      if (!ts) continue;

      const key = `${conv.id}:${receipt.userId}`;
      const prevTs = this.readReceiptWatermarks.get(key) || 0;
      if (ts > prevTs) {
        this.readReceiptWatermarks.set(key, ts);
        if (shouldEmit && this.isInitialized && (!currentUserId || String(receipt.userId) !== currentUserId)) {
          this.emit(Events.READ_RECEIPT, {
            threadId: conv.id,
            userId: String(receipt.userId),
            interopFbid: receipt.interopFbid || null,
            messageId: receipt.messageId || null,
            timestamp: ts
          });
        }
      }
    }
  }

  /**
   * Detects message text edits (MESSAGE_EDIT / MESSAGE_UPDATE) and unsends (MESSAGE_UNSENT).
   *
   * @param {string} threadId
   * @param {Array<Object>} messages
   */
  _processMessageMutations(threadId, messages = []) {
    if (!Array.isArray(messages)) return;

    const currentIds = [];
    for (const msg of messages) {
      if (!msg || !msg.id) continue;
      currentIds.push(msg.id);

      // Tombstone detection for unsent messages
      if (msg.raw && msg.raw.tombstone_reason && !this.emittedUnsentIds.has(msg.id)) {
        this.emittedUnsentIds.add(msg.id);
        if (this.isInitialized) {
          this.emit(Events.MESSAGE_UNSENT, {
            threadId,
            messageId: msg.id,
            messageID: msg.id,
            senderId: msg.senderId || '',
            timestamp: Date.now()
          });
        }
        continue;
      }

      // Edit detection on already-seen messages
      if (this.seenMessageIds.has(msg.id)) {
        const prev = this.messageSnapshots.get(msg.id);
        const currText = typeof msg.text === 'string' ? msg.text : '';
        const currEditCount = Array.isArray(msg.editHistory) ? msg.editHistory.length : (msg.isEdited ? 1 : 0);

        if (prev) {
          const textChanged = Boolean(currText && prev.text && prev.text !== currText);
          const editCountIncreased = currEditCount > prev.editCount;

          if (textChanged || editCountIncreased) {
            const payload = {
              threadId,
              messageId: msg.id,
              messageID: msg.id,
              senderId: msg.senderId || prev.senderId || '',
              previousText: prev.text,
              text: currText,
              newText: currText,
              message: msg,
              timestamp: Date.now()
            };
            this._recordMessageSnapshot(msg);
            if (this.isInitialized) {
              this.emit(Events.MESSAGE_EDIT, payload);
              this.emit(Events.MESSAGE_UPDATE, payload);
            }
          }
        } else {
          this._recordMessageSnapshot(msg);
        }
      }
    }

    // Window-diff unsend detection: if a previously seen message disappears while an older message
    // behind it is still in the window (or all messages disappeared), that message was unsent.
    const prevWindow = this.threadMessageWindows.get(threadId);
    if (this.isInitialized && Array.isArray(prevWindow) && prevWindow.length > 0) {
      const currentSet = new Set(currentIds);
      let oldestSurvivingPrevIdx = -1;
      for (let i = prevWindow.length - 1; i >= 0; i--) {
        if (currentSet.has(prevWindow[i])) {
          oldestSurvivingPrevIdx = i;
          break;
        }
      }

      const limitIdx = currentIds.length === 0 ? prevWindow.length : oldestSurvivingPrevIdx;
      for (let i = 0; i < limitIdx; i++) {
        const missingId = prevWindow[i];
        if (!currentSet.has(missingId) && !this.emittedUnsentIds.has(missingId)) {
          this.emittedUnsentIds.add(missingId);
          const snap = this.messageSnapshots.get(missingId);
          this.emit(Events.MESSAGE_UNSENT, {
            threadId,
            messageId: missingId,
            messageID: missingId,
            senderId: snap ? snap.senderId : '',
            previousText: snap ? snap.text : '',
            timestamp: Date.now()
          });
        }
      }
    }

    this.threadMessageWindows.set(threadId, currentIds);
  }

  /**
   * Processes a thread's messages, records seen IDs and snapshots, and emits MESSAGE for unseen items.
   *
   * @param {string} threadId
   * @param {Array<Object>} [messages=[]]
   * @returns {boolean} Whether any new message was detected and processed
   */
  _processThreadMessages(threadId, messages = []) {
    let emittedAny = false;
    if (!Array.isArray(messages)) return emittedAny;

    for (const msg of messages) {
      if (!msg || !msg.id) continue;
      if (!this.seenMessageIds.has(msg.id)) {
        this._recordSeen(msg.id);
        this._recordMessageSnapshot(msg);
        emittedAny = true;

        if (this.isInitialized) {
          msg.threadMessages = messages;
          this.emit(Events.MESSAGE, msg);
        }
      }
    }
    return emittedAny;
  }

  _reactionKey(threadId, messageId, senderId, emoji) {
    return `${threadId}:${messageId}:${senderId || ''}:${emoji || ''}`;
  }

  _recordReactionSeen(threadId, messageId, senderId, emoji) {
    const key = this._reactionKey(threadId, messageId, senderId, emoji);
    this.seenReactions.add(key);
    if (this.seenReactions.size > this.maxSeenCache) {
      const iterator = this.seenReactions.values();
      for (let i = 0; i < 1000; i++) {
        this.seenReactions.delete(iterator.next().value);
      }
    }
  }

  /**
   * Emits any newly added reactions on a set of messages and optionally syncs removed reactions.
   *
   * @param {string} threadId
   * @param {Array<Object>} messages
   * @param {Object} [options]
   * @param {boolean} [options.syncRemovals=false]
   * @param {boolean} [options.seedUnwatchedOnly=false]
   */
  _processMessagesReactions(threadId, messages = [], options = {}) {
    if (!Array.isArray(messages)) return;
    const currentUserId = this.session && this.session.userId ? String(this.session.userId) : null;

    for (const msg of messages) {
      if (!msg || !msg.id) continue;
      const reactions = Array.isArray(msg.reactions) ? msg.reactions : [];
      const currentKeysForMsg = new Set();
      const isWatchedMsg = this.watchedReactionMessages.has(String(msg.id));

      for (const reaction of reactions) {
        if (!reaction) continue;
        const key = this._reactionKey(threadId, msg.id, reaction.senderId, reaction.emoji);
        currentKeysForMsg.add(key);

        if (!this.seenReactions.has(key)) {
          this._recordReactionSeen(threadId, msg.id, reaction.senderId, reaction.emoji);

          if (this.isInitialized && (!options.seedUnwatchedOnly || isWatchedMsg)) {
            this.emit(Events.REACTION, {
              threadId,
              messageId: msg.id,
              messageID: msg.id,
              senderId: reaction.senderId,
              userID: reaction.senderId,
              emoji: reaction.emoji,
              reaction: reaction.emoji,
              timestamp: reaction.timestamp || Date.now(),
              isSelf: Boolean(currentUserId && String(reaction.senderId) === currentUserId)
            });
          }
        }
      }

      // If full reaction state was fetched from thread detail, prune removed reactions so re-reacting fires again
      if (options.syncRemovals) {
        const prefix = `${threadId}:${msg.id}:`;
        for (const existingKey of Array.from(this.seenReactions)) {
          if (existingKey.startsWith(prefix) && !currentKeysForMsg.has(existingKey)) {
            this.seenReactions.delete(existingKey);
          }
        }
      }
    }
  }

  /**
   * Starts polling loop.
   */
  start() {
    if (this.isRunning) return;
    this.isRunning = true;

    if (this.logger && typeof this.logger.debug === 'function') {
      this.logger.debug(`Starting realtime polling engine (interval: ${this.pollIntervalMs}ms)`);
    }

    const scheduleNext = (delay = this.pollIntervalMs) => {
      if (!this.isRunning) return;
      this.timer = setTimeout(async () => {
        try {
          await this.pollOnce();
          scheduleNext(this.pollIntervalMs);
        } catch (err) {
          let nextDelay = this.pollIntervalMs * 2;
          if (err.code === 'AUTH_ERROR') {
            this.emit(Events.AUTH_ERROR, err);
            this.stop();
            return;
          }
          if (err.code === 'RATE_LIMIT_ERROR') {
            this.emit(Events.RATE_LIMIT, err);
            nextDelay = (err.retryAfter || 10) * 1000;
          } else {
            this.emit(Events.ERROR, err);
          }
          scheduleNext(nextDelay);
        }
      }, delay);
    };

    scheduleNext(100);
  }

  /**
   * Executes a single polling cycle.
   */
  async pollOnce() {
    if (this.isPolling) return;
    this.isPolling = true;

    try {
      const inbox = await this.conversationsService.getInbox({ limit: 5 });
      if (!inbox || !Array.isArray(inbox.conversations)) {
        return;
      }

      const checkedDetailThreads = new Set();

      for (const conv of inbox.conversations) {
        const lastKnownActivity = this.threadActivity.get(conv.id) || 0;

        // Always inspect read receipts & thread metadata changes even when activity timestamp stays unchanged
        this._processReadReceipts(conv, true);
        this._processThreadMetaChanges(conv);

        if (conv.lastActivityAt > lastKnownActivity) {
          this.threadActivity.set(conv.id, conv.lastActivityAt);
          const emittedAnyNewMsg = this._processThreadMessages(conv.id, conv.messages);

          // Detect edits and unsends on previously seen messages
          this._processMessageMutations(conv.id, conv.messages);

          // Emit any reactions directly present on inbox messages
          this._processMessagesReactions(conv.id, conv.messages, { syncRemovals: false });

          // If thread activity updated without a new message (e.g. reaction/edit/unsend in GraphQL mode), inspect thread detail
          if (
            this.isInitialized &&
            !emittedAnyNewMsg &&
            this.conversationsService &&
            typeof this.conversationsService.getGraphQLThread === 'function'
          ) {
            try {
              const firstInit = !this.initializedReactionThreads.has(conv.id);
              const detail = await this.conversationsService.getGraphQLThread(conv.id, { limit: 10 });
              this.initializedReactionThreads.add(conv.id);
              checkedDetailThreads.add(conv.id);
              if (detail && detail.conversation) {
                this._processReadReceipts(detail.conversation, true);
                this._processThreadMetaChanges(detail.conversation);
              }
              if (detail && Array.isArray(detail.messages)) {
                this._processMessageMutations(conv.id, detail.messages);
                this._processMessagesReactions(conv.id, detail.messages, {
                  syncRemovals: true,
                  seedUnwatchedOnly: firstInit
                });
              }
            } catch (e) {}
          }
        }
      }

      // Poll watched interactive reaction threads (throttled to >= 2500ms per thread)
      if (
        this.isInitialized &&
        this.watchedReactionThreads.size > 0 &&
        this.conversationsService &&
        typeof this.conversationsService.getGraphQLThread === 'function'
      ) {
        const now = Date.now();
        for (const [watchedThreadId, meta] of Array.from(this.watchedReactionThreads.entries())) {
          if (!meta || now > meta.expiresAt) {
            this.watchedReactionThreads.delete(watchedThreadId);
            continue;
          }
          if (checkedDetailThreads.has(watchedThreadId) || now - meta.lastCheckedAt < 2500) {
            continue;
          }
          meta.lastCheckedAt = now;
          try {
            const firstInit = !this.initializedReactionThreads.has(watchedThreadId);
            const detail = await this.conversationsService.getGraphQLThread(watchedThreadId, { limit: 10 });
            this.initializedReactionThreads.add(watchedThreadId);
            if (detail && detail.conversation) {
              this._processReadReceipts(detail.conversation, true);
              this._processThreadMetaChanges(detail.conversation);
            }
            if (detail && Array.isArray(detail.messages)) {
              this._processMessageMutations(watchedThreadId, detail.messages);
              this._processMessagesReactions(watchedThreadId, detail.messages, {
                syncRemovals: true,
                seedUnwatchedOnly: firstInit
              });
            }
          } catch (e) {}
        }
      }
    } finally {
      this.isPolling = false;
    }
  }

  /**
   * Stops polling loop and clears timers.
   */
  stop() {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.isPolling = false;
    if (this.logger && typeof this.logger.debug === 'function') {
      this.logger.debug('Realtime polling engine stopped');
    }
  }
}

module.exports = RealtimeEngine;
