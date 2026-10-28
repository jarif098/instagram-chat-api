'use strict';

const crypto = require('crypto');
const Endpoints = require('../constants/endpoints');
const Message = require('../models/message');
const {
  validateThreadId,
  validateUserId,
  validateSearchQuery
} = require('../utils/validators');
const { ValidationError, InstaChatError } = require('../utils/errors');

const IG_SHORTCODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * Converts an Instagram post/reel shortcode (e.g. "DBxYz123AbC") or permalink URL
 * into its underlying 64-bit numeric Instagram media ID string.
 *
 * @param {string|number} mediaIdOrUrl
 * @returns {string}
 */
function resolveMediaId(mediaIdOrUrl) {
  if (mediaIdOrUrl === undefined || mediaIdOrUrl === null) {
    throw new ValidationError('Media ID, shortcode, or Instagram URL is required.', {
      field: 'mediaId'
    });
  }

  const raw = String(mediaIdOrUrl).trim();
  if (!raw) {
    throw new ValidationError('Media ID, shortcode, or Instagram URL cannot be empty.', {
      field: 'mediaId'
    });
  }

  // Already numeric media PK or composite {mediaPk}_{ownerPk}
  if (/^\d+(?:_\d+)?$/.test(raw)) {
    return raw.split('_')[0];
  }

  // Extract shortcode from URL if needed: /p/{code}/, /reel/{code}/, /reels/{code}/, /tv/{code}/
  let shortcode = raw;
  const urlMatch = raw.match(/instagram\.com\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
  if (urlMatch && urlMatch[1]) {
    shortcode = urlMatch[1];
  }

  if (!/^[A-Za-z0-9_-]{5,24}$/.test(shortcode)) {
    throw new ValidationError(`Invalid Instagram media ID, shortcode, or URL: "${raw}".`, {
      field: 'mediaId'
    });
  }

  // Decode base64 shortcode -> 64-bit BigInt media ID (use first 11 chars before private share suffix)
  const coreCode = shortcode.slice(0, 11);
  let id = 0n;
  for (let i = 0; i < coreCode.length; i++) {
    const idx = IG_SHORTCODE_ALPHABET.indexOf(coreCode[i]);
    if (idx === -1) {
      throw new ValidationError(`Invalid character in Instagram shortcode: "${shortcode}".`, {
        field: 'mediaId'
      });
    }
    id = id * 64n + BigInt(idx);
  }

  return id.toString();
}

class SharingService {
  constructor(options = {}) {
    this.transport = options.transport;
    this.session = options.session;
    this.logger = options.logger;
    this.conversationsService = options.conversationsService || null;
    this.usersService = options.usersService || null;
  }

  _getCsrfToken() {
    return this.session && typeof this.session.getCsrfToken === 'function'
      ? this.session.getCsrfToken()
      : '';
  }

  _generateOfflineId() {
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

  async _ensureGraphQLTokens() {
    if (this.conversationsService && typeof this.conversationsService._ensureGraphQLTokens === 'function') {
      return this.conversationsService._ensureGraphQLTokens();
    }
    if (this.session && this.session._dtsg && this.session._lsd) {
      return { dtsg: this.session._dtsg, lsd: this.session._lsd };
    }
    return {
      dtsg: this.session ? this.session._dtsg : null,
      lsd: this.session ? this.session._lsd : null
    };
  }

  async _postGraphQL(friendlyName, docId, variables, refererThreadId) {
    const csrf = this._getCsrfToken();
    const { dtsg, lsd } = await this._ensureGraphQLTokens();

    const payload = new URLSearchParams();
    if (dtsg) payload.append('fb_dtsg', dtsg);
    if (lsd) payload.append('lsd', lsd);
    payload.append('fb_api_caller_class', 'RelayModern');
    payload.append('fb_api_req_friendly_name', friendlyName);
    payload.append('server_timestamps', 'true');
    payload.append('doc_id', docId);
    payload.append('variables', JSON.stringify(variables));

    const response = await this.transport.post(
      Endpoints.GRAPHQL,
      payload.toString(),
      {
        headers: {
          'x-csrftoken': csrf,
          'x-fb-friendly-name': friendlyName,
          'x-ig-app-id': Endpoints.WEB_APP_ID,
          'x-asbd-id': Endpoints.ASBD_ID,
          'x-fb-lsd': lsd || '0l2qtDa0grAFC5qqeoHlvO',
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: Endpoints.BASE_URL,
          Referer: refererThreadId
            ? `${Endpoints.BASE_URL}/direct/t/${refererThreadId}/`
            : `${Endpoints.BASE_URL}/direct/inbox/`,
          'sec-fetch-dest': 'empty',
          'sec-fetch-mode': 'cors',
          'sec-fetch-site': 'same-origin'
        }
      },
      false
    );

    const respData = response && response.data;
    if (respData && respData.errors && respData.errors.length > 0) {
      throw new InstaChatError(respData.errors[0].message || `GraphQL ${friendlyName} failed`, {
        details: respData.errors
      });
    }

    return respData && respData.data ? respData.data : null;
  }

  /**
   * Searches GIPHY animated GIFs / stickers via Instagram Direct's built-in search endpoint.
   *
   * @param {string} query
   * @param {Object} [options]
   * @param {boolean} [options.isSticker=false]
   * @param {number} [options.limit=15]
   * @returns {Promise<Array<{id: string, title: string, isSticker: boolean, url: string|null, mp4Url: string|null, webpUrl: string|null, width: number|null, height: number|null}>>}
   */
  async searchGifs(query, options = {}) {
    const validQuery = validateSearchQuery(query);
    const isSticker = Boolean(options.isSticker);
    const limit = Math.min(Math.max(Number(options.limit) || 15, 1), 50);

    const response = await this.transport.get(Endpoints.GIPHY_DIRECT_SEARCH, {
      params: {
        q: validQuery,
        request_type: isSticker ? 'sticker' : 'gif',
        count: limit
      }
    });

    const data = response.data || {};
    const rawList =
      (data.results && (data.results.giphy || data.results.giphy_stickers || data.results)) ||
      data.giphy_gifs ||
      data.items ||
      [];

    if (!Array.isArray(rawList)) return [];

    return rawList
      .filter((item) => item && item.id)
      .slice(0, limit)
      .map((item) => {
        const fixed = (item.images && item.images.fixed_height) || item;
        return {
          id: String(item.id),
          title: item.title || '',
          isSticker: Boolean(item.is_sticker ?? isSticker),
          url: fixed.url || null,
          mp4Url: fixed.mp4 || null,
          webpUrl: fixed.webp || null,
          width: fixed.width ? Number(fixed.width) : null,
          height: fixed.height ? Number(fixed.height) : null
        };
      });
  }

  /**
   * Sends an animated GIPHY GIF (by GIPHY ID or search query) to a conversation thread.
   * Uses IGDirectAnimatedMediaSendMutation with REST fallback.
   *
   * @param {string} threadId
   * @param {string} gifIdOrQuery - GIPHY media ID (or search phrase when options.search=true)
   * @param {Object} [options]
   * @param {boolean} [options.search=false] - Treat second argument as a search query and send top result
   * @param {boolean} [options.isSticker=false]
   * @param {boolean} [options.isRandom=false]
   * @param {string} [options.replyToItemId]
   * @param {boolean} [options.forceRest=false]
   * @returns {Promise<Message>}
   */
  async sendGif(threadId, gifIdOrQuery, options = {}) {
    const validThreadId = validateThreadId(threadId);
    if (typeof gifIdOrQuery !== 'string' || !gifIdOrQuery.trim()) {
      throw new ValidationError('gifIdOrQuery must be a non-empty string.', { field: 'gifIdOrQuery' });
    }

    let gifId = gifIdOrQuery.trim();
    if (options.search || /\s/.test(gifId)) {
      const results = await this.searchGifs(gifId, { isSticker: options.isSticker, limit: 5 });
      if (!results.length) {
        throw new InstaChatError(`No GIFs found matching query "${gifId}".`);
      }
      gifId = results[0].id;
    }

    const currentUserId = this.session ? this.session.userId : null;
    const isSticker = Boolean(options.isSticker);

    if (!options.forceRest) {
      try {
        const offlineId = this._generateOfflineId();
        const gqlData = await this._postGraphQL(
          'IGDirectAnimatedMediaSendMutation',
          Endpoints.GRAPHQL_DOCS.SEND_GIF,
          {
            data: {
              id: gifId,
              is_random: Boolean(options.isRandom),
              is_sticker: isSticker
            },
            send_data: {
              offline_threading_id: offlineId,
              recipient_users: null,
              reply_to_message_id: options.replyToItemId || null,
              thread_id: validThreadId
            }
          },
          validThreadId
        );

        const node = gqlData && gqlData.direct_animated_media_send;
        if (node) {
          return Message.fromRaw({
            item_id: node.message_id || node.id || offlineId,
            thread_id: validThreadId,
            user_id: currentUserId,
            timestamp: Date.now() * 1000,
            item_type: 'animated_media',
            animated_media: { id: gifId, is_sticker: isSticker }
          }, currentUserId);
        }
      } catch (err) {
        if (err instanceof InstaChatError) throw err;
        if (this.logger && typeof this.logger.debug === 'function') {
          this.logger.debug(`GraphQL sendGif failed (${err.message}), trying REST animated_media.`);
        }
      }
    }

    const restThreadId = this._resolveRestThreadId(validThreadId);
    const clientContext = crypto.randomUUID();
    const csrf = this._getCsrfToken();

    const payload = new URLSearchParams();
    payload.append('action', 'send_item');
    payload.append('thread_ids', JSON.stringify([restThreadId]));
    payload.append('id', gifId);
    payload.append('is_sticker', isSticker ? 'true' : 'false');
    payload.append('client_context', clientContext);
    if (csrf) payload.append('_csrftoken', csrf);
    payload.append('_uuid', clientContext);

    const response = await this.transport.post(
      Endpoints.BROADCAST_ANIMATED_MEDIA,
      payload.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      false
    );

    const data = response.data || {};
    if (data.status && data.status !== 'ok') {
      throw new InstaChatError(data.message || 'Failed to send GIF', { details: data });
    }

    return Message.fromRaw({
      item_id: data.item_id || (data.payload && data.payload.item_id) || clientContext,
      thread_id: validThreadId,
      user_id: currentUserId,
      timestamp: data.timestamp || Date.now() * 1000,
      item_type: 'animated_media',
      animated_media: { id: gifId, is_sticker: isSticker }
    }, currentUserId);
  }

  /**
   * Sends a first-party store sticker to a conversation thread.
   * Uses IGDirectStoreStickerSendMutation with REST fallback.
   *
   * @param {string} threadId
   * @param {string|number} stickerId
   * @param {Object} [options]
   * @param {string} [options.replyToItemId]
   * @param {boolean} [options.forceRest=false]
   * @returns {Promise<Message>}
   */
  async sendSticker(threadId, stickerId, options = {}) {
    const validThreadId = validateThreadId(threadId);
    if (stickerId === undefined || stickerId === null || !String(stickerId).trim()) {
      throw new ValidationError('stickerId must be a non-empty string or number.', { field: 'stickerId' });
    }
    const cleanStickerId = String(stickerId).trim();
    const currentUserId = this.session ? this.session.userId : null;

    if (!options.forceRest) {
      try {
        const offlineId = this._generateOfflineId();
        const gqlData = await this._postGraphQL(
          'IGDirectStoreStickerSendMutation',
          Endpoints.GRAPHQL_DOCS.SEND_STICKER,
          {
            data: {
              sticker_id: cleanStickerId
            },
            send_data: {
              offline_threading_id: offlineId,
              recipient_users: null,
              reply_to_message_id: options.replyToItemId || null,
              thread_id: validThreadId
            }
          },
          validThreadId
        );

        const node = gqlData && gqlData.direct_store_sticker_send_with_slide_response;
        if (node) {
          return Message.fromRaw({
            item_id: node.message_id || node.id || offlineId,
            thread_id: validThreadId,
            user_id: currentUserId,
            timestamp: Number(node.timestamp_ms || Date.now()) * 1000,
            item_type: 'store_sticker',
            store_sticker: { sticker_id: cleanStickerId }
          }, currentUserId);
        }
      } catch (err) {
        if (err instanceof InstaChatError) throw err;
        if (this.logger && typeof this.logger.debug === 'function') {
          this.logger.debug(`GraphQL sendSticker failed (${err.message}), trying REST static_stickers.`);
        }
      }
    }

    const restThreadId = this._resolveRestThreadId(validThreadId);
    const clientContext = crypto.randomUUID();
    const csrf = this._getCsrfToken();

    const payload = new URLSearchParams();
    payload.append('action', 'send_item');
    payload.append('thread_ids', JSON.stringify([restThreadId]));
    payload.append('sticker_id', cleanStickerId);
    payload.append('client_context', clientContext);
    if (csrf) payload.append('_csrftoken', csrf);
    payload.append('_uuid', clientContext);

    const response = await this.transport.post(
      Endpoints.BROADCAST_STICKER,
      payload.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      false
    );

    const data = response.data || {};
    if (data.status && data.status !== 'ok') {
      throw new InstaChatError(data.message || 'Failed to send sticker', { details: data });
    }

    return Message.fromRaw({
      item_id: data.item_id || (data.payload && data.payload.item_id) || clientContext,
      thread_id: validThreadId,
      user_id: currentUserId,
      timestamp: data.timestamp || Date.now() * 1000,
      item_type: 'store_sticker',
      store_sticker: { sticker_id: cleanStickerId }
    }, currentUserId);
  }

  /**
   * Shares a web link with rich preview card inside a conversation thread.
   * Uses IGDirectLinkShareMutation with REST fallback.
   *
   * @param {string} threadId
   * @param {string} textOrUrl - URL or message text containing at least one http(s) URL
   * @param {Object} [options]
   * @param {string[]} [options.urls] - Explicit URL list override
   * @param {string} [options.replyToItemId]
   * @param {boolean} [options.forceRest=false]
   * @returns {Promise<Message>}
   */
  async sendLink(threadId, textOrUrl, options = {}) {
    const validThreadId = validateThreadId(threadId);
    if (typeof textOrUrl !== 'string' || !textOrUrl.trim()) {
      throw new ValidationError('textOrUrl must be a non-empty string containing a valid URL.', {
        field: 'textOrUrl'
      });
    }

    const linkText = textOrUrl.trim();
    const extractedUrls = Array.isArray(options.urls) && options.urls.length > 0
      ? options.urls.map(String)
      : Array.from(linkText.matchAll(/https?:\/\/[^\s<>"]+/gi)).map((m) => m[0]);

    if (extractedUrls.length === 0) {
      throw new ValidationError('At least one valid http:// or https:// URL must be present in textOrUrl.', {
        field: 'textOrUrl'
      });
    }

    const currentUserId = this.session ? this.session.userId : null;

    if (!options.forceRest) {
      try {
        const offlineId = this._generateOfflineId();
        const gqlData = await this._postGraphQL(
          'IGDirectLinkShareMutation',
          Endpoints.GRAPHQL_DOCS.SHARE_LINK,
          {
            data: {
              link_text: linkText,
              link_urls: JSON.stringify(extractedUrls)
            },
            send_data: {
              offline_threading_id: offlineId,
              recipient_users: null,
              reply_to_message_id: options.replyToItemId || null,
              thread_id: validThreadId
            }
          },
          validThreadId
        );

        const node = gqlData && gqlData.direct_link_share_with_slide_response;
        if (node) {
          return Message.fromRaw({
            item_id: node.message_id || node.id || offlineId,
            thread_id: validThreadId,
            user_id: currentUserId,
            timestamp: Number(node.timestamp_ms || Date.now()) * 1000,
            item_type: 'link',
            link: {
              text: linkText,
              link_context: { link_url: extractedUrls[0] }
            }
          }, currentUserId);
        }
      } catch (err) {
        if (err instanceof InstaChatError) throw err;
        if (this.logger && typeof this.logger.debug === 'function') {
          this.logger.debug(`GraphQL sendLink failed (${err.message}), trying REST broadcast/link.`);
        }
      }
    }

    const restThreadId = this._resolveRestThreadId(validThreadId);
    const clientContext = crypto.randomUUID();
    const csrf = this._getCsrfToken();

    const payload = new URLSearchParams();
    payload.append('action', 'send_item');
    payload.append('thread_ids', JSON.stringify([restThreadId]));
    payload.append('link_text', linkText);
    payload.append('link_urls', JSON.stringify(extractedUrls));
    payload.append('client_context', clientContext);
    if (csrf) payload.append('_csrftoken', csrf);
    payload.append('_uuid', clientContext);

    const response = await this.transport.post(
      Endpoints.BROADCAST_LINK,
      payload.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      false
    );

    const data = response.data || {};
    if (data.status && data.status !== 'ok') {
      throw new InstaChatError(data.message || 'Failed to share link', { details: data });
    }

    return Message.fromRaw({
      item_id: data.item_id || (data.payload && data.payload.item_id) || clientContext,
      thread_id: validThreadId,
      user_id: currentUserId,
      timestamp: data.timestamp || Date.now() * 1000,
      item_type: 'link',
      link: {
        text: linkText,
        link_context: { link_url: extractedUrls[0] }
      }
    }, currentUserId);
  }

  /**
   * Shares an Instagram feed post natively into a DM thread (by numeric mediaId, shortcode, or post URL).
   * Uses IGDirectMediaShareMutation with REST fallback.
   *
   * @param {string} threadId
   * @param {string|number} mediaIdOrUrl - Numeric media ID, shortcode, or https://www.instagram.com/p/... URL
   * @param {Object} [options]
   * @param {string} [options.text] - Optional accompanying message text
   * @param {boolean} [options.forceRest=false]
   * @returns {Promise<Message>}
   */
  async sharePost(threadId, mediaIdOrUrl, options = {}) {
    const validThreadId = validateThreadId(threadId);
    const mediaId = resolveMediaId(mediaIdOrUrl);
    const currentUserId = this.session ? this.session.userId : null;

    if (!options.forceRest) {
      try {
        const offlineId = this._generateOfflineId();
        const gqlData = await this._postGraphQL(
          'IGDirectMediaShareMutation',
          Endpoints.GRAPHQL_DOCS.SHARE_MEDIA,
          {
            data: {
              media_id: mediaId
            },
            send_data: {
              forwarded_from_thread_id: null,
              is_forwarded_from_own_message: null,
              offline_threading_id: offlineId,
              recipient_users: null,
              thread_id: validThreadId
            }
          },
          validThreadId
        );

        const node = gqlData && gqlData.direct_media_share_with_slide_response;
        if (node) {
          return Message.fromRaw({
            item_id: node.message_id || node.id || offlineId,
            thread_id: validThreadId,
            user_id: currentUserId,
            timestamp: Number(node.timestamp_ms || Date.now()) * 1000,
            item_type: 'media_share',
            media_share: { pk: mediaId }
          }, currentUserId);
        }
      } catch (err) {
        if (err instanceof InstaChatError) throw err;
        if (this.logger && typeof this.logger.debug === 'function') {
          this.logger.debug(`GraphQL sharePost failed (${err.message}), trying REST media_share.`);
        }
      }
    }

    const restThreadId = this._resolveRestThreadId(validThreadId);
    const clientContext = crypto.randomUUID();
    const csrf = this._getCsrfToken();

    const payload = new URLSearchParams();
    payload.append('action', 'send_item');
    payload.append('thread_ids', JSON.stringify([restThreadId]));
    payload.append('media_id', mediaId);
    if (options.text) payload.append('text', String(options.text));
    payload.append('client_context', clientContext);
    if (csrf) payload.append('_csrftoken', csrf);
    payload.append('_uuid', clientContext);

    const response = await this.transport.post(
      Endpoints.BROADCAST_MEDIA_SHARE,
      payload.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      false
    );

    const data = response.data || {};
    if (data.status && data.status !== 'ok') {
      throw new InstaChatError(data.message || 'Failed to share post', { details: data });
    }

    return Message.fromRaw({
      item_id: data.item_id || (data.payload && data.payload.item_id) || clientContext,
      thread_id: validThreadId,
      user_id: currentUserId,
      timestamp: data.timestamp || Date.now() * 1000,
      item_type: 'media_share',
      media_share: { pk: mediaId }
    }, currentUserId);
  }

  /**
   * Shares an Instagram Reel natively into a DM thread (by numeric mediaId, shortcode, or Reel URL).
   * Uses IGDirectReelShareMutation with REST fallback.
   *
   * @param {string} threadId
   * @param {string|number} mediaIdOrUrl - Numeric media ID, shortcode, or https://www.instagram.com/reel/... URL
   * @param {Object} [options]
   * @param {string} [options.text] - Optional accompanying comment text
   * @param {boolean} [options.forceRest=false]
   * @returns {Promise<Message>}
   */
  async shareReel(threadId, mediaIdOrUrl, options = {}) {
    const validThreadId = validateThreadId(threadId);
    const mediaId = resolveMediaId(mediaIdOrUrl);
    const currentUserId = this.session ? this.session.userId : null;

    if (!options.forceRest) {
      try {
        const offlineId = this._generateOfflineId();
        const gqlData = await this._postGraphQL(
          'IGDirectReelShareMutation',
          Endpoints.GRAPHQL_DOCS.SHARE_REEL,
          {
            clip_share_params: {
              inventory_source: null,
              send_attribution: 'igd_web_chat_tab:in_thread',
              social_context_share_type: null,
              text: options.text ? { sensitive_string_value: String(options.text) } : null,
              tracking_token: null
            },
            data: {
              forwarded_from_thread_id: null,
              is_forwarded_from_own_message: null,
              offline_threading_id: offlineId,
              recipient_users: null,
              thread_id: validThreadId
            },
            ig_media_igid: mediaId,
            otid: offlineId
          },
          validThreadId
        );

        const node = gqlData && gqlData.xig_direct_clip_share_with_slide_msg_response;
        if (node) {
          return Message.fromRaw({
            item_id: node.message_id || node.id || offlineId,
            thread_id: validThreadId,
            user_id: currentUserId,
            timestamp: Number(node.timestamp_ms || Date.now()) * 1000,
            item_type: 'clip',
            clip: { clip: { pk: mediaId } }
          }, currentUserId);
        }
      } catch (err) {
        if (err instanceof InstaChatError) throw err;
        if (this.logger && typeof this.logger.debug === 'function') {
          this.logger.debug(`GraphQL shareReel failed (${err.message}), trying REST clip share.`);
        }
      }
    }

    const restThreadId = this._resolveRestThreadId(validThreadId);
    const clientContext = crypto.randomUUID();
    const csrf = this._getCsrfToken();

    const payload = new URLSearchParams();
    payload.append('action', 'send_item');
    payload.append('thread_ids', JSON.stringify([restThreadId]));
    payload.append('media_id', mediaId);
    if (options.text) payload.append('text', String(options.text));
    payload.append('client_context', clientContext);
    if (csrf) payload.append('_csrftoken', csrf);
    payload.append('_uuid', clientContext);

    const response = await this.transport.post(
      Endpoints.BROADCAST_CLIP_SHARE,
      payload.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      false
    );

    const data = response.data || {};
    if (data.status && data.status !== 'ok') {
      throw new InstaChatError(data.message || 'Failed to share reel', { details: data });
    }

    return Message.fromRaw({
      item_id: data.item_id || (data.payload && data.payload.item_id) || clientContext,
      thread_id: validThreadId,
      user_id: currentUserId,
      timestamp: data.timestamp || Date.now() * 1000,
      item_type: 'clip',
      clip: { clip: { pk: mediaId } }
    }, currentUserId);
  }

  /**
   * Shares an Instagram Story item into a conversation thread.
   * Uses IGDirectStoryShareMutation with REST fallback.
   *
   * @param {string} threadId
   * @param {string|number} storyMediaId - Story media ID
   * @param {Object} [options]
   * @param {string|number} [options.reelId] - Story owner's user ID / reel ID
   * @param {string} [options.text] - Optional reply/comment accompanying the story share
   * @param {string} [options.replyToItemId]
   * @param {boolean} [options.forceRest=false]
   * @returns {Promise<Message>}
   */
  async shareStory(threadId, storyMediaId, options = {}) {
    const validThreadId = validateThreadId(threadId);
    const validStoryId = resolveMediaId(storyMediaId);
    const currentUserId = this.session ? this.session.userId : null;
    const reelId = options.reelId ? String(options.reelId).trim() : null;

    if (!options.forceRest) {
      try {
        const offlineId = this._generateOfflineId();
        const gqlData = await this._postGraphQL(
          'IGDirectStoryShareMutation',
          Endpoints.GRAPHQL_DOCS.SHARE_STORY,
          {
            data: {
              is_shh_mode: false,
              mutation_token: offlineId,
              nullable_text: options.text ? { sensitive_string_value: String(options.text) } : null,
              reel_id: reelId,
              sampled: false,
              share_client_context: offlineId,
              story_media_id: validStoryId,
              story_share_type: options.storyShareType || null
            },
            send_data: {
              forwarded_from_thread_id: null,
              is_forwarded_from_own_message: null,
              offline_threading_id: offlineId,
              recipient_users: null,
              reply_to_message_id: options.replyToItemId || null,
              thread_id: validThreadId
            }
          },
          validThreadId
        );

        const node =
          gqlData &&
          (gqlData.direct_story_share_with_slide_response ||
            gqlData.xig_direct_story_share_with_slide_msg_response ||
            Object.values(gqlData)[0]);
        if (node && (node.message_id || node.id)) {
          return Message.fromRaw({
            item_id: node.message_id || node.id || offlineId,
            thread_id: validThreadId,
            user_id: currentUserId,
            timestamp: Number(node.timestamp_ms || Date.now()) * 1000,
            item_type: 'story_share',
            story_share: { media: { pk: validStoryId }, reel_id: reelId, text: options.text || '' }
          }, currentUserId);
        }
      } catch (err) {
        if (err instanceof InstaChatError) throw err;
        if (this.logger && typeof this.logger.debug === 'function') {
          this.logger.debug(`GraphQL shareStory failed (${err.message}), trying REST story_share.`);
        }
      }
    }

    const restThreadId = this._resolveRestThreadId(validThreadId);
    const clientContext = crypto.randomUUID();
    const csrf = this._getCsrfToken();

    const payload = new URLSearchParams();
    payload.append('action', 'send_item');
    payload.append('thread_ids', JSON.stringify([restThreadId]));
    payload.append('story_media_id', validStoryId);
    if (reelId) payload.append('reel_id', reelId);
    if (options.text) payload.append('text', String(options.text));
    payload.append('client_context', clientContext);
    if (csrf) payload.append('_csrftoken', csrf);
    payload.append('_uuid', clientContext);

    const response = await this.transport.post(
      Endpoints.BROADCAST_STORY_SHARE,
      payload.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      false
    );

    const data = response.data || {};
    if (data.status && data.status !== 'ok') {
      throw new InstaChatError(data.message || 'Failed to share story', { details: data });
    }

    return Message.fromRaw({
      item_id: data.item_id || (data.payload && data.payload.item_id) || clientContext,
      thread_id: validThreadId,
      user_id: currentUserId,
      timestamp: data.timestamp || Date.now() * 1000,
      item_type: 'story_share',
      story_share: { media: { pk: validStoryId }, reel_id: reelId, text: options.text || '' }
    }, currentUserId);
  }

  /**
   * Shares an Instagram user profile card into a conversation thread.
   *
   * @param {string} threadId
   * @param {string|number} userIdOrUsername - Numeric user ID or @username
   * @param {Object} [options]
   * @param {string} [options.text]
   * @returns {Promise<Message>}
   */
  async shareProfile(threadId, userIdOrUsername, options = {}) {
    const validThreadId = validateThreadId(threadId);
    if (userIdOrUsername === undefined || userIdOrUsername === null || !String(userIdOrUsername).trim()) {
      throw new ValidationError('userIdOrUsername must be a non-empty user ID or username.', {
        field: 'userIdOrUsername'
      });
    }

    const rawTarget = String(userIdOrUsername).trim();
    let profileUserId = null;
    let username = null;

    if (/^\d+$/.test(rawTarget)) {
      profileUserId = validateUserId(rawTarget);
    } else {
      username = rawTarget.replace(/^@/, '');
      if (this.usersService && typeof this.usersService.getUserByUsername === 'function') {
        const user = await this.usersService.getUserByUsername(username);
        profileUserId = user.id;
        username = user.username || username;
      } else {
        throw new ValidationError('Cannot resolve username for shareProfile without UsersService; pass numeric userId.', {
          field: 'userIdOrUsername'
        });
      }
    }

    const restThreadId = this._resolveRestThreadId(validThreadId);
    const clientContext = crypto.randomUUID();
    const csrf = this._getCsrfToken();
    const currentUserId = this.session ? this.session.userId : null;

    try {
      const payload = new URLSearchParams();
      payload.append('action', 'send_item');
      payload.append('thread_ids', JSON.stringify([restThreadId]));
      payload.append('profile_user_id', profileUserId);
      if (options.text) payload.append('text', String(options.text));
      payload.append('client_context', clientContext);
      if (csrf) payload.append('_csrftoken', csrf);
      payload.append('_uuid', clientContext);

      const response = await this.transport.post(
        Endpoints.BROADCAST_PROFILE,
        payload.toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
        false
      );

      const data = response.data || {};
      if (data.status === 'ok' || !data.status) {
        return Message.fromRaw({
          item_id: data.item_id || (data.payload && data.payload.item_id) || clientContext,
          thread_id: validThreadId,
          user_id: currentUserId,
          timestamp: data.timestamp || Date.now() * 1000,
          item_type: 'profile',
          profile: { pk: profileUserId, username: username || '' }
        }, currentUserId);
      }
    } catch (err) {
      if (username) {
        return this.sendLink(validThreadId, `${Endpoints.BASE_URL}/${username}/`, options);
      }
      throw err;
    }

    if (username) {
      return this.sendLink(validThreadId, `${Endpoints.BASE_URL}/${username}/`, options);
    }
    throw new InstaChatError(`Failed to share profile ${profileUserId}`);
  }

  /**
   * Creates an interactive DM group poll in a conversation thread.
   *
   * @param {string} threadId
   * @param {string} question - Poll question text
   * @param {Array<string|{text: string}>} pollOptions - 2 to 10 poll option labels
   * @returns {Promise<{success: boolean, threadId: string, pollId: string|null, question: string, options: Array<{text: string}>, message: Message|null}>}
   */
  async createPoll(threadId, question, pollOptions) {
    const validThreadId = validateThreadId(threadId);
    if (typeof question !== 'string' || !question.trim()) {
      throw new ValidationError('Poll question must be a non-empty string.', { field: 'question' });
    }
    if (!Array.isArray(pollOptions) || pollOptions.length < 2 || pollOptions.length > 10) {
      throw new ValidationError('Poll options must be an array containing between 2 and 10 choices.', {
        field: 'pollOptions'
      });
    }

    const formattedOptions = pollOptions.map((opt, idx) => {
      const text = typeof opt === 'string' ? opt.trim() : (opt && typeof opt.text === 'string' ? opt.text.trim() : '');
      if (!text) {
        throw new ValidationError(`Poll option at index ${idx} must be a non-empty string.`, {
          field: 'pollOptions'
        });
      }
      return { text };
    });

    const cleanQuestion = question.trim();
    const restThreadId = this._resolveRestThreadId(validThreadId);
    const clientContext = crypto.randomUUID();
    const csrf = this._getCsrfToken();
    const currentUserId = this.session ? this.session.userId : null;

    const payload = new URLSearchParams();
    payload.append('question', cleanQuestion);
    payload.append('options', JSON.stringify(formattedOptions));
    payload.append('client_context', clientContext);
    if (csrf) payload.append('_csrftoken', csrf);
    payload.append('_uuid', clientContext);

    const response = await this.transport.post(
      Endpoints.THREAD_CREATE_POLL(restThreadId),
      payload.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      false
    );

    const data = response.data || {};
    if (data.status && data.status !== 'ok') {
      throw new InstaChatError(data.message || 'Failed to create DM poll', { details: data });
    }

    const pollId = (data.poll && (data.poll.poll_id || data.poll.id)) || data.poll_id || null;
    const itemId = data.item_id || (data.payload && data.payload.item_id) || clientContext;

    const message = Message.fromRaw({
      item_id: itemId,
      thread_id: validThreadId,
      user_id: currentUserId,
      timestamp: data.timestamp || Date.now() * 1000,
      item_type: 'group_poll',
      group_poll: {
        poll_id: pollId || itemId,
        question: cleanQuestion,
        options: formattedOptions.map((o, i) => ({ id: String(i), text: o.text, count: 0 }))
      }
    }, currentUserId);

    return {
      success: true,
      threadId: validThreadId,
      pollId: pollId ? String(pollId) : null,
      question: cleanQuestion,
      options: formattedOptions,
      message
    };
  }

  /**
   * Casts or updates votes on an existing DM group poll.
   *
   * @param {string} threadId
   * @param {string|number} pollId
   * @param {string|number|Array<string|number>} optionIds - Option ID(s) to vote for
   * @returns {Promise<{success: boolean, threadId: string, pollId: string, optionIds: string[]}>}
   */
  async votePoll(threadId, pollId, optionIds) {
    const validThreadId = validateThreadId(threadId);
    if (pollId === undefined || pollId === null || !String(pollId).trim()) {
      throw new ValidationError('pollId must be a non-empty string or number.', { field: 'pollId' });
    }
    const cleanPollId = String(pollId).trim();

    const rawOptions = Array.isArray(optionIds) ? optionIds : [optionIds];
    if (rawOptions.length === 0) {
      throw new ValidationError('At least one poll optionId is required.', { field: 'optionIds' });
    }
    const validOptionIds = rawOptions.map((id) => String(id).trim()).filter(Boolean);
    if (validOptionIds.length === 0) {
      throw new ValidationError('At least one valid poll optionId is required.', { field: 'optionIds' });
    }

    const restThreadId = this._resolveRestThreadId(validThreadId);
    const clientContext = crypto.randomUUID();
    const csrf = this._getCsrfToken();

    const payload = new URLSearchParams();
    payload.append('option_ids', JSON.stringify(validOptionIds));
    payload.append('client_context', clientContext);
    if (csrf) payload.append('_csrftoken', csrf);
    payload.append('_uuid', clientContext);

    const response = await this.transport.post(
      Endpoints.THREAD_VOTE_POLL(restThreadId, cleanPollId),
      payload.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      false
    );

    const data = response.data || {};
    if (data.status && data.status !== 'ok') {
      throw new InstaChatError(data.message || 'Failed to vote on DM poll', { details: data });
    }

    return {
      success: true,
      threadId: validThreadId,
      pollId: cleanPollId,
      optionIds: validOptionIds
    };
  }
}

SharingService.resolveMediaId = resolveMediaId;

module.exports = SharingService;
