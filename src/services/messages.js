'use strict';

const crypto = require('crypto');
const Endpoints = require('../constants/endpoints');
const Message = require('../models/message');
const {
  validateThreadId,
  validateMessageId,
  validateTextMessage
} = require('../utils/validators');
const { UnsupportedFeatureError, InstaChatError } = require('../utils/errors');

class MessagesService {
  constructor(options = {}) {
    this.transport = options.transport;
    this.session = options.session;
    this.logger = options.logger;
    this.conversationsService = options.conversationsService || null;
  }

  /**
   * Generates a unique client context UUID for idempotency.
   */
  _generateClientContext() {
    return crypto.randomUUID();
  }

  _generateOfflineThreadingId() {
    return String(BigInt(Date.now()) * 1000000n + BigInt(Math.floor(Math.random() * 1000000)));
  }

  _resolveRestThreadId(threadId) {
    const validId = validateThreadId(threadId);
    if (this.conversationsService && typeof this.conversationsService.resolveRestThreadId === 'function') {
      return this.conversationsService.resolveRestThreadId(validId);
    }
    if (this.session && this.session._threadIgidMap && this.session._threadIgidMap.has(validId)) {
      return this.session._threadIgidMap.get(validId);
    }
    return validId;
  }

  /**
   * Normalizes optional @mentions metadata for GraphQL & REST message payloads.
   *
   * @param {string} text
   * @param {Array<Object|string|number>} [rawMentions=[]]
   * @returns {{gqlMentions: Array<Object>, mentionedUserIds: string[]}}
   * @private
   */
  _buildMentionsPayload(text, rawMentions = []) {
    if (!Array.isArray(rawMentions) || rawMentions.length === 0) {
      return { gqlMentions: [], mentionedUserIds: [] };
    }

    const gqlMentions = [];
    const mentionedUserIds = [];

    for (const item of rawMentions) {
      if (!item) continue;
      if (typeof item === 'string' || typeof item === 'number') {
        const uid = String(item).trim();
        if (uid) mentionedUserIds.push(uid);
        continue;
      }

      const uid = String(item.userId || item.user_id || item.mentioned_user_id || item.id || '').trim();
      if (!uid) continue;
      mentionedUserIds.push(uid);

      let offset = item.offset !== undefined ? Number(item.offset) : -1;
      let length = item.length !== undefined ? Number(item.length) : 0;

      if ((offset < 0 || length <= 0) && item.username) {
        const tag = item.username.startsWith('@') ? item.username : `@${item.username}`;
        const idx = text.toLowerCase().indexOf(tag.toLowerCase());
        if (idx !== -1) {
          offset = idx;
          length = tag.length;
        }
      }

      if (offset >= 0 && length > 0) {
        gqlMentions.push({
          mentioned_user_id: uid,
          offset,
          length
        });
      }
    }

    return {
      gqlMentions,
      mentionedUserIds: Array.from(new Set(mentionedUserIds))
    };
  }

  /**
   * Sends a text message to a conversation thread.
   *
   * @param {string} threadId - Target conversation thread ID
   * @param {string} text - Message text to send
   * @param {Object} [options]
   * @param {string} [options.replyToItemId] - Message item ID to reply to
   * @param {Array<Object|string>} [options.mentions] - Optional rich @mentions list
   * @param {boolean} [options.isEncrypted] - Flag indicating whether target thread is E2EE
   * @param {boolean} [options.forceRest=false] - Force legacy direct_v2 route
   * @returns {Promise<Message>}
   */
  async sendTextMessage(threadId, text, options = {}) {
    const validThreadId = validateThreadId(threadId);
    const validText = validateTextMessage(text);

    if (options.isEncrypted) {
      throw new UnsupportedFeatureError(
        'Sending messages to End-to-End Encrypted (E2EE) threads is not supported via standard web endpoints.',
        { feature: 'E2EE_MESSAGING' }
      );
    }

    // Attempt modern Web GraphQL mutation (IGDirectTextSendMutation)
    if (!options.forceRest) {
      try {
        return await this.sendGraphQLTextMessage(validThreadId, validText, options);
      } catch (err) {
        if (this.logger && typeof this.logger.debug === 'function') {
          this.logger.debug(`GraphQL send message bypass: ${err.message}. Trying REST broadcast.`);
        }
      }
    }

    const clientContext = options.clientContext || this._generateClientContext();
    const csrfToken = this.session ? this.session.getCsrfToken() : '';
    const currentUserId = this.session ? this.session.userId : null;
    const { gqlMentions, mentionedUserIds } = this._buildMentionsPayload(validText, options.mentions);

    const payload = new URLSearchParams();
    payload.append('action', 'send_item');
    payload.append('thread_ids', JSON.stringify([validThreadId]));
    payload.append('text', validText);
    payload.append('client_context', clientContext);
    payload.append('_csrftoken', csrfToken);
    payload.append('_uuid', clientContext);

    if (mentionedUserIds.length > 0) {
      payload.append('mentioned_user_ids', JSON.stringify(mentionedUserIds));
    }

    if (options.replyToItemId) {
      const validReplyId = validateMessageId(options.replyToItemId);
      payload.append('replied_to_item_id', validReplyId);
      payload.append('reply_type', 'comments');
    }

    const response = await this.transport.post(
      Endpoints.BROADCAST_TEXT,
      payload.toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      },
      false // Not idempotent, do not blindly retry on network drops
    );

    const data = response.data || {};
    if (data.status !== 'ok') {
      throw new InstaChatError(data.message || 'Failed to send direct message', {
        details: data
      });
    }

    // Return normalized Message
    const rawItem = {
      item_id: data.item_id || clientContext,
      thread_id: validThreadId,
      user_id: currentUserId,
      timestamp: data.timestamp || Date.now() * 1000,
      item_type: 'text',
      text: validText,
      mentions: gqlMentions,
      replied_to_message: options.replyToItemId ? { item_id: options.replyToItemId } : null
    };

    return Message.fromRaw(rawItem, currentUserId);
  }

  /**
   * Helper to ensure valid fb_dtsg and lsd tokens for GraphQL operations.
   *
   * @returns {Promise<{dtsg: string|null, lsd: string|null}>}
   * @private
   */
  async _ensureDtsgAndLsd() {
    let dtsg = this.session && this.session._dtsg ? this.session._dtsg : null;
    let lsd = this.session && this.session._lsd ? this.session._lsd : null;

    if ((!dtsg || !lsd) && this.transport && typeof this.transport.get === 'function') {
      try {
        const pageRes = await this.transport.get(`${Endpoints.BASE_URL}/direct/inbox/`, {
          validateStatus: (s) => s < 400
        });
        const html = typeof pageRes?.data === 'string' ? pageRes.data : '';
        const dtsgMatches = Array.from(html.matchAll(/"(NAf[^"]+)"/g)).map((m) => m[1]);
        const lsdMatches = Array.from(html.matchAll(/"LSD",\[\],\{"token":"([^"]+)"/g)).map((m) => m[1]);
        if (dtsgMatches[0]) dtsg = dtsgMatches[0];
        if (lsdMatches[0]) lsd = lsdMatches[0];
        if (this.session) {
          if (dtsg) this.session._dtsg = dtsg;
          if (lsd) this.session._lsd = lsd;
        }
      } catch (err) {}
    }

    return { dtsg, lsd };
  }

  /**
   * Sends text message using modern Instagram Web GraphQL mutation (IGDirectTextSendMutation).
   *
   * @param {string} threadId
   * @param {string} text
   * @param {Object} [options]
   * @returns {Promise<Message>}
   */
  async sendGraphQLTextMessage(threadId, text, options = {}) {
    const validThreadId = validateThreadId(threadId);
    const validText = validateTextMessage(text);
    const currentUserId = this.session ? this.session.userId : null;
    const csrf = this.session ? this.session.getCsrfToken() : '';

    const { dtsg, lsd } = await this._ensureDtsgAndLsd();
    const offlineId = this._generateOfflineThreadingId();
    const { gqlMentions, mentionedUserIds } = this._buildMentionsPayload(validText, options.mentions);

    const payload = new URLSearchParams();
    if (dtsg) payload.append('fb_dtsg', dtsg);
    if (lsd) payload.append('lsd', lsd);
    payload.append('fb_api_caller_class', 'RelayModern');
    payload.append('fb_api_req_friendly_name', 'IGDirectTextSendMutation');
    payload.append('server_timestamps', 'true');
    payload.append('doc_id', Endpoints.GRAPHQL_DOCS.SEND_TEXT);
    payload.append('variables', JSON.stringify({
      ig_thread_igid: validThreadId,
      offline_threading_id: offlineId,
      recipient_igids: null,
      replied_to_client_context: null,
      replied_to_item_id: options.replyToItemId || null,
      reply_to_message_id: options.replyToItemId || null,
      sampled: null,
      text: {
        sensitive_string_value: validText
      },
      mentions: gqlMentions,
      mentioned_user_ids: mentionedUserIds,
      commands: options.commands || null,
      forwarded_from_thread_id: options.forwardedFromThreadId || null,
      is_forwarded_from_own_message: options.isForwardedFromOwnMessage ?? null,
      send_attribution: options.sendAttribution || 'igd_web_chat_tab:in_thread'
    }));

    const response = await this.transport.post(
      Endpoints.GRAPHQL,
      payload.toString(),
      {
        headers: {
          'x-csrftoken': csrf,
          'x-fb-friendly-name': 'IGDirectTextSendMutation',
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

    const data = response.data && response.data.data;
    const sendResp = data && data.xig_direct_text_send_with_slide_messaging_response;
    if (!sendResp) {
      throw new Error('Malformed GraphQL send response');
    }

    const rawItem = {
      item_id: sendResp.message_id || sendResp.id || offlineId,
      thread_id: validThreadId,
      user_id: currentUserId,
      timestamp: Number(sendResp.timestamp_ms || Date.now()) * 1000,
      item_type: 'text',
      text: validText,
      mentions: gqlMentions,
      igd_is_forwarded: Boolean(options.forwardedFromThreadId),
      replied_to_message: options.replyToItemId ? { item_id: options.replyToItemId } : null
    };

    return Message.fromRaw(rawItem, currentUserId);
  }

  /**
   * Replies to an existing message.
   *
   * @param {string} threadId
   * @param {string} messageId
   * @param {string} text
   * @param {Object} [options]
   * @returns {Promise<Message>}
   */
  async reply(threadId, messageId, text, options = {}) {
    return this.sendTextMessage(threadId, text, {
      ...options,
      replyToItemId: messageId
    });
  }

  /**
   * Edits a sent text message (Instagram allows editing sent messages within 15 minutes).
   * Uses modern Instagram Web GraphQL (IGDirectEditMessageMutation) with REST fallback.
   *
   * @param {string} threadId
   * @param {string} messageId
   * @param {string} newText
   * @param {Object} [options]
   * @param {boolean} [options.forceRest=false]
   * @returns {Promise<Message>}
   */
  async editMessage(threadId, messageId, newText, options = {}) {
    const validThreadId = validateThreadId(threadId);
    const validMessageId = validateMessageId(messageId);
    const validText = validateTextMessage(newText);
    const csrfToken = this.session ? this.session.getCsrfToken() : '';
    const currentUserId = this.session ? this.session.userId : null;

    if (!options.forceRest) {
      try {
        const { dtsg, lsd } = await this._ensureDtsgAndLsd();
        const offlineId = this._generateOfflineThreadingId();

        const payload = new URLSearchParams();
        if (dtsg) payload.append('fb_dtsg', dtsg);
        if (lsd) payload.append('lsd', lsd);
        payload.append('fb_api_caller_class', 'RelayModern');
        payload.append('fb_api_req_friendly_name', 'IGDirectEditMessageMutation');
        payload.append('server_timestamps', 'true');
        payload.append('doc_id', Endpoints.GRAPHQL_DOCS.EDIT_MESSAGE);
        payload.append('variables', JSON.stringify({
          body: {
            sensitive_string_value: validText
          },
          offline_threading_id: offlineId,
          target_item_id: null,
          target_message_id: validMessageId,
          thread_id: validThreadId
        }));

        const response = await this.transport.post(
          Endpoints.GRAPHQL,
          payload.toString(),
          {
            headers: {
              'x-csrftoken': csrfToken,
              'x-fb-friendly-name': 'IGDirectEditMessageMutation',
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
          throw new InstaChatError(respData.errors[0].message || 'GraphQL editMessage mutation failed', {
            details: respData.errors
          });
        }

        const editResp = respData && respData.data && respData.data.direct_edit_message_with_slide_messaging_response;
        if (editResp) {
          return Message.fromRaw({
            item_id: editResp.message_id || editResp.id || validMessageId,
            thread_id: validThreadId,
            user_id: currentUserId,
            timestamp: Number(editResp.timestamp_ms || Date.now()) * 1000,
            item_type: 'text',
            text: validText,
            is_edited: true
          }, currentUserId);
        }
      } catch (err) {
        if (err instanceof InstaChatError) throw err;
        if (this.logger && typeof this.logger.debug === 'function') {
          this.logger.debug(`GraphQL editMessage failed (${err.message}), falling back to REST.`);
        }
      }
    }

    const restThreadId = this._resolveRestThreadId(validThreadId);
    const clientContext = this._generateClientContext();
    const payload = new URLSearchParams();
    payload.append('text', validText);
    payload.append('client_context', clientContext);
    payload.append('mutation_token', clientContext);
    if (csrfToken) payload.append('_csrftoken', csrfToken);
    payload.append('_uuid', clientContext);

    const response = await this.transport.post(
      Endpoints.EDIT_MESSAGE(restThreadId, validMessageId),
      payload.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      false
    );

    const data = response.data || {};
    if (data.status && data.status !== 'ok') {
      throw new InstaChatError(data.message || 'Failed to edit message', { details: data });
    }

    return Message.fromRaw({
      item_id: (data.payload && data.payload.item_id) || validMessageId,
      thread_id: validThreadId,
      user_id: currentUserId,
      timestamp: (data.payload && data.payload.timestamp) || Date.now() * 1000,
      item_type: 'text',
      text: validText,
      is_edited: true
    }, currentUserId);
  }

  /**
   * Pins a message inside a conversation thread.
   *
   * @param {string} threadId
   * @param {string} messageId
   * @returns {Promise<{success: boolean, threadId: string, messageId: string, pinned: boolean}>}
   */
  async pinMessage(threadId, messageId) {
    const validThreadId = validateThreadId(threadId);
    const validMessageId = validateMessageId(messageId);
    const restThreadId = this._resolveRestThreadId(validThreadId);
    const csrfToken = this.session ? this.session.getCsrfToken() : '';

    const payload = new URLSearchParams();
    if (csrfToken) payload.append('_csrftoken', csrfToken);
    payload.append('_uuid', this._generateClientContext());

    const response = await this.transport.post(
      Endpoints.PIN_MESSAGE(restThreadId, validMessageId),
      payload.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      false
    );

    const data = response.data || {};
    if (data.status && data.status !== 'ok') {
      throw new InstaChatError(data.message || 'Failed to pin message', { details: data });
    }

    return {
      success: true,
      threadId: validThreadId,
      messageId: validMessageId,
      pinned: true
    };
  }

  /**
   * Unpins a previously pinned message inside a conversation thread.
   *
   * @param {string} threadId
   * @param {string} messageId
   * @returns {Promise<{success: boolean, threadId: string, messageId: string, pinned: boolean}>}
   */
  async unpinMessage(threadId, messageId) {
    const validThreadId = validateThreadId(threadId);
    const validMessageId = validateMessageId(messageId);
    const restThreadId = this._resolveRestThreadId(validThreadId);
    const csrfToken = this.session ? this.session.getCsrfToken() : '';

    const payload = new URLSearchParams();
    if (csrfToken) payload.append('_csrftoken', csrfToken);
    payload.append('_uuid', this._generateClientContext());

    const response = await this.transport.post(
      Endpoints.UNPIN_MESSAGE(restThreadId, validMessageId),
      payload.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      false
    );

    const data = response.data || {};
    if (data.status && data.status !== 'ok') {
      throw new InstaChatError(data.message || 'Failed to unpin message', { details: data });
    }

    return {
      success: true,
      threadId: validThreadId,
      messageId: validMessageId,
      pinned: false
    };
  }

  /**
   * Retrieves all pinned messages in a conversation thread.
   *
   * @param {string} threadId
   * @returns {Promise<Message[]>}
   */
  async getPinnedMessages(threadId) {
    const validThreadId = validateThreadId(threadId);
    if (!this.conversationsService || typeof this.conversationsService.getThread !== 'function') {
      throw new InstaChatError('ConversationsService is required to fetch pinned messages.');
    }
    const { conversation } = await this.conversationsService.getThread(validThreadId, { limit: 30 });
    return conversation && Array.isArray(conversation.pinnedMessages) ? conversation.pinnedMessages : [];
  }

  /**
   * Forwards an existing message from one thread to another thread.
   * Supports GraphQL text forwarding (IGDirectTextSendMutation), GraphQL media forwarding
   * (IGDMediaForwardPublisherMutation), and Instagram's direct_v2/threads/broadcast/forward/ endpoint.
   *
   * @param {string} fromThreadId - Source conversation thread ID
   * @param {string} messageId - Source message ID to forward
   * @param {string} toThreadId - Destination conversation thread ID
   * @param {Object} [options]
   * @param {string} [options.text] - Optional text if forwarding a known text message via GraphQL
   * @param {string} [options.attachmentFbid] - Optional media attachment FBID for GraphQL media forward
   * @param {string} [options.itemType='text'] - Item type for REST forward ('text', 'media', 'voice_media', 'clip', 'media_share')
   * @param {boolean} [options.isOwnMessage=false]
   * @param {boolean} [options.forceRest=false]
   * @returns {Promise<Message>}
   */
  async forwardMessage(fromThreadId, messageId, toThreadId, options = {}) {
    const validFromId = validateThreadId(fromThreadId);
    const validMessageId = validateMessageId(messageId);
    const validToId = validateThreadId(toThreadId);
    const currentUserId = this.session ? this.session.userId : null;
    const csrfToken = this.session ? this.session.getCsrfToken() : '';

    // 1a. GraphQL Text Forwarding if text is provided
    if (!options.forceRest && typeof options.text === 'string' && options.text.trim()) {
      try {
        return await this.sendGraphQLTextMessage(validToId, options.text, {
          forwardedFromThreadId: validFromId,
          isForwardedFromOwnMessage: Boolean(options.isOwnMessage)
        });
      } catch (err) {
        if (this.logger && typeof this.logger.debug === 'function') {
          this.logger.debug(`GraphQL text forward failed (${err.message}), trying fallback.`);
        }
      }
    }

    // 1b. GraphQL Media Forwarding (IGDMediaForwardPublisherMutation) if attachmentFbid is provided
    if (!options.forceRest && options.attachmentFbid) {
      try {
        const { dtsg, lsd } = await this._ensureDtsgAndLsd();
        const offlineId = this._generateOfflineThreadingId();

        const payload = new URLSearchParams();
        if (dtsg) payload.append('fb_dtsg', dtsg);
        if (lsd) payload.append('lsd', lsd);
        payload.append('fb_api_caller_class', 'RelayModern');
        payload.append('fb_api_req_friendly_name', 'IGDMediaForwardPublisherMutation');
        payload.append('server_timestamps', 'true');
        payload.append('doc_id', Endpoints.GRAPHQL_DOCS.FORWARD_MEDIA);
        payload.append('variables', JSON.stringify({
          attachment_fbid: String(options.attachmentFbid),
          forwarded_from_thread_id: validFromId,
          forwarded_from_thread_item_id: validMessageId,
          is_forwarded_from_own_message: Boolean(options.isOwnMessage),
          offline_threading_id: offlineId,
          recipient_users: null,
          thread_id: validToId
        }));

        const response = await this.transport.post(
          Endpoints.GRAPHQL,
          payload.toString(),
          {
            headers: {
              'x-csrftoken': csrfToken,
              'x-fb-friendly-name': 'IGDMediaForwardPublisherMutation',
              'x-ig-app-id': Endpoints.WEB_APP_ID,
              'x-asbd-id': Endpoints.ASBD_ID,
              'x-fb-lsd': lsd || '0l2qtDa0grAFC5qqeoHlvO',
              'Content-Type': 'application/x-www-form-urlencoded',
              Origin: Endpoints.BASE_URL,
              Referer: `${Endpoints.BASE_URL}/direct/t/${validToId}/`,
              'sec-fetch-dest': 'empty',
              'sec-fetch-mode': 'cors',
              'sec-fetch-site': 'same-origin'
            }
          },
          false
        );

        const respData = response && response.data;
        if (respData && respData.errors && respData.errors.length > 0) {
          throw new InstaChatError(respData.errors[0].message || 'GraphQL forward media mutation failed', {
            details: respData.errors
          });
        }

        const fwdResp = respData && respData.data && respData.data.xig_direct_media_send_with_slide_messaging_response;
        if (fwdResp) {
          return Message.fromRaw({
            item_id: fwdResp.message_id || fwdResp.id || offlineId,
            thread_id: validToId,
            user_id: currentUserId,
            timestamp: Number(fwdResp.timestamp_ms || Date.now()) * 1000,
            item_type: 'media',
            igd_is_forwarded: true
          }, currentUserId);
        }
      } catch (err) {
        if (err instanceof InstaChatError) throw err;
        if (this.logger && typeof this.logger.debug === 'function') {
          this.logger.debug(`GraphQL media forward failed (${err.message}), trying REST broadcast/forward.`);
        }
      }
    }

    // 2. REST broadcast/forward endpoint
    const restFromId = this._resolveRestThreadId(validFromId);
    const restToId = this._resolveRestThreadId(validToId);
    const offlineId = this._generateOfflineThreadingId();

    const payload = new URLSearchParams();
    payload.append('action', 'forward_item');
    payload.append('thread_id', restToId);
    payload.append('item_type', options.itemType || 'text');
    payload.append('forwarded_from_thread_id', restFromId);
    payload.append('forwarded_from_thread_item_id', validMessageId);
    payload.append('client_context', offlineId);
    payload.append('mutation_token', offlineId);
    payload.append('send_attribution', 'thread_view');
    if (csrfToken) payload.append('_csrftoken', csrfToken);

    const response = await this.transport.post(
      Endpoints.BROADCAST_FORWARD,
      payload.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      false
    );

    const data = response.data || {};
    if (data.status && data.status !== 'ok') {
      throw new InstaChatError(data.message || 'Failed to forward message', { details: data });
    }

    return Message.fromRaw({
      item_id: (data.payload && data.payload.item_id) || data.item_id || offlineId,
      thread_id: validToId,
      user_id: currentUserId,
      timestamp: (data.payload && data.payload.timestamp) || data.timestamp || Date.now() * 1000,
      item_type: options.itemType || 'text',
      text: options.text || '',
      igd_is_forwarded: true
    }, currentUserId);
  }

  /**
   * Unsends (deletes) a message sent by the authenticated user using modern Instagram Web GraphQL.
   *
   * @param {string} threadId
   * @param {string} messageId
   * @returns {Promise<{success: boolean, threadId: string, messageId: string}>}
   */
  async unsend(threadId, messageId) {
    const validThreadId = validateThreadId(threadId);
    const validMessageId = validateMessageId(messageId);

    const csrfToken = this.session ? this.session.getCsrfToken() : '';
    const { dtsg, lsd } = await this._ensureDtsgAndLsd();

    // 1. Primary: Modern Instagram Web GraphQL Mutation (IGDMessageUnsendDialogOffMsysMutation)
    try {
      const payload = new URLSearchParams();
      payload.append('__a', '1');
      payload.append('__d', 'www');
      payload.append('__comet_req', '7');
      if (dtsg) payload.append('fb_dtsg', dtsg);
      if (lsd) payload.append('lsd', lsd);
      payload.append('fb_api_caller_class', 'RelayModern');
      payload.append('fb_api_req_friendly_name', 'IGDMessageUnsendDialogOffMsysMutation');
      payload.append('server_timestamps', 'true');
      payload.append('doc_id', Endpoints.GRAPHQL_DOCS.UNSEND_MESSAGE);
      payload.append('variables', JSON.stringify({
        message_id: validMessageId,
        send_data: {
          thread_id: validThreadId
        }
      }));

      const response = await this.transport.post(
        Endpoints.GRAPHQL,
        payload.toString(),
        {
          headers: {
            'x-csrftoken': csrfToken,
            'x-fb-friendly-name': 'IGDMessageUnsendDialogOffMsysMutation',
            'x-ig-app-id': Endpoints.WEB_APP_ID,
            'x-asbd-id': Endpoints.ASBD_ID,
            'x-fb-lsd': lsd || 'vVGKziA3Kr0EqJIOZpc6N7',
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
      if (respData && respData.data && respData.data.direct_unsend_message === true) {
        return {
          success: true,
          threadId: validThreadId,
          messageId: validMessageId
        };
      }

      if (respData && respData.errors && respData.errors.length > 0) {
        throw new InstaChatError(respData.errors[0].message || 'GraphQL unsend mutation error', {
          details: respData.errors
        });
      }
    } catch (gqlErr) {
      if (gqlErr instanceof InstaChatError) {
        throw gqlErr;
      }

      // 2. Fallback: Legacy mobile REST delete endpoint
      try {
        const clientContext = this._generateClientContext();
        const legacyPayload = new URLSearchParams();
        legacyPayload.append('client_context', clientContext);
        legacyPayload.append('_csrftoken', csrfToken);

        const legacyResponse = await this.transport.post(
          Endpoints.DELETE_MESSAGE(validThreadId, validMessageId),
          legacyPayload.toString(),
          {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded'
            }
          },
          false
        );

        const data = legacyResponse.data || {};
        if (data.status === 'ok') {
          return {
            success: true,
            threadId: validThreadId,
            messageId: validMessageId
          };
        }
      } catch (legacyErr) {
        throw gqlErr;
      }
    }

    return {
      success: true,
      threadId: validThreadId,
      messageId: validMessageId
    };
  }
}

module.exports = MessagesService;
