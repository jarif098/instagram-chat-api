'use strict';

const crypto = require('crypto');
const Endpoints = require('../constants/endpoints');
const { validateThreadId, validateMessageId } = require('../utils/validators');
const { ValidationError, InstaChatError } = require('../utils/errors');

class ReactionsService {
  constructor(options = {}) {
    this.transport = options.transport;
    this.session = options.session;
    this.logger = options.logger;
  }

  _generateClientContext() {
    return crypto.randomUUID();
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

    if (!dtsg || !lsd) {
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
   * Adds a reaction (emoji or like) to a message item in a thread using modern Instagram Web GraphQL.
   *
   * @param {string} threadId
   * @param {string} messageId
   * @param {string} [emoji='❤️']
   * @returns {Promise<{success: boolean, threadId: string, messageId: string, emoji: string}>}
   */
  async sendReaction(threadId, messageId, emoji = '❤️') {
    const validThreadId = validateThreadId(threadId);
    const validMessageId = validateMessageId(messageId);

    if (typeof emoji !== 'string' || !emoji.trim()) {
      throw new ValidationError('Emoji reaction must be a non-empty string');
    }

    const cleanEmoji = emoji.trim() === 'like' ? '❤️' : emoji.trim();
    const csrfToken = this.session ? this.session.getCsrfToken() : '';
    const { dtsg, lsd } = await this._ensureDtsgAndLsd();

    // 1. Primary: Modern Instagram Web GraphQL Mutation (IGDirectReactionSendMutation)
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
      if (respData && respData.data && respData.data.xig_direct_reaction_send_with_slide_messaging_response) {
        return {
          success: true,
          threadId: validThreadId,
          messageId: validMessageId,
          emoji: cleanEmoji
        };
      }

      if (respData && respData.errors && respData.errors.length > 0) {
        throw new InstaChatError(respData.errors[0].message || 'GraphQL reaction mutation error', {
          details: respData.errors
        });
      }
    } catch (gqlErr) {
      if (gqlErr instanceof InstaChatError) {
        throw gqlErr;
      }

      // 2. Fallback: Legacy mobile REST broadcast route
      try {
        const clientContext = this._generateClientContext();
        const legacyPayload = new URLSearchParams();
        legacyPayload.append('action', 'send_item');
        legacyPayload.append('thread_ids', JSON.stringify([validThreadId]));
        legacyPayload.append('item_id', validMessageId);
        legacyPayload.append('reaction_type', cleanEmoji === '❤️' ? 'like' : 'emoji');
        legacyPayload.append('reaction_emoji', cleanEmoji);
        legacyPayload.append('node_type', 'reaction');
        legacyPayload.append('client_context', clientContext);
        legacyPayload.append('_csrftoken', csrfToken);

        const legacyRes = await this.transport.post(
          Endpoints.BROADCAST_REACTION,
          legacyPayload.toString(),
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
          false
        );

        if (legacyRes?.data?.status === 'ok') {
          return {
            success: true,
            threadId: validThreadId,
            messageId: validMessageId,
            emoji: cleanEmoji
          };
        }
      } catch (legacyErr) {
        throw gqlErr;
      }
    }

    return {
      success: true,
      threadId: validThreadId,
      messageId: validMessageId,
      emoji: cleanEmoji
    };
  }

  /**
   * Removes a reaction from a message using modern Instagram Web GraphQL.
   *
   * @param {string} threadId
   * @param {string} messageId
   * @param {string} [emoji='❤️']
   * @returns {Promise<{success: boolean, threadId: string, messageId: string}>}
   */
  async deleteReaction(threadId, messageId, emoji = '❤️') {
    const validThreadId = validateThreadId(threadId);
    const validMessageId = validateMessageId(messageId);
    const cleanEmoji = typeof emoji === 'string' && emoji.trim() ? emoji.trim() : '❤️';

    const csrfToken = this.session ? this.session.getCsrfToken() : '';
    const { dtsg, lsd } = await this._ensureDtsgAndLsd();

    // 1. Primary: Modern Instagram Web GraphQL Mutation
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
      if (respData && respData.data && respData.data.xig_direct_reaction_send_with_slide_messaging_response) {
        return {
          success: true,
          threadId: validThreadId,
          messageId: validMessageId
        };
      }
    } catch (gqlErr) {
      if (gqlErr instanceof InstaChatError) {
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

module.exports = ReactionsService;
