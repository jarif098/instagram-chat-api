'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const Endpoints = require('../constants/endpoints');
const Conversation = require('../models/conversation');
const {
  validateThreadId,
  validateUserId,
  validateMediaFile
} = require('../utils/validators');
const { ValidationError, InstaChatError } = require('../utils/errors');

/**
 * Collects a readable stream into a single Buffer.
 *
 * @param {import('stream').Readable} stream
 * @returns {Promise<Buffer>}
 */
function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', (err) => reject(err));
  });
}

class ThreadsService {
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

  /**
   * Normalizes an input of user IDs, @usernames, or User objects into numeric user IDs and optional EIMU FBIDs.
   *
   * @param {string|number|Object|Array<string|number|Object>} recipients
   * @returns {Promise<{userIds: string[], eimuFbids: string[]}>}
   * @private
   */
  async _resolveRecipients(recipients) {
    const list = Array.isArray(recipients) ? recipients : [recipients];
    if (list.length === 0) {
      throw new ValidationError('At least one recipient user ID or username is required.', {
        field: 'recipients'
      });
    }

    const userIds = [];
    const eimuFbids = [];

    for (const item of list) {
      if (item && typeof item === 'object') {
        const uid = validateUserId(item.id || item.pk || item.userId);
        userIds.push(uid);
        const fbid = item.interopFbid || item.interop_messaging_user_fbid || item.fbid_v2;
        if (fbid) {
          eimuFbids.push(String(fbid));
        } else if (this.session && this.session._userInteropFbidMap && this.session._userInteropFbidMap.has(uid)) {
          eimuFbids.push(this.session._userInteropFbidMap.get(uid));
        }
        continue;
      }

      const rawStr = String(item ?? '').trim();
      if (!rawStr) {
        throw new ValidationError('Recipient identifier cannot be empty.', { field: 'recipients' });
      }

      // Numeric ID
      if (/^\d+$/.test(rawStr)) {
        userIds.push(rawStr);
        if (this.session && this.session._userInteropFbidMap && this.session._userInteropFbidMap.has(rawStr)) {
          eimuFbids.push(this.session._userInteropFbidMap.get(rawStr));
        } else if (this.usersService && typeof this.usersService.getUserById === 'function') {
          try {
            const u = await this.usersService.getUserById(rawStr);
            if (u && u.interopFbid) {
              if (this.session) {
                if (!this.session._userInteropFbidMap) this.session._userInteropFbidMap = new Map();
                this.session._userInteropFbidMap.set(rawStr, u.interopFbid);
              }
              eimuFbids.push(u.interopFbid);
            }
          } catch (e) {}
        }
      } else {
        // Username handle
        if (!this.usersService || typeof this.usersService.getUserByUsername !== 'function') {
          throw new ValidationError(
            `Cannot resolve username "${rawStr}" without UsersService; pass numeric user IDs instead.`,
            { field: 'recipients' }
          );
        }
        const user = await this.usersService.getUserByUsername(rawStr);
        userIds.push(user.id);
        if (user.interopFbid) {
          if (this.session) {
            if (!this.session._userInteropFbidMap) this.session._userInteropFbidMap = new Map();
            this.session._userInteropFbidMap.set(user.id, user.interopFbid);
          }
          eimuFbids.push(user.interopFbid);
        }
      }
    }

    return {
      userIds: Array.from(new Set(userIds)),
      eimuFbids: Array.from(new Set(eimuFbids))
    };
  }

  /**
   * Normalizes one or more user IDs into a deduplicated string array.
   *
   * @param {string|number|Array<string|number>} userIds
   * @returns {string[]}
   * @private
   */
  _normalizeUserIdArray(userIds) {
    const list = Array.isArray(userIds) ? userIds : [userIds];
    if (list.length === 0) {
      throw new ValidationError('At least one userId must be provided.', { field: 'userIds' });
    }
    return Array.from(new Set(list.map((id) => validateUserId(id))));
  }

  /**
   * Creates a new 1:1 or group conversation thread.
   * Uses modern Instagram Web GraphQL (useCreateOpenGroupThreadOffMsysMutation) when recipient interop FBIDs
   * are available, falling back seamlessly to direct_v2/create_group_thread/.
   *
   * @param {string|number|Object|Array<string|number|Object>} recipients - User ID(s), @username(s), or User object(s)
   * @param {Object} [options]
   * @param {string} [options.title] - Optional initial group title
   * @param {string} [options.entryPoint='igd_inbox']
   * @param {boolean} [options.forceRest=false]
   * @returns {Promise<Conversation>}
   */
  async createThread(recipients, options = {}) {
    const { userIds, eimuFbids } = await this._resolveRecipients(recipients);
    const currentUserId = this.session ? this.session.userId : null;
    const csrf = this._getCsrfToken();
    const title = typeof options.title === 'string' && options.title.trim() ? options.title.trim() : null;

    const explicitEimu = Array.isArray(options.recipientEimuFbids)
      ? options.recipientEimuFbids.map(String)
      : eimuFbids;

    // 1. Primary: Modern Web GraphQL (useCreateOpenGroupThreadOffMsysMutation)
    if (!options.forceRest && explicitEimu.length === userIds.length && explicitEimu.length > 0) {
      try {
        const { dtsg, lsd } = await this._ensureGraphQLTokens();
        const offlineId = String(BigInt(Date.now()) * 1000000n + BigInt(Math.floor(Math.random() * 1000000)));

        const payload = new URLSearchParams();
        if (dtsg) payload.append('fb_dtsg', dtsg);
        if (lsd) payload.append('lsd', lsd);
        payload.append('fb_api_caller_class', 'RelayModern');
        payload.append('fb_api_req_friendly_name', 'useCreateOpenGroupThreadOffMsysMutation');
        payload.append('server_timestamps', 'true');
        payload.append('doc_id', Endpoints.GRAPHQL_DOCS.CREATE_THREAD);
        payload.append('variables', JSON.stringify({
          entry_point: options.entryPoint || 'igd_inbox',
          offline_threading_id: offlineId,
          recipient_eimu_fbids: explicitEimu
        }));

        const response = await this.transport.post(
          Endpoints.GRAPHQL,
          payload.toString(),
          {
            headers: {
              'x-csrftoken': csrf,
              'x-fb-friendly-name': 'useCreateOpenGroupThreadOffMsysMutation',
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
          },
          false
        );

        const respData = response && response.data;
        if (respData && respData.errors && respData.errors.length > 0) {
          throw new InstaChatError(respData.errors[0].message || 'GraphQL create thread mutation failed', {
            details: respData.errors
          });
        }

        const created = respData && respData.data && respData.data.xig_ig_direct_create_thread;
        if (created && (created.as_ig_direct_thread || created.id)) {
          const conv = Conversation.fromRaw(created, currentUserId);
          if (title && conv.id) {
            try {
              await this.setTitle(conv.id, title);
              conv.title = title;
            } catch (e) {}
          }
          return conv;
        }
      } catch (err) {
        if (err instanceof InstaChatError) throw err;
        if (this.logger && typeof this.logger.debug === 'function') {
          this.logger.debug(`GraphQL createThread failed (${err.message}), falling back to REST create_group_thread.`);
        }
      }
    }

    // 2. Fallback: REST create_group_thread
    const payload = new URLSearchParams();
    payload.append('recipient_users', JSON.stringify(userIds));
    if (title) {
      payload.append('thread_title', title);
    }
    if (csrf) {
      payload.append('_csrftoken', csrf);
    }
    payload.append('_uuid', crypto.randomUUID());

    const response = await this.transport.post(
      Endpoints.CREATE_GROUP_THREAD,
      payload.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      false
    );

    const data = response.data || {};
    if (data.status && data.status !== 'ok') {
      throw new InstaChatError(data.message || 'Failed to create conversation thread', {
        details: data
      });
    }

    const rawThread = data.thread || data;
    const conv = Conversation.fromRaw(rawThread, currentUserId);
    if (this.conversationsService && typeof this.conversationsService._cacheThreadIds === 'function') {
      this.conversationsService._cacheThreadIds([conv]);
    }
    return conv;
  }

  /**
   * Convenience wrapper to create a named group thread.
   *
   * @param {Array<string|number|Object>} recipients
   * @param {string} [title]
   * @param {Object} [options]
   * @returns {Promise<Conversation>}
   */
  async createGroupThread(recipients, title = null, options = {}) {
    return this.createThread(recipients, { ...options, title: title || options.title });
  }

  /**
   * Updates the title of a group conversation thread.
   *
   * @param {string} threadId
   * @param {string} title
   * @returns {Promise<{success: boolean, threadId: string, title: string, conversation: Conversation|null}>}
   */
  async setTitle(threadId, title) {
    const validThreadId = validateThreadId(threadId);
    if (typeof title !== 'string' || !title.trim()) {
      throw new ValidationError('Thread title must be a non-empty string.', { field: 'title' });
    }
    const cleanTitle = title.trim();
    const restId = this._resolveRestThreadId(validThreadId);
    const csrf = this._getCsrfToken();

    const payload = new URLSearchParams();
    payload.append('title', cleanTitle);
    if (csrf) payload.append('_csrftoken', csrf);
    payload.append('_uuid', crypto.randomUUID());

    const response = await this.transport.post(
      Endpoints.THREAD_UPDATE_TITLE(restId),
      payload.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      false
    );

    const data = response.data || {};
    if (data.status && data.status !== 'ok') {
      throw new InstaChatError(data.message || `Failed to update title for thread ${validThreadId}`, {
        details: data
      });
    }

    const currentUserId = this.session ? this.session.userId : null;
    return {
      success: true,
      threadId: validThreadId,
      title: cleanTitle,
      conversation: data.thread ? Conversation.fromRaw(data.thread, currentUserId) : null
    };
  }

  /**
   * Uploads and sets a custom cover photo for a group thread.
   *
   * @param {string} threadId
   * @param {string|Buffer|import('stream').Readable} fileInput - Local path, URL, Buffer, or Readable stream
   * @param {Object} [options]
   * @returns {Promise<{success: boolean, threadId: string, uploadId: string}>}
   */
  async setImage(threadId, fileInput, options = {}) {
    const validThreadId = validateThreadId(threadId);
    const restId = this._resolveRestThreadId(validThreadId);
    const csrf = this._getCsrfToken();

    let fileBuffer;
    let fileName = options.fileName || `group_photo_${Date.now()}.jpg`;
    let mimeType = options.mimeType || 'image/jpeg';

    if (typeof fileInput === 'string' && (fileInput.startsWith('http://') || fileInput.startsWith('https://'))) {
      const res = await axios.get(fileInput, {
        responseType: 'arraybuffer',
        timeout: options.downloadTimeoutMs || 30000
      });
      fileBuffer = Buffer.from(res.data);
      const ct = res.headers && (res.headers['content-type'] || res.headers['Content-Type']);
      if (ct && ct.includes('png')) mimeType = 'image/png';
    } else if (fileInput && (typeof fileInput.pipe === 'function' || fileInput[Symbol.asyncIterator])) {
      fileBuffer = await streamToBuffer(fileInput);
    } else if (Buffer.isBuffer(fileInput)) {
      fileBuffer = fileInput;
    } else {
      const validated = validateMediaFile(fileInput, 'image');
      fileBuffer = fs.readFileSync(validated.filePath);
      fileName = path.basename(validated.filePath);
      mimeType = validated.extension === '.png' ? 'image/png' : 'image/jpeg';
    }

    if (!fileBuffer || fileBuffer.length === 0) {
      throw new ValidationError('Group thread image buffer cannot be empty.', { field: 'fileInput' });
    }

    const uploadId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const ruploadResponse = await this.transport.post(
      Endpoints.RUPLOAD_PHOTO(uploadId),
      fileBuffer,
      {
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Entity-Type': mimeType,
          'X-Entity-Name': fileName,
          'X-Entity-Length': String(fileBuffer.length),
          Offset: '0',
          'X-Instagram-Rupload-Params': JSON.stringify({
            upload_id: uploadId,
            media_type: 1
          })
        }
      },
      false
    );

    if (ruploadResponse.data && ruploadResponse.data.status === 'fail') {
      throw new InstaChatError('Failed uploading group thread image via rupload', {
        details: ruploadResponse.data
      });
    }

    const payload = new URLSearchParams();
    payload.append('upload_id', uploadId);
    if (csrf) payload.append('_csrftoken', csrf);
    payload.append('_uuid', crypto.randomUUID());

    const response = await this.transport.post(
      Endpoints.THREAD_UPDATE_IMAGE(restId),
      payload.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      false
    );

    const data = response.data || {};
    if (data.status && data.status !== 'ok') {
      throw new InstaChatError(data.message || `Failed to set group image for thread ${validThreadId}`, {
        details: data
      });
    }

    return {
      success: true,
      threadId: validThreadId,
      uploadId
    };
  }

  /**
   * Adds one or more users to a group thread.
   *
   * @param {string} threadId
   * @param {string|number|Array<string|number>} userIds
   * @returns {Promise<{success: boolean, threadId: string, addedUserIds: string[]}>}
   */
  async addParticipants(threadId, userIds) {
    const validThreadId = validateThreadId(threadId);
    const validUserIds = this._normalizeUserIdArray(userIds);
    const restId = this._resolveRestThreadId(validThreadId);
    const csrf = this._getCsrfToken();

    const payload = new URLSearchParams();
    payload.append('user_ids', JSON.stringify(validUserIds));
    if (csrf) payload.append('_csrftoken', csrf);
    payload.append('_uuid', crypto.randomUUID());

    const response = await this.transport.post(
      Endpoints.THREAD_ADD_USERS(restId),
      payload.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      false
    );

    const data = response.data || {};
    if (data.status && data.status !== 'ok') {
      throw new InstaChatError(data.message || `Failed to add participants to thread ${validThreadId}`, {
        details: data
      });
    }

    return {
      success: true,
      threadId: validThreadId,
      addedUserIds: validUserIds
    };
  }

  /**
   * Removes (kicks) one or more users from a group thread.
   *
   * @param {string} threadId
   * @param {string|number|Array<string|number>} userIds
   * @returns {Promise<{success: boolean, threadId: string, removedUserIds: string[]}>}
   */
  async removeParticipant(threadId, userIds) {
    const validThreadId = validateThreadId(threadId);
    const validUserIds = this._normalizeUserIdArray(userIds);
    const restId = this._resolveRestThreadId(validThreadId);
    const csrf = this._getCsrfToken();

    const payload = new URLSearchParams();
    payload.append('user_ids', JSON.stringify(validUserIds));
    if (csrf) payload.append('_csrftoken', csrf);
    payload.append('_uuid', crypto.randomUUID());

    const response = await this.transport.post(
      Endpoints.THREAD_REMOVE_USERS(restId),
      payload.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      false
    );

    const data = response.data || {};
    if (data.status && data.status !== 'ok') {
      throw new InstaChatError(data.message || `Failed to remove participant(s) from thread ${validThreadId}`, {
        details: data
      });
    }

    return {
      success: true,
      threadId: validThreadId,
      removedUserIds: validUserIds
    };
  }

  /**
   * Promotes one or more group participants to thread admin.
   *
   * @param {string} threadId
   * @param {string|number|Array<string|number>} userIds
   * @returns {Promise<{success: boolean, threadId: string, adminUserIds: string[]}>}
   */
  async promoteAdmin(threadId, userIds) {
    const validThreadId = validateThreadId(threadId);
    const validUserIds = this._normalizeUserIdArray(userIds);
    const restId = this._resolveRestThreadId(validThreadId);
    const csrf = this._getCsrfToken();

    const payload = new URLSearchParams();
    payload.append('user_ids', JSON.stringify(validUserIds));
    if (csrf) payload.append('_csrftoken', csrf);
    payload.append('_uuid', crypto.randomUUID());

    const response = await this.transport.post(
      Endpoints.THREAD_ADD_ADMINS(restId),
      payload.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      false
    );

    const data = response.data || {};
    if (data.status && data.status !== 'ok') {
      throw new InstaChatError(data.message || `Failed to promote admin(s) in thread ${validThreadId}`, {
        details: data
      });
    }

    return {
      success: true,
      threadId: validThreadId,
      adminUserIds: validUserIds
    };
  }

  /**
   * Demotes one or more group admins back to regular participants.
   *
   * @param {string} threadId
   * @param {string|number|Array<string|number>} userIds
   * @returns {Promise<{success: boolean, threadId: string, demotedUserIds: string[]}>}
   */
  async demoteAdmin(threadId, userIds) {
    const validThreadId = validateThreadId(threadId);
    const validUserIds = this._normalizeUserIdArray(userIds);
    const restId = this._resolveRestThreadId(validThreadId);
    const csrf = this._getCsrfToken();

    const payload = new URLSearchParams();
    payload.append('user_ids', JSON.stringify(validUserIds));
    if (csrf) payload.append('_csrftoken', csrf);
    payload.append('_uuid', crypto.randomUUID());

    const response = await this.transport.post(
      Endpoints.THREAD_REMOVE_ADMINS(restId),
      payload.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      false
    );

    const data = response.data || {};
    if (data.status && data.status !== 'ok') {
      throw new InstaChatError(data.message || `Failed to demote admin(s) in thread ${validThreadId}`, {
        details: data
      });
    }

    return {
      success: true,
      threadId: validThreadId,
      demotedUserIds: validUserIds
    };
  }

  /**
   * Leaves a group conversation thread.
   *
   * @param {string} threadId
   * @returns {Promise<{success: boolean, threadId: string}>}
   */
  async leaveThread(threadId) {
    const validThreadId = validateThreadId(threadId);
    const restId = this._resolveRestThreadId(validThreadId);
    const csrf = this._getCsrfToken();

    const payload = new URLSearchParams();
    if (csrf) payload.append('_csrftoken', csrf);
    payload.append('_uuid', crypto.randomUUID());

    const response = await this.transport.post(
      Endpoints.THREAD_LEAVE(restId),
      payload.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      false
    );

    const data = response.data || {};
    if (data.status && data.status !== 'ok') {
      throw new InstaChatError(data.message || `Failed to leave thread ${validThreadId}`, {
        details: data
      });
    }

    return {
      success: true,
      threadId: validThreadId
    };
  }

  /**
   * Deletes (hides) a conversation thread from the user's inbox.
   *
   * @param {string} threadId
   * @returns {Promise<{success: boolean, threadId: string}>}
   */
  async deleteThread(threadId) {
    const validThreadId = validateThreadId(threadId);
    const restId = this._resolveRestThreadId(validThreadId);
    const csrf = this._getCsrfToken();

    const payload = new URLSearchParams();
    payload.append('use_unified_inbox', 'true');
    if (csrf) payload.append('_csrftoken', csrf);
    payload.append('_uuid', crypto.randomUUID());

    const response = await this.transport.post(
      Endpoints.THREAD_HIDE(restId),
      payload.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      false
    );

    const data = response.data || {};
    if (data.status && data.status !== 'ok') {
      throw new InstaChatError(data.message || `Failed to delete thread ${validThreadId}`, {
        details: data
      });
    }

    return {
      success: true,
      threadId: validThreadId
    };
  }

  /**
   * Mutes or unmutes notifications for a conversation thread.
   *
   * @param {string} threadId
   * @param {boolean} [muted=true]
   * @returns {Promise<{success: boolean, threadId: string, muted: boolean}>}
   */
  async muteThread(threadId, muted = true) {
    const validThreadId = validateThreadId(threadId);
    const restId = this._resolveRestThreadId(validThreadId);
    const csrf = this._getCsrfToken();
    const shouldMute = Boolean(muted);

    const payload = new URLSearchParams();
    if (csrf) payload.append('_csrftoken', csrf);
    payload.append('_uuid', crypto.randomUUID());

    const endpoint = shouldMute
      ? Endpoints.THREAD_MUTE(restId)
      : Endpoints.THREAD_UNMUTE(restId);

    const response = await this.transport.post(
      endpoint,
      payload.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      false
    );

    const data = response.data || {};
    if (data.status && data.status !== 'ok') {
      throw new InstaChatError(data.message || `Failed to ${shouldMute ? 'mute' : 'unmute'} thread ${validThreadId}`, {
        details: data
      });
    }

    return {
      success: true,
      threadId: validThreadId,
      muted: shouldMute
    };
  }

  /**
   * Pins or unpins a conversation thread at the top of the inbox.
   *
   * @param {string} threadId
   * @param {boolean} [pinned=true]
   * @returns {Promise<{success: boolean, threadId: string, pinned: boolean}>}
   */
  async pinThread(threadId, pinned = true) {
    const validThreadId = validateThreadId(threadId);
    const restId = this._resolveRestThreadId(validThreadId);
    const csrf = this._getCsrfToken();
    const shouldPin = Boolean(pinned);

    const payload = new URLSearchParams();
    if (csrf) payload.append('_csrftoken', csrf);
    payload.append('_uuid', crypto.randomUUID());

    const endpoint = shouldPin
      ? Endpoints.THREAD_PIN(restId)
      : Endpoints.THREAD_UNPIN(restId);

    const response = await this.transport.post(
      endpoint,
      payload.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      false
    );

    const data = response.data || {};
    if (data.status && data.status !== 'ok') {
      throw new InstaChatError(data.message || `Failed to ${shouldPin ? 'pin' : 'unpin'} thread ${validThreadId}`, {
        details: data
      });
    }

    return {
      success: true,
      threadId: validThreadId,
      pinned: shouldPin
    };
  }

  /**
   * Searches messages inside a conversation thread.
   *
   * @param {string} threadId
   * @param {string} query
   * @param {Object} [options]
   * @returns {Promise<{messages: import('../models/message')[], offset: number, hasMore: boolean}>}
   */
  async searchMessages(threadId, query, options = {}) {
    if (this.conversationsService && typeof this.conversationsService.searchInThread === 'function') {
      return this.conversationsService.searchInThread(threadId, query, options);
    }
    throw new InstaChatError('ConversationsService is required for searchMessages.');
  }
}

module.exports = ThreadsService;
