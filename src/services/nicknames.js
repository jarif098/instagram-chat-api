'use strict';

const crypto = require('crypto');
const Endpoints = require('../constants/endpoints');
const Conversation = require('../models/conversation');
const { validateThreadId, validateUserId } = require('../utils/validators');
const { ValidationError, InstaChatError } = require('../utils/errors');

const MAX_NICKNAME_LENGTH = 32;

class NicknamesService {
  constructor(options = {}) {
    this.transport = options.transport;
    this.session = options.session;
    this.logger = options.logger;
    this.conversationsService = options.conversationsService || null;
  }

  _getCsrfToken() {
    return this.session && typeof this.session.getCsrfToken === 'function'
      ? this.session.getCsrfToken()
      : '';
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

  async _ensureGraphQLTokens() {
    if (this.conversationsService && typeof this.conversationsService._ensureGraphQLTokens === 'function') {
      return this.conversationsService._ensureGraphQLTokens();
    }
    return {
      dtsg: this.session ? this.session._dtsg : null,
      lsd: this.session ? this.session._lsd : null
    };
  }

  /**
   * Retrieves custom chat nicknames for participants in a conversation thread.
   * Queries modern Web GraphQL (IGDInboxInfoNicknamesDialogQuery) and falls back to thread detail.
   *
   * @param {string} threadId
   * @param {Object} [options]
   * @param {boolean} [options.forceRest=false]
   * @returns {Promise<Object<string, string>>} Map of userId -> nickname
   */
  async getNicknames(threadId, options = {}) {
    const validThreadId = validateThreadId(threadId);
    const currentUserId = this.session ? this.session.userId : null;

    if (!options.forceRest && this.transport && typeof this.transport.post === 'function') {
      try {
        const csrf = this._getCsrfToken();
        const { dtsg, lsd } = await this._ensureGraphQLTokens();

        const payload = new URLSearchParams();
        if (dtsg) payload.append('fb_dtsg', dtsg);
        if (lsd) payload.append('lsd', lsd);
        payload.append('fb_api_caller_class', 'RelayModern');
        payload.append('fb_api_req_friendly_name', 'IGDInboxInfoNicknamesDialogQuery');
        payload.append('server_timestamps', 'true');
        payload.append('doc_id', Endpoints.GRAPHQL_DOCS.NICKNAMES_DIALOG);
        payload.append('variables', JSON.stringify({
          thread_fbid: validThreadId
        }));

        const response = await this.transport.post(Endpoints.GRAPHQL, payload.toString(), {
          headers: {
            'x-csrftoken': csrf,
            'x-fb-friendly-name': 'IGDInboxInfoNicknamesDialogQuery',
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
        });

        const data = response && response.data && response.data.data;
        const rawNode = data && (data.get_slide_thread_nullable || data.xfb_igd_thread_nicknames);
        if (rawNode) {
          const conv = Conversation.fromRaw(rawNode, currentUserId);
          if (conv && conv.nicknames) {
            return conv.nicknames;
          }
        }
      } catch (err) {
        if (this.logger && typeof this.logger.debug === 'function') {
          this.logger.debug(`GraphQL getNicknames failed (${err.message}), falling back to getThread.`);
        }
      }
    }

    if (this.conversationsService && typeof this.conversationsService.getThread === 'function') {
      const { conversation } = await this.conversationsService.getThread(validThreadId, {
        forceRest: Boolean(options.forceRest)
      });
      return (conversation && conversation.nicknames) || {};
    }

    return {};
  }

  /**
   * Sets (or clears when empty string) a custom chat nickname for a participant in a thread.
   *
   * @param {string} threadId
   * @param {string|number} userId
   * @param {string} nickname - Custom nickname up to 32 characters (or '' to clear)
   * @returns {Promise<{success: boolean, threadId: string, userId: string, nickname: string}>}
   */
  async setNickname(threadId, userId, nickname) {
    const validThreadId = validateThreadId(threadId);
    const validUserId = validateUserId(userId);

    if (typeof nickname !== 'string') {
      throw new ValidationError('Nickname must be a string.', { field: 'nickname' });
    }
    const cleanNickname = nickname.trim();
    if (cleanNickname.length > MAX_NICKNAME_LENGTH) {
      throw new ValidationError(`Nickname cannot exceed ${MAX_NICKNAME_LENGTH} characters.`, {
        field: 'nickname'
      });
    }

    const restThreadId = this._resolveRestThreadId(validThreadId);
    const csrf = this._getCsrfToken();

    const payload = new URLSearchParams();
    payload.append('target_user_id', validUserId);
    payload.append('nickname', cleanNickname);
    if (csrf) payload.append('_csrftoken', csrf);
    payload.append('_uuid', crypto.randomUUID());

    const response = await this.transport.post(
      Endpoints.THREAD_SET_NICKNAME(restThreadId),
      payload.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      false
    );

    const data = response.data || {};
    if (data.status && data.status !== 'ok') {
      throw new InstaChatError(data.message || `Failed to set nickname in thread ${validThreadId}`, {
        details: data
      });
    }

    return {
      success: true,
      threadId: validThreadId,
      userId: validUserId,
      nickname: cleanNickname
    };
  }

  /**
   * Clears (resets) a participant's custom nickname in a conversation thread.
   *
   * @param {string} threadId
   * @param {string|number} userId
   * @returns {Promise<{success: boolean, threadId: string, userId: string, nickname: string}>}
   */
  async clearNickname(threadId, userId) {
    return this.setNickname(threadId, userId, '');
  }
}

module.exports = NicknamesService;
