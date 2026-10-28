'use strict';

const crypto = require('crypto');
const Endpoints = require('../constants/endpoints');
const Conversation = require('../models/conversation');
const Message = require('../models/message');
const { validateThreadId, validateSearchQuery } = require('../utils/validators');
const { NotFoundError, ValidationError, InstaChatError } = require('../utils/errors');

class ConversationsService {
  constructor(options = {}) {
    this.transport = options.transport;
    this.session = options.session;
    this.logger = options.logger;
  }

  /**
   * Caches threadFbid <-> threadIgid (v2Id) and userId -> interopFbid mappings on the active session.
   *
   * @param {Conversation[]} conversations
   * @private
   */
  _cacheThreadIds(conversations = []) {
    if (!this.session || !Array.isArray(conversations)) return;
    if (!this.session._threadIgidMap) {
      this.session._threadIgidMap = new Map();
    }
    if (!this.session._userInteropFbidMap) {
      this.session._userInteropFbidMap = new Map();
    }

    for (const conv of conversations) {
      if (!conv) continue;
      if (conv.id && conv.v2Id) {
        this.session._threadIgidMap.set(String(conv.id), String(conv.v2Id));
        this.session._threadIgidMap.set(String(conv.v2Id), String(conv.v2Id));
      }
      if (Array.isArray(conv.participants)) {
        for (const p of conv.participants) {
          if (p && p.id && p.interopFbid) {
            this.session._userInteropFbidMap.set(String(p.id), String(p.interopFbid));
          }
          if (p && p.username && p.interopFbid) {
            this.session._userInteropFbidMap.set(p.username.toLowerCase(), String(p.interopFbid));
          }
        }
      }
    }
  }

  /**
   * Resolves a thread ID to its direct_v2 REST thread_id when cached on session.
   *
   * @param {string} threadId
   * @returns {string}
   */
  resolveRestThreadId(threadId) {
    const validId = validateThreadId(threadId);
    if (this.session && this.session._threadIgidMap && this.session._threadIgidMap.has(validId)) {
      return this.session._threadIgidMap.get(validId);
    }
    return validId;
  }

  /**
   * Retrieves inbox conversation threads.
   *
   * @param {Object} [options]
   * @param {number} [options.limit=20]
   * @param {string} [options.cursor]
   * @param {boolean} [options.forceRest=false]
   * @returns {Promise<{conversations: Conversation[], oldestCursor: string|null, hasOlder: boolean, unseenCount: number}>}
   */
  async getInbox(options = {}) {
    // If not explicitly forced to REST, attempt modern Web GraphQL (PolarisDirectInboxQuery)
    // which bypasses prompt contribution dialogs on creator/business accounts.
    if (!options.forceRest) {
      try {
        const gqlResult = await this.getGraphQLInbox(options);
        if (gqlResult && Array.isArray(gqlResult.conversations) && gqlResult.conversations.length > 0) {
          return gqlResult;
        }
      } catch (err) {
        if (this.logger && typeof this.logger.debug === 'function') {
          this.logger.debug(`GraphQL inbox bypassed: ${err.message}. Falling back to REST inbox.`);
        }
      }
    }

    const limit = options.limit || 20;
    const params = {
      visual_message_return_type: 'unseen',
      thread_message_limit: 10,
      persistentBadging: 'true',
      limit
    };

    if (options.cursor) {
      params.cursor = options.cursor;
    }

    const response = await this.transport.get(Endpoints.INBOX, { params });
    const data = response.data || {};
    const inbox = data.inbox || {};
    const rawThreads = inbox.threads || [];
    const currentUserId = this.session ? this.session.userId : null;

    const conversations = rawThreads.map((t) => Conversation.fromRaw(t, currentUserId));
    this._cacheThreadIds(conversations);

    return {
      conversations,
      oldestCursor: inbox.oldest_cursor || null,
      hasOlder: Boolean(inbox.has_older),
      unseenCount: Number(inbox.unseen_count || 0)
    };
  }

  /**
   * Ensures DTSG and LSD tokens are extracted and cached from Instagram Web.
   */
  async _ensureGraphQLTokens() {
    if (this.session && this.session._dtsg && this.session._lsd) {
      return { dtsg: this.session._dtsg, lsd: this.session._lsd };
    }

    if (!this.transport || typeof this.transport.get !== 'function') {
      return {
        dtsg: this.session ? this.session._dtsg : null,
        lsd: this.session ? this.session._lsd : null
      };
    }

    try {
      const response = await this.transport.get(`${Endpoints.BASE_URL}/direct/inbox/`, {
        validateStatus: (s) => s < 400
      });
      const html = typeof response.data === 'string' ? response.data : '';
      const dtsgMatches = Array.from(html.matchAll(/"(NAf[^"]+)"/g)).map((m) => m[1]);
      const lsdMatches = Array.from(html.matchAll(/"LSD",\[\],\{"token":"([^"]+)"/g)).map((m) => m[1]);

      const dtsg = dtsgMatches[0] || null;
      const lsd = lsdMatches[0] || null;

      if (this.session) {
        if (dtsg) this.session._dtsg = dtsg;
        if (lsd) this.session._lsd = lsd;
      }
      return { dtsg, lsd };
    } catch (err) {
      if (this.logger && typeof this.logger.debug === 'function') {
        this.logger.debug(`Could not pre-fetch GraphQL tokens: ${err.message}`);
      }
      return {
        dtsg: this.session ? this.session._dtsg : null,
        lsd: this.session ? this.session._lsd : null
      };
    }
  }

  /**
   * Retrieves inbox threads using modern Web GraphQL query (PolarisDirectInboxQuery).
   *
   * @param {Object} [options]
   * @param {number} [options.limit=20]
   * @returns {Promise<{conversations: Conversation[], oldestCursor: string|null, hasOlder: boolean, unseenCount: number}>}
   */
  async getGraphQLInbox(options = {}) {
    const currentUserId = this.session ? this.session.userId : null;
    const csrf = this.session && typeof this.session.getCsrfToken === 'function'
      ? this.session.getCsrfToken()
      : '';

    const { dtsg, lsd } = await this._ensureGraphQLTokens();

    const payload = new URLSearchParams();
    if (dtsg) payload.append('fb_dtsg', dtsg);
    if (lsd) payload.append('lsd', lsd);
    payload.append('fb_api_caller_class', 'RelayModern');
    payload.append('fb_api_req_friendly_name', 'PolarisDirectInboxQuery');
    payload.append('server_timestamps', 'true');
    payload.append('doc_id', Endpoints.GRAPHQL_DOCS.INBOX);
    payload.append('variables', JSON.stringify({
      device_id_for_iris_subscription: (this.session && this.session.deviceId) || '7b536d77-70d4-47e1-82af-d123e124c07f',
      __relay_internal__pv__IGDIsProfessionalAccountGKrelayprovider: true,
      __relay_internal__pv__IGDPinnedThreadsRenderEnabledGKrelayprovider: true,
      __relay_internal__pv__IGDMaxUnreadMessagesCountrelayprovider: options.limit || 10,
      __relay_internal__pv__IGDThreadListActionsEnabledGKrelayprovider: true
    }));

    const response = await this.transport.post(Endpoints.GRAPHQL, payload.toString(), {
      headers: {
        'x-csrftoken': csrf,
        'x-fb-friendly-name': 'PolarisDirectInboxQuery',
        'x-ig-app-id': Endpoints.WEB_APP_ID,
        'x-asbd-id': Endpoints.ASBD_ID,
        'x-fb-lsd': lsd || '0l2qtDa0grAFC5qqeoHlvO',
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: Endpoints.BASE_URL,
        Referer: `${Endpoints.BASE_URL}/direct/inbox/`,
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin'
      }
    });

    const data = response.data && response.data.data;
    if (!data || !data.get_slide_mailbox_for_iris_subscription) {
      throw new Error('Malformed GraphQL inbox response');
    }

    const mailbox = data.get_slide_mailbox_for_iris_subscription;
    const threadEdges = (mailbox.threads_by_folder && mailbox.threads_by_folder.edges) || [];
    const conversations = threadEdges
      .map((edge) => Conversation.fromRaw(edge.node || edge, currentUserId))
      .filter(Boolean);
    this._cacheThreadIds(conversations);

    const pageInfo = (mailbox.threads_by_folder && mailbox.threads_by_folder.page_info) || {};

    return {
      conversations,
      oldestCursor: pageInfo.end_cursor || null,
      hasOlder: Boolean(pageInfo.has_next_page),
      unseenCount: 0
    };
  }

  /**
   * Retrieves pending / message requests inbox via modern Web GraphQL (PolarisDirectMessageRequestQuery)
   * with legacy REST fallback.
   *
   * @param {Object} [options]
   * @param {number} [options.limit=20]
   * @param {string} [options.cursor]
   * @param {boolean} [options.forceRest=false]
   * @returns {Promise<{conversations: Conversation[], oldestCursor: string|null, hasOlder: boolean}>}
   */
  async getPendingInbox(options = {}) {
    const currentUserId = this.session ? this.session.userId : null;

    if (!options.forceRest && this.transport && typeof this.transport.post === 'function') {
      try {
        const csrf = this.session && typeof this.session.getCsrfToken === 'function'
          ? this.session.getCsrfToken()
          : '';
        const { dtsg, lsd } = await this._ensureGraphQLTokens();

        const payload = new URLSearchParams();
        if (dtsg) payload.append('fb_dtsg', dtsg);
        if (lsd) payload.append('lsd', lsd);
        payload.append('fb_api_caller_class', 'RelayModern');
        payload.append('fb_api_req_friendly_name', 'PolarisDirectMessageRequestQuery');
        payload.append('server_timestamps', 'true');
        payload.append('doc_id', Endpoints.GRAPHQL_DOCS.MESSAGE_REQUESTS);
        payload.append('variables', JSON.stringify({
          folder_type: 'PENDING',
          first: options.limit || 20,
          after: options.cursor || null
        }));

        const response = await this.transport.post(Endpoints.GRAPHQL, payload.toString(), {
          headers: {
            'x-csrftoken': csrf,
            'x-fb-friendly-name': 'PolarisDirectMessageRequestQuery',
            'x-ig-app-id': Endpoints.WEB_APP_ID,
            'x-asbd-id': Endpoints.ASBD_ID,
            'x-fb-lsd': lsd || '0l2qtDa0grAFC5qqeoHlvO',
            'Content-Type': 'application/x-www-form-urlencoded',
            Origin: Endpoints.BASE_URL,
            Referer: `${Endpoints.BASE_URL}/direct/requests/`,
            'sec-fetch-dest': 'empty',
            'sec-fetch-mode': 'cors',
            'sec-fetch-site': 'same-origin'
          }
        });

        const gqlData = response && response.data && response.data.data;
        const mailbox = gqlData && (
          gqlData.get_slide_mailbox_for_iris_subscription ||
          gqlData.ig_direct_pending_inbox ||
          gqlData.pending_inbox
        );

        if (mailbox && mailbox.threads_by_folder && Array.isArray(mailbox.threads_by_folder.edges)) {
          const conversations = mailbox.threads_by_folder.edges
            .map((edge) => Conversation.fromRaw(edge.node || edge, currentUserId))
            .filter(Boolean);
          this._cacheThreadIds(conversations);
          const pageInfo = mailbox.threads_by_folder.page_info || {};
          return {
            conversations,
            oldestCursor: pageInfo.end_cursor || null,
            hasOlder: Boolean(pageInfo.has_next_page)
          };
        }
      } catch (err) {
        if (this.logger && typeof this.logger.debug === 'function') {
          this.logger.debug(`GraphQL pending inbox failed (${err.message}), falling back to REST.`);
        }
      }
    }

    const params = {};
    if (options.cursor) params.cursor = options.cursor;
    if (options.limit) params.limit = options.limit;

    const response = await this.transport.get(Endpoints.PENDING_INBOX, { params });
    const data = response.data || {};
    const inbox = data.inbox || {};
    const rawThreads = inbox.threads || [];

    const conversations = rawThreads.map((t) => Conversation.fromRaw(t, currentUserId));
    this._cacheThreadIds(conversations);

    return {
      conversations,
      oldestCursor: inbox.oldest_cursor || null,
      hasOlder: Boolean(inbox.has_older)
    };
  }

  /**
   * Accepts (approves) an incoming DM message request thread.
   * Uses modern Web GraphQL (useIGDirectAcceptMessageRequestMutation) with REST fallback.
   *
   * @param {string} threadId - Target pending thread ID / FBID
   * @param {Object} [options]
   * @param {number} [options.folder=0] - Target inbox folder (0 = Primary, 1 = General)
   * @param {boolean} [options.forceRest=false]
   * @returns {Promise<{success: boolean, threadId: string, folder: number|string|null}>}
   */
  async acceptMessageRequest(threadId, options = {}) {
    const validThreadId = validateThreadId(threadId);
    const csrf = this.session && typeof this.session.getCsrfToken === 'function'
      ? this.session.getCsrfToken()
      : '';
    const folder = options.folder !== undefined ? options.folder : 0;

    if (!options.forceRest && this.transport && typeof this.transport.post === 'function') {
      try {
        const { dtsg, lsd } = await this._ensureGraphQLTokens();
        const offlineId = String(BigInt(Date.now()) * 1000000n + BigInt(Math.floor(Math.random() * 1000000)));

        const payload = new URLSearchParams();
        if (dtsg) payload.append('fb_dtsg', dtsg);
        if (lsd) payload.append('lsd', lsd);
        payload.append('fb_api_caller_class', 'RelayModern');
        payload.append('fb_api_req_friendly_name', 'useIGDirectAcceptMessageRequestMutation');
        payload.append('server_timestamps', 'true');
        payload.append('doc_id', Endpoints.GRAPHQL_DOCS.ACCEPT_REQUEST);
        payload.append('variables', JSON.stringify({
          ig_inbox_folder: folder,
          offline_threading_id: offlineId,
          thread_fbid: validThreadId
        }));

        const response = await this.transport.post(
          Endpoints.GRAPHQL,
          payload.toString(),
          {
            headers: {
              'x-csrftoken': csrf,
              'x-fb-friendly-name': 'useIGDirectAcceptMessageRequestMutation',
              'x-ig-app-id': Endpoints.WEB_APP_ID,
              'x-asbd-id': Endpoints.ASBD_ID,
              'x-fb-lsd': lsd || '0l2qtDa0grAFC5qqeoHlvO',
              'Content-Type': 'application/x-www-form-urlencoded',
              Origin: Endpoints.BASE_URL,
              Referer: `${Endpoints.BASE_URL}/direct/t/${validThreadId}/`,
              'sec-fetch-dest': 'empty',
              'sec-fetch-mode': 'cors',
              'sec-fetch-site': 'same-origin'
            }
          },
          false
        );

        const respData = response && response.data;
        if (respData && respData.errors && respData.errors.length > 0) {
          throw new InstaChatError(respData.errors[0].message || 'GraphQL accept message request failed', {
            details: respData.errors
          });
        }

        const node = respData && respData.data && respData.data.ig_direct_accept_message_request;
        if (node) {
          return {
            success: true,
            threadId: String(node.id || validThreadId),
            folder: node.folder !== undefined ? node.folder : folder
          };
        }
      } catch (err) {
        if (err instanceof InstaChatError) throw err;
        if (this.logger && typeof this.logger.debug === 'function') {
          this.logger.debug(`GraphQL acceptMessageRequest failed (${err.message}), trying REST approve.`);
        }
      }
    }

    const restId = this.resolveRestThreadId(validThreadId);
    const payload = new URLSearchParams();
    payload.append('folder', String(folder));
    if (csrf) payload.append('_csrftoken', csrf);
    payload.append('_uuid', crypto.randomUUID());

    const response = await this.transport.post(
      Endpoints.THREAD_APPROVE(restId),
      payload.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      false
    );

    const data = response.data || {};
    if (data.status && data.status !== 'ok') {
      throw new InstaChatError(data.message || `Failed to accept message request ${validThreadId}`, {
        details: data
      });
    }

    return {
      success: true,
      threadId: validThreadId,
      folder
    };
  }

  /**
   * Declines (deletes) an incoming DM message request thread.
   *
   * @param {string} threadId
   * @returns {Promise<{success: boolean, threadId: string}>}
   */
  async declineMessageRequest(threadId) {
    const validThreadId = validateThreadId(threadId);
    const restId = this.resolveRestThreadId(validThreadId);
    const csrf = this.session && typeof this.session.getCsrfToken === 'function'
      ? this.session.getCsrfToken()
      : '';

    const payload = new URLSearchParams();
    if (csrf) payload.append('_csrftoken', csrf);
    payload.append('_uuid', crypto.randomUUID());

    const response = await this.transport.post(
      Endpoints.THREAD_DECLINE(restId),
      payload.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      false
    );

    const data = response.data || {};
    if (data.status && data.status !== 'ok') {
      throw new InstaChatError(data.message || `Failed to decline message request ${validThreadId}`, {
        details: data
      });
    }

    return {
      success: true,
      threadId: validThreadId
    };
  }

  /**
   * Searches messages within a specific conversation thread.
   *
   * @param {string} threadId
   * @param {string} query
   * @param {Object} [options]
   * @param {number} [options.offset=0]
   * @returns {Promise<{messages: Message[], offset: number, hasMore: boolean}>}
   */
  async searchInThread(threadId, query, options = {}) {
    const validThreadId = validateThreadId(threadId);
    const validQuery = validateSearchQuery(query);
    const offset = Math.max(0, Number(options.offset) || 0);
    const currentUserId = this.session ? this.session.userId : null;
    const restId = this.resolveRestThreadId(validThreadId);

    try {
      const response = await this.transport.get(Endpoints.IN_THREAD_SEARCH, {
        params: {
          id: restId,
          query: validQuery,
          offset
        }
      });

      const data = response.data || {};
      const rawItems = data.items || data.messages || data.results || [];
      if (Array.isArray(rawItems) && (data.status === 'ok' || rawItems.length > 0)) {
        const messages = rawItems.map((item) =>
          Message.fromRaw({ ...item, thread_id: validThreadId }, currentUserId)
        ).filter(Boolean);

        return {
          messages,
          offset: Number(data.offset !== undefined ? data.offset : offset + messages.length),
          hasMore: Boolean(data.has_more)
        };
      }
    } catch (err) {
      if (this.logger && typeof this.logger.debug === 'function') {
        this.logger.debug(`REST in-thread search failed (${err.message}), filtering thread history locally.`);
      }
    }

    // Fallback: filter fetched thread messages case-insensitively
    const { messages: history } = await this.getThread(validThreadId, { limit: options.limit || 50 });
    const needle = validQuery.toLowerCase();
    const matched = history.filter((m) => m && m.text && m.text.toLowerCase().includes(needle));

    return {
      messages: matched.slice(offset),
      offset: matched.length,
      hasMore: false
    };
  }

  /**
   * Retrieves thread details and recent messages (including quoted reply metadata)
   * via modern Instagram Web GraphQL (IGDThreadDetailQuery).
   *
   * @param {string} threadId - Thread FBID (or direct_v2 thread ID)
   * @param {Object} [options]
   * @param {number} [options.limit=15]
   * @returns {Promise<{conversation: Conversation, messages: Message[], oldestCursor: string|null, hasOlder: boolean}>}
   */
  async getGraphQLThread(threadId, options = {}) {
    const validId = validateThreadId(threadId);
    const currentUserId = this.session ? this.session.userId : null;
    const csrf = this.session && typeof this.session.getCsrfToken === 'function'
      ? this.session.getCsrfToken()
      : '';

    const { dtsg, lsd } = await this._ensureGraphQLTokens();

    const payload = new URLSearchParams();
    if (dtsg) payload.append('fb_dtsg', dtsg);
    if (lsd) payload.append('lsd', lsd);
    payload.append('fb_api_caller_class', 'RelayModern');
    payload.append('fb_api_req_friendly_name', 'IGDThreadDetailQuery');
    payload.append('server_timestamps', 'true');
    payload.append('doc_id', Endpoints.GRAPHQL_DOCS.THREAD_DETAIL);
    payload.append('variables', JSON.stringify({
      thread_fbid: validId,
      __relay_internal__pv__IGDEnableOffMsysChatThemesQErelayprovider: true,
      __relay_internal__pv__IGDInitialMessagePageCountrelayprovider: options.limit || 15
    }));

    const response = await this.transport.post(Endpoints.GRAPHQL, payload.toString(), {
      headers: {
        'x-csrftoken': csrf,
        'x-fb-friendly-name': 'IGDThreadDetailQuery',
        'x-ig-app-id': Endpoints.WEB_APP_ID,
        'x-asbd-id': Endpoints.ASBD_ID,
        'x-fb-lsd': lsd || '0l2qtDa0grAFC5qqeoHlvO',
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: Endpoints.BASE_URL,
        Referer: `${Endpoints.BASE_URL}/direct/t/${validId}/`,
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin'
      }
    });

    const data = response && response.data && response.data.data;
    const rawNode = data && data.get_slide_thread_nullable;
    if (!rawNode || !rawNode.as_ig_direct_thread) {
      throw new Error('Malformed or empty GraphQL thread detail response');
    }

    const conversation = Conversation.fromRaw(rawNode, currentUserId);
    this._cacheThreadIds([conversation]);

    const rawThread = rawNode.as_ig_direct_thread;
    const pageInfo = (rawThread.slide_messages && rawThread.slide_messages.page_info) || {};

    return {
      conversation,
      messages: conversation.messages,
      oldestCursor: pageInfo.start_cursor || pageInfo.end_cursor || null,
      hasOlder: Boolean(pageInfo.has_previous_page || pageInfo.has_next_page)
    };
  }

  /**
   * Retrieves specific conversation thread details and message history.
   *
   * @param {string} threadId
   * @param {Object} [options]
   * @param {string} [options.cursor]
   * @param {string} [options.direction='older']
   * @param {boolean} [options.forceRest=false]
   * @returns {Promise<{conversation: Conversation, messages: Message[], oldestCursor: string|null, hasOlder: boolean}>}
   */
  async getThread(threadId, options = {}) {
    const validId = validateThreadId(threadId);

    if (!options.forceRest && !options.cursor && this.transport && typeof this.transport.post === 'function') {
      try {
        return await this.getGraphQLThread(validId, options);
      } catch (gqlErr) {
        if (this.logger && typeof this.logger.debug === 'function') {
          this.logger.debug(`GraphQL thread detail failed (${gqlErr.message}), falling back to REST.`);
        }
      }
    }

    const params = {};
    if (options.cursor) {
      params.cursor = options.cursor;
      params.direction = options.direction || 'older';
    }

    const restId = this.resolveRestThreadId(validId);
    const response = await this.transport.get(Endpoints.THREAD(restId), { params });
    const data = response.data || {};
    const threadData = data.thread;

    if (!threadData) {
      throw new NotFoundError(`Conversation thread ${validId} was not returned by Instagram API.`);
    }

    const currentUserId = this.session ? this.session.userId : null;
    const conversation = Conversation.fromRaw(threadData, currentUserId);
    this._cacheThreadIds([conversation]);

    return {
      conversation,
      messages: conversation.messages,
      oldestCursor: threadData.oldest_cursor || null,
      hasOlder: Boolean(threadData.has_older)
    };
  }

  /**
   * Searches for a conversation by username in the loaded inbox.
   *
   * @param {string} username
   * @returns {Promise<Conversation|null>}
   */
  async findByUsername(username) {
    if (!username || typeof username !== 'string') return null;
    const cleanUser = username.trim().toLowerCase().replace(/^@/, '');

    const { conversations } = await this.getInbox({ limit: 50 });
    for (const conv of conversations) {
      const match = conv.participants.some(
        (p) => (p.username && p.username.toLowerCase() === cleanUser)
      );
      if (match) return conv;
    }
    return null;
  }
}

module.exports = ConversationsService;
