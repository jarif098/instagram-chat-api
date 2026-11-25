'use strict';

const crypto = require('crypto');
const Endpoints = require('../constants/endpoints');
const {
  validateThreadId,
  validateMessageId,
  validateReactionEmoji
} = require('../utils/validators');
const {
  AuthenticationError,
  RateLimitError,
  InstaChatError
} = require('../utils/errors');

class ReactionsService {
  constructor(options = {}) {
    this.transport = options.transport;
    this.session = options.session;
    this.logger = options.logger;
    this.conversationsService = options.conversationsService || null;
  }

  _generateClientContext() {
    return crypto.randomUUID();
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
   * Helper to ensure valid fb_dtsg and lsd tokens for GraphQL operations.
   *
   * @returns {Promise<{dtsg: string|null, lsd: string|null}>}
   * @private
   */
  async _ensureDtsgAndLsd() {
    if (this.conversationsService && typeof this.conversationsService._ensureGraphQLTokens === 'function') {
      return this.conversationsService._ensureGraphQLTokens();
    }

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
   * Adds a reaction (emoji or alias such as "like", "fire", "laugh") to a DM message item
   * using modern Instagram Web GraphQL with direct_v2 REST fallback.
   *
   * @param {string} threadId
   * @param {string} messageId
   * @param {string} [emoji='❤️']
   * @param {Object} [options]
   * @param {boolean} [options.forceRest=false]
   * @returns {Promise<{success: boolean, threadId: string, messageId: string, emoji: string}>}
   */
  async sendReaction(threadId, messageId, emoji = '❤️', options = {}) {
    const validThreadId = validateThreadId(threadId);
    const validMessageId = validateMessageId(messageId);
    const cleanEmoji = validateReactionEmoji(emoji);

    const csrfToken = this.session && typeof this.session.getCsrfToken === 'function'
      ? this.session.getCsrfToken()
      : '';

    let gqlError = null;

    // 1. Primary: Modern Instagram Web GraphQL Mutation (IGDirectReactionSendMutation)
    if (!options.forceRest) {
      const { dtsg, lsd } = await this._ensureDtsgAndLsd();
      try {
        const payload = new URLSearchParams();
        payload.append('__a', '1');
        payload.append('__d', 'www');
        payload.append('__comet_req', '7');
        if (dtsg) payload.append('fb_dtsg', dtsg);
        if (lsd) payload.append('lsd', lsd);
        payload.append('fb_api_caller_class', 'RelayModern');
        payload.append('fb_api_req_friendly_name', 'IGDirectReactionSendMutation');
        payload.append('server_timestamps', 'true');
        payload.append('doc_id', Endpoints.GRAPHQL_DOCS.REACTION);
        payload.append('variables', JSON.stringify({
          input: {
            emoji: cleanEmoji,
            item_id: '',
            message_id: validMessageId,
            reaction_status: 'created',
            thread_id: validThreadId
          }
        }));

        const response = await this.transport.post(
          Endpoints.GRAPHQL,
          payload.toString(),
          {
            headers: {
              'x-csrftoken': csrfToken,
              'x-fb-friendly-name': 'IGDirectReactionSendMutation',
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
          throw new InstaChatError(respData.errors[0].message || 'GraphQL reaction mutation error', {
            details: respData.errors
          });
        }

        if (respData && respData.data && respData.data.xig_direct_reaction_send_with_slide_messaging_response) {
          return {
            success: true,
            threadId: validThreadId,
            messageId: validMessageId,
            emoji: cleanEmoji
          };
        }

        if (respData && !respData.errors && respData.data) {
          return {
            success: true,
            threadId: validThreadId,
            messageId: validMessageId,
            emoji: cleanEmoji
          };
        }
      } catch (err) {
        if (err instanceof AuthenticationError || err instanceof RateLimitError || err instanceof InstaChatError) {
          throw err;
        }
        gqlError = err;
        if (this.logger && typeof this.logger.debug === 'function') {
          this.logger.debug(`GraphQL sendReaction failed (${err.message}), trying REST fallback.`);
        }
      }
    }

    // 2. Fallback: Legacy direct_v2 REST broadcast route
    const restThreadId = this._resolveRestThreadId(validThreadId);
    const clientContext = this._generateClientContext();
    const legacyPayload = new URLSearchParams();
    legacyPayload.append('action', 'send_item');
    legacyPayload.append('thread_ids', JSON.stringify([restThreadId]));
    legacyPayload.append('item_id', validMessageId);
    legacyPayload.append('reaction_type', cleanEmoji === '❤️' ? 'like' : 'emoji');
    legacyPayload.append('reaction_status', 'created');
    legacyPayload.append('emoji', cleanEmoji);
    legacyPayload.append('reaction_emoji', cleanEmoji);
    legacyPayload.append('node_type', 'item');
    legacyPayload.append('client_context', clientContext);
    if (csrfToken) legacyPayload.append('_csrftoken', csrfToken);

    try {
      const legacyRes = await this.transport.post(
        Endpoints.BROADCAST_REACTION,
        legacyPayload.toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
        false
      );

      const legacyData = (legacyRes && legacyRes.data) || {};
      if (legacyData.status && legacyData.status !== 'ok') {
        throw new InstaChatError(legacyData.message || 'Failed to send message reaction', {
          details: legacyData
        });
      }

      return {
        success: true,
        threadId: validThreadId,
        messageId: validMessageId,
        emoji: cleanEmoji
      };
    } catch (legacyErr) {
      if (legacyErr instanceof InstaChatError) throw legacyErr;
      throw gqlError || legacyErr;
    }
  }

  /**
   * Shorthand alias for sendReaction().
   */
  async react(threadId, messageId, emoji = '❤️', options = {}) {
    return this.sendReaction(threadId, messageId, emoji, options);
  }

  /**
   * Removes a reaction from a DM message item using modern Instagram Web GraphQL with REST fallback.
   *
   * @param {string} threadId
   * @param {string} messageId
   * @param {string} [emoji='❤️']
   * @param {Object} [options]
   * @param {boolean} [options.forceRest=false]
   * @returns {Promise<{success: boolean, threadId: string, messageId: string, emoji: string}>}
   */
  async deleteReaction(threadId, messageId, emoji = '❤️', options = {}) {
    const validThreadId = validateThreadId(threadId);
    const validMessageId = validateMessageId(messageId);
    const cleanEmoji = validateReactionEmoji(emoji || '❤️');

    const csrfToken = this.session && typeof this.session.getCsrfToken === 'function'
      ? this.session.getCsrfToken()
      : '';

    let gqlError = null;

    // 1. Primary: Modern Instagram Web GraphQL Mutation
    if (!options.forceRest) {
      const { dtsg, lsd } = await this._ensureDtsgAndLsd();
      try {
        const payload = new URLSearchParams();
        payload.append('__a', '1');
        payload.append('__d', 'www');
        payload.append('__comet_req', '7');
        if (dtsg) payload.append('fb_dtsg', dtsg);
        if (lsd) payload.append('lsd', lsd);
        payload.append('fb_api_caller_class', 'RelayModern');
        payload.append('fb_api_req_friendly_name', 'IGDirectReactionSendMutation');
        payload.append('server_timestamps', 'true');
        payload.append('doc_id', Endpoints.GRAPHQL_DOCS.REACTION);
        payload.append('variables', JSON.stringify({
          input: {
            emoji: cleanEmoji,
            item_id: '',
            message_id: validMessageId,
            reaction_status: 'deleted',
            thread_id: validThreadId
          }
        }));

        const response = await this.transport.post(
          Endpoints.GRAPHQL,
          payload.toString(),
          {
            headers: {
              'x-csrftoken': csrfToken,
              'x-fb-friendly-name': 'IGDirectReactionSendMutation',
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
          throw new InstaChatError(respData.errors[0].message || 'GraphQL delete reaction error', {
            details: respData.errors
          });
        }

        if (respData && respData.data) {
          return {
            success: true,
            threadId: validThreadId,
            messageId: validMessageId,
            emoji: cleanEmoji
          };
        }
      } catch (err) {
        if (err instanceof AuthenticationError || err instanceof RateLimitError || err instanceof InstaChatError) {
          throw err;
        }
        gqlError = err;
        if (this.logger && typeof this.logger.debug === 'function') {
          this.logger.debug(`GraphQL deleteReaction failed (${err.message}), trying REST fallback.`);
        }
      }
    }

    // 2. Fallback: Legacy direct_v2 REST broadcast reaction delete
    const restThreadId = this._resolveRestThreadId(validThreadId);
    const clientContext = this._generateClientContext();
    const legacyPayload = new URLSearchParams();
    legacyPayload.append('action', 'send_item');
    legacyPayload.append('thread_ids', JSON.stringify([restThreadId]));
    legacyPayload.append('item_id', validMessageId);
    legacyPayload.append('reaction_type', cleanEmoji === '❤️' ? 'like' : 'emoji');
    legacyPayload.append('reaction_status', 'deleted');
    legacyPayload.append('emoji', cleanEmoji);
    legacyPayload.append('reaction_emoji', cleanEmoji);
    legacyPayload.append('node_type', 'item');
    legacyPayload.append('client_context', clientContext);
    if (csrfToken) legacyPayload.append('_csrftoken', csrfToken);

    try {
      const legacyRes = await this.transport.post(
        Endpoints.BROADCAST_REACTION,
        legacyPayload.toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
        false
      );

      const legacyData = (legacyRes && legacyRes.data) || {};
      if (legacyData.status && legacyData.status !== 'ok') {
        throw new InstaChatError(legacyData.message || 'Failed to remove message reaction', {
          details: legacyData
        });
      }

      return {
        success: true,
        threadId: validThreadId,
        messageId: validMessageId,
        emoji: cleanEmoji
      };
    } catch (legacyErr) {
      if (legacyErr instanceof InstaChatError) throw legacyErr;
      throw gqlError || legacyErr;
    }
  }

  /**
   * Shorthand alias for deleteReaction().
   */
  async unreact(threadId, messageId, emoji = '❤️', options = {}) {
    return this.deleteReaction(threadId, messageId, emoji, options);
  }
}

module.exports = ReactionsService;
