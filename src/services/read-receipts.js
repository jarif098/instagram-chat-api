'use strict';

const Endpoints = require('../constants/endpoints');
const { validateThreadId, validateMessageId } = require('../utils/validators');
const { InstaChatError } = require('../utils/errors');

class ReadReceiptsService {
  constructor(options = {}) {
    this.transport = options.transport;
    this.session = options.session;
    this.logger = options.logger;
    this.conversationsService = options.conversationsService || null;
  }

  _resolveThreadIgid(threadId) {
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
    if (this.session && this.session._dtsg && this.session._lsd) {
      return { dtsg: this.session._dtsg, lsd: this.session._lsd };
    }
    if (this.transport && typeof this.transport.get === 'function') {
      try {
        const res = await this.transport.get(`${Endpoints.BASE_URL}/direct/inbox/`, {
          validateStatus: (s) => s < 400
        });
        const html = typeof res?.data === 'string' ? res.data : '';
        const dtsgMatches = Array.from(html.matchAll(/"(NAf[^"]+)"/g)).map((m) => m[1]);
        const lsdMatches = Array.from(html.matchAll(/"LSD",\[\],\{"token":"([^"]+)"/g)).map((m) => m[1]);
        const dtsg = dtsgMatches[0] || null;
        const lsd = lsdMatches[0] || null;
        if (this.session) {
          if (dtsg) this.session._dtsg = dtsg;
          if (lsd) this.session._lsd = lsd;
        }
        return { dtsg, lsd };
      } catch (e) {}
    }
    return {
      dtsg: this.session ? this.session._dtsg : null,
      lsd: this.session ? this.session._lsd : null
    };
  }

  /**
   * Marks a specific message and thread as seen (read receipt).
   * Attempts modern Instagram Web GraphQL (useIGDMarkThreadAsReadMutation) first and
   * falls back cleanly to legacy direct_v2/threads/{id}/items/{itemId}/seen/.
   *
   * @param {string} threadId
   * @param {string} messageId
   * @param {Object} [options]
   * @param {boolean} [options.forceRest=false]
   * @returns {Promise<{success: boolean, threadId: string, messageId: string, watermarkTimestampMs?: string|null}>}
   */
  async markSeen(threadId, messageId, options = {}) {
    const validThreadId = validateThreadId(threadId);
    const validMessageId = validateMessageId(messageId);
    const csrfToken = this.session && typeof this.session.getCsrfToken === 'function'
      ? this.session.getCsrfToken()
      : '';
    const threadIgid = this._resolveThreadIgid(validThreadId);

    if (!options.forceRest && this.transport && typeof this.transport.post === 'function') {
      try {
        const { dtsg, lsd } = await this._ensureGraphQLTokens();
        const gqlPayload = new URLSearchParams();
        if (dtsg) gqlPayload.append('fb_dtsg', dtsg);
        if (lsd) gqlPayload.append('lsd', lsd);
        gqlPayload.append('fb_api_caller_class', 'RelayModern');
        gqlPayload.append('fb_api_req_friendly_name', 'useIGDMarkThreadAsReadMutation');
        gqlPayload.append('server_timestamps', 'true');
        gqlPayload.append('doc_id', Endpoints.GRAPHQL_DOCS.MARK_READ);
        gqlPayload.append('variables', JSON.stringify({
          data: {
            item_id: '',
            message_id: validMessageId
          },
          metadata: {
            ig_thread_igid: threadIgid
          }
        }));

        const gqlResponse = await this.transport.post(
          Endpoints.GRAPHQL,
          gqlPayload.toString(),
          {
            headers: {
              'x-csrftoken': csrfToken,
              'x-fb-friendly-name': 'useIGDMarkThreadAsReadMutation',
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

        const respData = gqlResponse && gqlResponse.data;
        if (respData && respData.errors && respData.errors.length > 0) {
          throw new InstaChatError(respData.errors[0].message || 'GraphQL markSeen mutation failed', {
            details: respData.errors
          });
        }

        const seenNode = respData && respData.data && respData.data.xig_direct_item_seen_mutation_with_slide_messaging_response;
        if (seenNode) {
          return {
            success: true,
            threadId: validThreadId,
            messageId: validMessageId,
            watermarkTimestampMs: seenNode.watermark_timestamp_ms ? String(seenNode.watermark_timestamp_ms) : null
          };
        }
      } catch (err) {
        if (err instanceof InstaChatError) throw err;
        if (this.logger && typeof this.logger.debug === 'function') {
          this.logger.debug(`GraphQL markSeen bypassed (${err.message}), falling back to REST seen.`);
        }
      }
    }

    const payload = new URLSearchParams();
    payload.append('_csrftoken', csrfToken);
    payload.append('use_unified_inbox', 'true');

    const response = await this.transport.post(
      Endpoints.SEEN_MESSAGE(threadIgid, validMessageId),
      payload.toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      },
      false
    );

    const data = response.data || {};
    if (data.status !== 'ok') {
      throw new InstaChatError(data.message || 'Failed to mark message as seen', {
        details: data
      });
    }

    return {
      success: true,
      threadId: validThreadId,
      messageId: validMessageId
    };
  }

  /**
   * Sends typing indicator status to a conversation thread.
   *
   * @param {string} threadId
   * @param {boolean} [isTyping=true]
   * @returns {Promise<{success: boolean, threadId: string, isTyping: boolean}>}
   */
  async sendTypingIndicator(threadId, isTyping = true) {
    const validThreadId = validateThreadId(threadId);
    const threadIgid = this._resolveThreadIgid(validThreadId);
    const csrfToken = this.session && typeof this.session.getCsrfToken === 'function'
      ? this.session.getCsrfToken()
      : '';

    const payload = new URLSearchParams();
    payload.append('activity_status', isTyping ? '1' : '0');
    payload.append('_csrftoken', csrfToken);

    const response = await this.transport.post(
      Endpoints.ACTIVITY_STATUS(threadIgid),
      payload.toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      },
      false
    );

    const data = response.data || {};
    if (data.status !== 'ok') {
      throw new InstaChatError(data.message || 'Failed to send typing indicator status', {
        details: data
      });
    }

    return {
      success: true,
      threadId: validThreadId,
      isTyping: Boolean(isTyping)
    };
  }
}

module.exports = ReadReceiptsService;
