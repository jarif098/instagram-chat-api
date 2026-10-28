'use strict';

const Endpoints = require('../constants/endpoints');
const User = require('../models/user');
const {
  validateUserId,
  validateUsername,
  validateSearchQuery
} = require('../utils/validators');
const {
  ValidationError,
  NotFoundError,
  AuthenticationError,
  RateLimitError,
  InstaChatError
} = require('../utils/errors');

class UsersService {
  constructor(options = {}) {
    this.transport = options.transport;
    this.session = options.session;
    this.logger = options.logger;
  }

  /**
   * Normalizes an Instagram friendship status payload.
   *
   * @param {string} userId
   * @param {Object} [raw={}]
   * @returns {Object}
   */
  _normalizeFriendshipStatus(userId, raw = {}) {
    const data = raw && typeof raw === 'object' ? raw : {};
    return {
      userId: String(userId),
      following: Boolean(data.following),
      followedBy: Boolean(data.followed_by),
      blocking: Boolean(data.blocking),
      muting: Boolean(data.muting),
      isPrivate: Boolean(data.is_private),
      incomingRequest: Boolean(data.incoming_request),
      outgoingRequest: Boolean(data.outgoing_request),
      isBestie: Boolean(data.is_bestie),
      isRestricted: Boolean(data.is_restricted),
      isFeedFavorite: Boolean(data.is_feed_favorite),
      raw: data
    };
  }

  /**
   * Retrieves rich profile details for an Instagram user by username.
   *
   * @param {string} username - Instagram handle (with or without leading @)
   * @returns {Promise<User>}
   */
  async getUserByUsername(username) {
    const cleanUsername = validateUsername(username);

    const response = await this.transport.get(Endpoints.USER_WEB_PROFILE, {
      params: { username: cleanUsername },
      headers: {
        Referer: `${Endpoints.BASE_URL}/${cleanUsername}/`
      }
    });

    const body = response.data || {};
    const rawUser = (body.data && body.data.user) || body.user || null;

    if (!rawUser) {
      throw new NotFoundError(`Instagram user "@${cleanUsername}" was not found.`);
    }

    return User.fromRaw(rawUser);
  }

  /**
   * Retrieves profile details for an Instagram user by numeric user ID.
   *
   * @param {string|number} userId - Target Instagram numeric user ID
   * @returns {Promise<User>}
   */
  async getUserById(userId) {
    const validUserId = validateUserId(userId);
    let response;

    try {
      response = await this.transport.get(Endpoints.USER_INFO(validUserId));
    } catch (err) {
      if (
        err instanceof NotFoundError ||
        err instanceof AuthenticationError ||
        err instanceof RateLimitError
      ) {
        throw err;
      }
      if (this.logger && typeof this.logger.debug === 'function') {
        this.logger.debug(`Primary USER_INFO failed (${err.message}), retrying via web origin...`);
      }
      response = await this.transport.get(Endpoints.USER_INFO_WEB(validUserId));
    }

    const body = response.data || {};
    const rawUser = body.user || (body.data && body.data.user) || null;

    if (!rawUser) {
      throw new NotFoundError(`Instagram user with ID "${validUserId}" was not found.`);
    }

    return User.fromRaw(rawUser);
  }

  /**
   * Searches Instagram users matching a query string.
   *
   * @param {string} query - Search query or username prefix
   * @param {Object} [options]
   * @param {number} [options.limit=15] - Maximum results to return (1-50)
   * @param {string} [options.context='blended'] - Search context ('blended' or 'user')
   * @param {boolean} [options.forceV1=false] - Force legacy /api/v1/users/search/ endpoint
   * @returns {Promise<User[]>}
   */
  async searchUsers(query, options = {}) {
    const validQuery = validateSearchQuery(query);
    const cleanQuery = validQuery.replace(/^@/, '').trim();
    if (!cleanQuery) {
      throw new ValidationError('Search query must contain valid characters beyond "@".', {
        field: 'query'
      });
    }

    const limit = Math.min(Math.max(Number(options.limit) || 15, 1), 50);
    let response;

    if (!options.forceV1) {
      try {
        response = await this.transport.get(Endpoints.SEARCH_USERS, {
          params: {
            context: options.context || 'blended',
            query: cleanQuery,
            include_reel: 'false'
          }
        });
      } catch (err) {
        if (err instanceof AuthenticationError || err instanceof RateLimitError) {
          throw err;
        }
        if (this.logger && typeof this.logger.debug === 'function') {
          this.logger.debug(`Web topsearch failed (${err.message}), falling back to users/search.`);
        }
      }
    }

    if (!response) {
      response = await this.transport.get(Endpoints.SEARCH_USERS_V1, {
        params: {
          q: cleanQuery,
          count: limit
        }
      });
    }

    const data = response.data || {};
    const rawUsers = Array.isArray(data.users) ? data.users : [];

    return rawUsers
      .map((entry) => User.fromRaw(entry && entry.user ? entry.user : entry))
      .filter((u) => Boolean(u && (u.id || u.username)))
      .slice(0, limit);
  }

  /**
   * Retrieves the relationship / friendship status between the authenticated user and target user.
   *
   * @param {string|number} userId - Target Instagram user ID
   * @returns {Promise<Object>}
   */
  async getFriendshipStatus(userId) {
    const validUserId = validateUserId(userId);
    const response = await this.transport.get(Endpoints.FRIENDSHIP_STATUS(validUserId));
    return this._normalizeFriendshipStatus(validUserId, response.data || {});
  }

  /**
   * Retrieves friendship statuses for multiple user IDs in a single batch call.
   *
   * @param {Array<string|number>} userIds - Non-empty array of Instagram user IDs
   * @returns {Promise<Object<string, Object>>}
   */
  async getFriendshipStatuses(userIds) {
    if (!Array.isArray(userIds) || userIds.length === 0) {
      throw new ValidationError('userIds must be a non-empty array of user IDs.', {
        field: 'userIds'
      });
    }

    const validIds = Array.from(new Set(userIds.map((id) => validateUserId(id))));
    const csrfToken = this.session ? this.session.getCsrfToken() : '';

    const payload = new URLSearchParams();
    payload.append('user_ids', validIds.join(','));
    if (csrfToken) {
      payload.append('_csrftoken', csrfToken);
    }

    const response = await this.transport.post(
      Endpoints.FRIENDSHIP_STATUS_MANY,
      payload.toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      },
      true
    );

    const data = response.data || {};
    const rawMap = data.friendship_statuses || {};
    const result = {};

    for (const id of validIds) {
      result[id] = this._normalizeFriendshipStatus(id, rawMap[id] || {});
    }

    return result;
  }

  /**
   * Follows a target user (or sends a follow request if the target account is private).
   *
   * @param {string|number} userId - Target Instagram user ID
   * @returns {Promise<{success: boolean, userId: string, friendshipStatus: Object}>}
   */
  async followUser(userId) {
    const validUserId = validateUserId(userId);
    const csrfToken = this.session ? this.session.getCsrfToken() : '';

    const payload = new URLSearchParams();
    payload.append('user_id', validUserId);
    payload.append('container_module', 'profile');
    if (csrfToken) {
      payload.append('_csrftoken', csrfToken);
    }

    const response = await this.transport.post(
      Endpoints.FRIENDSHIP_FOLLOW(validUserId),
      payload.toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      },
      false
    );

    const data = response.data || {};
    if (data.status && data.status !== 'ok') {
      throw new InstaChatError(data.message || `Failed to follow user ${validUserId}`, {
        details: data
      });
    }

    const fallbackRaw = {
      following: data.result ? data.result === 'following' : true,
      outgoing_request: data.result === 'requested'
    };

    return {
      success: true,
      userId: validUserId,
      friendshipStatus: this._normalizeFriendshipStatus(
        validUserId,
        data.friendship_status || fallbackRaw
      )
    };
  }

  /**
   * Unfollows a target user (or cancels a pending outgoing follow request).
   *
   * @param {string|number} userId - Target Instagram user ID
   * @returns {Promise<{success: boolean, userId: string, friendshipStatus: Object}>}
   */
  async unfollowUser(userId) {
    const validUserId = validateUserId(userId);
    const csrfToken = this.session ? this.session.getCsrfToken() : '';

    const payload = new URLSearchParams();
    payload.append('user_id', validUserId);
    payload.append('container_module', 'profile');
    if (csrfToken) {
      payload.append('_csrftoken', csrfToken);
    }

    const response = await this.transport.post(
      Endpoints.FRIENDSHIP_UNFOLLOW(validUserId),
      payload.toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      },
      false
    );

    const data = response.data || {};
    if (data.status && data.status !== 'ok') {
      throw new InstaChatError(data.message || `Failed to unfollow user ${validUserId}`, {
        details: data
      });
    }

    return {
      success: true,
      userId: validUserId,
      friendshipStatus: this._normalizeFriendshipStatus(
        validUserId,
        data.friendship_status || { following: false, outgoing_request: false }
      )
    };
  }

  /**
   * Removes a user from the authenticated account's followers list.
   *
   * @param {string|number} userId - Follower's Instagram user ID
   * @returns {Promise<{success: boolean, userId: string, friendshipStatus: Object}>}
   */
  async removeFollower(userId) {
    const validUserId = validateUserId(userId);
    const csrfToken = this.session ? this.session.getCsrfToken() : '';

    const payload = new URLSearchParams();
    payload.append('user_id', validUserId);
    if (csrfToken) {
      payload.append('_csrftoken', csrfToken);
    }

    const response = await this.transport.post(
      Endpoints.FRIENDSHIP_REMOVE_FOLLOWER(validUserId),
      payload.toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      },
      false
    );

    const data = response.data || {};
    if (data.status && data.status !== 'ok') {
      throw new InstaChatError(data.message || `Failed to remove follower ${validUserId}`, {
        details: data
      });
    }

    return {
      success: true,
      userId: validUserId,
      friendshipStatus: this._normalizeFriendshipStatus(
        validUserId,
        data.friendship_status || { followed_by: false }
      )
    };
  }

  /**
   * Retrieves followers of a target user with cursor pagination.
   *
   * @param {string|number} userId - Target Instagram user ID
   * @param {Object} [options]
   * @param {number} [options.count=20] - Results per page (1-100)
   * @param {string} [options.maxId] - Pagination cursor from previous response's nextMaxId
   * @param {string} [options.query] - Optional filter query within followers
   * @returns {Promise<{users: User[], nextMaxId: string|null, hasMore: boolean}>}
   */
  async getFollowers(userId, options = {}) {
    const validUserId = validateUserId(userId);
    const count = Math.min(Math.max(Number(options.count || options.limit) || 20, 1), 100);
    const params = {
      count,
      search_surface: 'follow_list_page'
    };

    if (options.maxId || options.cursor) {
      params.max_id = String(options.maxId || options.cursor);
    }
    if (options.query) {
      params.query = String(options.query);
    }

    const response = await this.transport.get(Endpoints.FRIENDSHIP_FOLLOWERS(validUserId), {
      params
    });

    const data = response.data || {};
    const rawUsers = Array.isArray(data.users) ? data.users : [];

    return {
      users: rawUsers.map((u) => User.fromRaw(u)).filter(Boolean),
      nextMaxId: data.next_max_id ? String(data.next_max_id) : null,
      hasMore: Boolean(data.big_list || data.next_max_id)
    };
  }

  /**
   * Retrieves accounts followed by a target user with cursor pagination.
   *
   * @param {string|number} userId - Target Instagram user ID
   * @param {Object} [options]
   * @param {number} [options.count=20] - Results per page (1-100)
   * @param {string} [options.maxId] - Pagination cursor from previous response's nextMaxId
   * @param {string} [options.query] - Optional filter query within following
   * @returns {Promise<{users: User[], nextMaxId: string|null, hasMore: boolean}>}
   */
  async getFollowing(userId, options = {}) {
    const validUserId = validateUserId(userId);
    const count = Math.min(Math.max(Number(options.count || options.limit) || 20, 1), 100);
    const params = { count };

    if (options.maxId || options.cursor) {
      params.max_id = String(options.maxId || options.cursor);
    }
    if (options.query) {
      params.query = String(options.query);
    }

    const response = await this.transport.get(Endpoints.FRIENDSHIP_FOLLOWING(validUserId), {
      params
    });

    const data = response.data || {};
    const rawUsers = Array.isArray(data.users) ? data.users : [];

    return {
      users: rawUsers.map((u) => User.fromRaw(u)).filter(Boolean),
      nextMaxId: data.next_max_id ? String(data.next_max_id) : null,
      hasMore: Boolean(data.big_list || data.next_max_id)
    };
  }

  /**
   * Ensures GraphQL fb_dtsg & lsd tokens are available on session when available.
   *
   * @private
   */
  async _ensureGraphQLTokens() {
    if (this.session && this.session._dtsg && this.session._lsd) {
      return { dtsg: this.session._dtsg, lsd: this.session._lsd };
    }

    if (this.transport && typeof this.transport.get === 'function') {
      try {
        const res = await this.transport.get(`${Endpoints.BASE_URL}/`, {
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
   * Retrieves incoming pending follow requests for private accounts.
   *
   * @param {Object} [options]
   * @param {string} [options.maxId]
   * @returns {Promise<{users: User[], nextMaxId: string|null, hasMore: boolean}>}
   */
  async getPendingFollowRequests(options = {}) {
    const params = {};
    if (options.maxId || options.cursor) {
      params.max_id = String(options.maxId || options.cursor);
    }

    const response = await this.transport.get(Endpoints.FRIENDSHIP_PENDING_REQUESTS, { params });
    const data = response.data || {};
    const rawUsers = Array.isArray(data.users) ? data.users : [];

    return {
      users: rawUsers.map((u) => User.fromRaw(u)).filter(Boolean),
      nextMaxId: data.next_max_id ? String(data.next_max_id) : null,
      hasMore: Boolean(data.big_list || data.next_max_id)
    };
  }

  /**
   * Approves an incoming follow request from a user.
   * Uses PolarisFollowRequestButtonsApproveMutation with REST fallback.
   *
   * @param {string|number} userId
   * @param {Object} [options]
   * @param {boolean} [options.forceRest=false]
   * @returns {Promise<{success: boolean, userId: string, friendshipStatus: Object}>}
   */
  async approveFollowRequest(userId, options = {}) {
    const validUserId = validateUserId(userId);
    const csrfToken = this.session && typeof this.session.getCsrfToken === 'function'
      ? this.session.getCsrfToken()
      : '';

    if (!options.forceRest && this.transport && typeof this.transport.post === 'function') {
      try {
        const { dtsg, lsd } = await this._ensureGraphQLTokens();
        const payload = new URLSearchParams();
        if (dtsg) payload.append('fb_dtsg', dtsg);
        if (lsd) payload.append('lsd', lsd);
        payload.append('fb_api_caller_class', 'RelayModern');
        payload.append('fb_api_req_friendly_name', 'PolarisFollowRequestButtonsApproveMutation');
        payload.append('server_timestamps', 'true');
        payload.append('doc_id', Endpoints.GRAPHQL_DOCS.APPROVE_FOLLOW);
        payload.append('variables', JSON.stringify({ target_user_id: validUserId }));

        const response = await this.transport.post(
          Endpoints.GRAPHQL,
          payload.toString(),
          {
            headers: {
              'x-csrftoken': csrfToken,
              'x-fb-friendly-name': 'PolarisFollowRequestButtonsApproveMutation',
              'x-ig-app-id': Endpoints.WEB_APP_ID,
              'x-asbd-id': Endpoints.ASBD_ID,
              'x-fb-lsd': lsd || '0l2qtDa0grAFC5qqeoHlvO',
              'Content-Type': 'application/x-www-form-urlencoded',
              Origin: Endpoints.BASE_URL,
              Referer: `${Endpoints.BASE_URL}/`,
              'sec-fetch-dest': 'empty',
              'sec-fetch-mode': 'cors',
              'sec-fetch-site': 'same-origin'
            }
          },
          false
        );

        const respData = response && response.data;
        if (respData && respData.errors && respData.errors.length > 0) {
          throw new InstaChatError(respData.errors[0].message || 'GraphQL approve follow request failed', {
            details: respData.errors
          });
        }

        if (respData && respData.data && respData.data.xdt_friendships_approve_user) {
          return {
            success: true,
            userId: validUserId,
            friendshipStatus: this._normalizeFriendshipStatus(validUserId, {
              followed_by: true,
              incoming_request: false
            })
          };
        }
      } catch (err) {
        if (err instanceof InstaChatError) throw err;
      }
    }

    const payload = new URLSearchParams();
    payload.append('user_id', validUserId);
    if (csrfToken) payload.append('_csrftoken', csrfToken);

    const response = await this.transport.post(
      Endpoints.FRIENDSHIP_APPROVE_REQUEST(validUserId),
      payload.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      false
    );

    const data = response.data || {};
    if (data.status && data.status !== 'ok') {
      throw new InstaChatError(data.message || `Failed to approve follow request from ${validUserId}`, {
        details: data
      });
    }

    return {
      success: true,
      userId: validUserId,
      friendshipStatus: this._normalizeFriendshipStatus(
        validUserId,
        data.friendship_status || { followed_by: true, incoming_request: false }
      )
    };
  }

  /**
   * Ignores (declines) an incoming follow request from a user.
   * Uses PolarisFollowRequestButtonsIgnoreMutation with REST fallback.
   *
   * @param {string|number} userId
   * @param {Object} [options]
   * @param {boolean} [options.forceRest=false]
   * @returns {Promise<{success: boolean, userId: string, friendshipStatus: Object}>}
   */
  async ignoreFollowRequest(userId, options = {}) {
    const validUserId = validateUserId(userId);
    const csrfToken = this.session && typeof this.session.getCsrfToken === 'function'
      ? this.session.getCsrfToken()
      : '';

    if (!options.forceRest && this.transport && typeof this.transport.post === 'function') {
      try {
        const { dtsg, lsd } = await this._ensureGraphQLTokens();
        const payload = new URLSearchParams();
        if (dtsg) payload.append('fb_dtsg', dtsg);
        if (lsd) payload.append('lsd', lsd);
        payload.append('fb_api_caller_class', 'RelayModern');
        payload.append('fb_api_req_friendly_name', 'PolarisFollowRequestButtonsIgnoreMutation');
        payload.append('server_timestamps', 'true');
        payload.append('doc_id', Endpoints.GRAPHQL_DOCS.IGNORE_FOLLOW);
        payload.append('variables', JSON.stringify({ target_user_id: validUserId }));

        const response = await this.transport.post(
          Endpoints.GRAPHQL,
          payload.toString(),
          {
            headers: {
              'x-csrftoken': csrfToken,
              'x-fb-friendly-name': 'PolarisFollowRequestButtonsIgnoreMutation',
              'x-ig-app-id': Endpoints.WEB_APP_ID,
              'x-asbd-id': Endpoints.ASBD_ID,
              'x-fb-lsd': lsd || '0l2qtDa0grAFC5qqeoHlvO',
              'Content-Type': 'application/x-www-form-urlencoded',
              Origin: Endpoints.BASE_URL,
              Referer: `${Endpoints.BASE_URL}/`,
              'sec-fetch-dest': 'empty',
              'sec-fetch-mode': 'cors',
              'sec-fetch-site': 'same-origin'
            }
          },
          false
        );

        const respData = response && response.data;
        if (respData && respData.errors && respData.errors.length > 0) {
          throw new InstaChatError(respData.errors[0].message || 'GraphQL ignore follow request failed', {
            details: respData.errors
          });
        }

        if (respData && respData.data && respData.data.xdt_friendships_ignore_user) {
          return {
            success: true,
            userId: validUserId,
            friendshipStatus: this._normalizeFriendshipStatus(validUserId, {
              followed_by: false,
              incoming_request: false
            })
          };
        }
      } catch (err) {
        if (err instanceof InstaChatError) throw err;
      }
    }

    const payload = new URLSearchParams();
    payload.append('user_id', validUserId);
    if (csrfToken) payload.append('_csrftoken', csrfToken);

    const response = await this.transport.post(
      Endpoints.FRIENDSHIP_IGNORE_REQUEST(validUserId),
      payload.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      false
    );

    const data = response.data || {};
    if (data.status && data.status !== 'ok') {
      throw new InstaChatError(data.message || `Failed to ignore follow request from ${validUserId}`, {
        details: data
      });
    }

    return {
      success: true,
      userId: validUserId,
      friendshipStatus: this._normalizeFriendshipStatus(
        validUserId,
        data.friendship_status || { followed_by: false, incoming_request: false }
      )
    };
  }

  /**
   * Blocks an Instagram user.
   *
   * @param {string|number} userId
   * @returns {Promise<{success: boolean, userId: string, friendshipStatus: Object}>}
   */
  async blockUser(userId) {
    const validUserId = validateUserId(userId);
    const csrfToken = this.session && typeof this.session.getCsrfToken === 'function'
      ? this.session.getCsrfToken()
      : '';

    const payload = new URLSearchParams();
    payload.append('user_id', validUserId);
    if (csrfToken) payload.append('_csrftoken', csrfToken);

    let response;
    try {
      response = await this.transport.post(
        Endpoints.WEB_BLOCK_USER(validUserId),
        payload.toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
        false
      );
    } catch (err) {
      if (err instanceof AuthenticationError || err instanceof RateLimitError) throw err;
      response = await this.transport.post(
        Endpoints.FRIENDSHIP_BLOCK(validUserId),
        payload.toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
        false
      );
    }

    const data = response.data || {};
    if (data.status && data.status !== 'ok') {
      throw new InstaChatError(data.message || `Failed to block user ${validUserId}`, { details: data });
    }

    return {
      success: true,
      userId: validUserId,
      friendshipStatus: this._normalizeFriendshipStatus(
        validUserId,
        data.friendship_status || { blocking: true, following: false }
      )
    };
  }

  /**
   * Unblocks a previously blocked Instagram user.
   *
   * @param {string|number} userId
   * @returns {Promise<{success: boolean, userId: string, friendshipStatus: Object}>}
   */
  async unblockUser(userId) {
    const validUserId = validateUserId(userId);
    const csrfToken = this.session && typeof this.session.getCsrfToken === 'function'
      ? this.session.getCsrfToken()
      : '';

    const payload = new URLSearchParams();
    payload.append('user_id', validUserId);
    if (csrfToken) payload.append('_csrftoken', csrfToken);

    let response;
    try {
      response = await this.transport.post(
        Endpoints.WEB_UNBLOCK_USER(validUserId),
        payload.toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
        false
      );
    } catch (err) {
      if (err instanceof AuthenticationError || err instanceof RateLimitError) throw err;
      response = await this.transport.post(
        Endpoints.FRIENDSHIP_UNBLOCK(validUserId),
        payload.toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
        false
      );
    }

    const data = response.data || {};
    if (data.status && data.status !== 'ok') {
      throw new InstaChatError(data.message || `Failed to unblock user ${validUserId}`, { details: data });
    }

    return {
      success: true,
      userId: validUserId,
      friendshipStatus: this._normalizeFriendshipStatus(
        validUserId,
        data.friendship_status || { blocking: false }
      )
    };
  }

  /**
   * Restricts an Instagram user (moves their DMs to Message Requests and hides read receipts).
   *
   * @param {string|number} userId
   * @returns {Promise<{success: boolean, userId: string, isRestricted: boolean, friendshipStatus: Object}>}
   */
  async restrictUser(userId) {
    const validUserId = validateUserId(userId);
    const csrfToken = this.session && typeof this.session.getCsrfToken === 'function'
      ? this.session.getCsrfToken()
      : '';

    const payload = new URLSearchParams();
    payload.append('target_user_id', validUserId);
    if (csrfToken) payload.append('_csrftoken', csrfToken);

    const response = await this.transport.post(
      Endpoints.RESTRICT_USER,
      payload.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      false
    );

    const data = response.data || {};
    if (data.status && data.status !== 'ok') {
      throw new InstaChatError(data.message || `Failed to restrict user ${validUserId}`, { details: data });
    }

    const rawFs = (data.users && data.users[0] && data.users[0].friendship_status) ||
      data.friendship_status ||
      { is_restricted: true };

    return {
      success: true,
      userId: validUserId,
      isRestricted: true,
      friendshipStatus: this._normalizeFriendshipStatus(validUserId, rawFs)
    };
  }

  /**
   * Unrestricts a previously restricted Instagram user.
   * Uses modern Web GraphQL (usePolarisUnrestrictMutation) with REST fallback.
   *
   * @param {string|number} userId
   * @param {Object} [options]
   * @param {boolean} [options.forceRest=false]
   * @returns {Promise<{success: boolean, userId: string, isRestricted: boolean, friendshipStatus: Object}>}
   */
  async unrestrictUser(userId, options = {}) {
    const validUserId = validateUserId(userId);
    const csrfToken = this.session && typeof this.session.getCsrfToken === 'function'
      ? this.session.getCsrfToken()
      : '';

    if (!options.forceRest && this.transport && typeof this.transport.post === 'function') {
      try {
        const { dtsg, lsd } = await this._ensureGraphQLTokens();
        const payload = new URLSearchParams();
        if (dtsg) payload.append('fb_dtsg', dtsg);
        if (lsd) payload.append('lsd', lsd);
        payload.append('fb_api_caller_class', 'RelayModern');
        payload.append('fb_api_req_friendly_name', 'usePolarisUnrestrictMutation');
        payload.append('server_timestamps', 'true');
        payload.append('doc_id', Endpoints.GRAPHQL_DOCS.UNRESTRICT_USER);
        payload.append('variables', JSON.stringify({ target_user_id: validUserId }));

        const response = await this.transport.post(
          Endpoints.GRAPHQL,
          payload.toString(),
          {
            headers: {
              'x-csrftoken': csrfToken,
              'x-fb-friendly-name': 'usePolarisUnrestrictMutation',
              'x-ig-app-id': Endpoints.WEB_APP_ID,
              'x-asbd-id': Endpoints.ASBD_ID,
              'x-fb-lsd': lsd || '0l2qtDa0grAFC5qqeoHlvO',
              'Content-Type': 'application/x-www-form-urlencoded',
              Origin: Endpoints.BASE_URL,
              Referer: `${Endpoints.BASE_URL}/`,
              'sec-fetch-dest': 'empty',
              'sec-fetch-mode': 'cors',
              'sec-fetch-site': 'same-origin'
            }
          },
          false
        );

        const respData = response && response.data;
        if (respData && respData.errors && respData.errors.length > 0) {
          throw new InstaChatError(respData.errors[0].message || 'GraphQL unrestrict user failed', {
            details: respData.errors
          });
        }

        const node = respData && respData.data && respData.data.xdt_api__v1__restrict_action__unrestrict;
        if (node) {
          return {
            success: true,
            userId: validUserId,
            isRestricted: false,
            friendshipStatus: this._normalizeFriendshipStatus(
              validUserId,
              node.friendship_status || { is_restricted: false }
            )
          };
        }
      } catch (err) {
        if (err instanceof InstaChatError) throw err;
      }
    }

    const payload = new URLSearchParams();
    payload.append('target_user_id', validUserId);
    if (csrfToken) payload.append('_csrftoken', csrfToken);

    const response = await this.transport.post(
      Endpoints.UNRESTRICT_USER,
      payload.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      false
    );

    const data = response.data || {};
    if (data.status && data.status !== 'ok') {
      throw new InstaChatError(data.message || `Failed to unrestrict user ${validUserId}`, { details: data });
    }

    return {
      success: true,
      userId: validUserId,
      isRestricted: false,
      friendshipStatus: this._normalizeFriendshipStatus(
        validUserId,
        data.friendship_status || { is_restricted: false }
      )
    };
  }

  /**
   * Mutes feed posts and/or stories from a followed user.
   *
   * @param {string|number} userId
   * @param {Object} [options]
   * @param {boolean} [options.posts=true]
   * @param {boolean} [options.stories=false]
   * @returns {Promise<{success: boolean, userId: string, friendshipStatus: Object}>}
   */
  async muteUserMedia(userId, options = {}) {
    const validUserId = validateUserId(userId);
    const csrfToken = this.session && typeof this.session.getCsrfToken === 'function'
      ? this.session.getCsrfToken()
      : '';

    const mutePosts = options.posts !== undefined ? Boolean(options.posts) : true;
    const muteStories = Boolean(options.stories);

    const payload = new URLSearchParams();
    if (mutePosts) payload.append('target_posts_author_id', validUserId);
    if (muteStories) payload.append('target_reel_author_id', validUserId);
    if (csrfToken) payload.append('_csrftoken', csrfToken);

    const response = await this.transport.post(
      Endpoints.FRIENDSHIP_MUTE_MEDIA,
      payload.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      false
    );

    const data = response.data || {};
    if (data.status && data.status !== 'ok') {
      throw new InstaChatError(data.message || `Failed to mute user ${validUserId}`, { details: data });
    }

    return {
      success: true,
      userId: validUserId,
      friendshipStatus: this._normalizeFriendshipStatus(
        validUserId,
        data.friendship_status || { muting: true }
      )
    };
  }

  /**
   * Unmutes feed posts and/or stories from a followed user.
   *
   * @param {string|number} userId
   * @param {Object} [options]
   * @param {boolean} [options.posts=true]
   * @param {boolean} [options.stories=false]
   * @returns {Promise<{success: boolean, userId: string, friendshipStatus: Object}>}
   */
  async unmuteUserMedia(userId, options = {}) {
    const validUserId = validateUserId(userId);
    const csrfToken = this.session && typeof this.session.getCsrfToken === 'function'
      ? this.session.getCsrfToken()
      : '';

    const unmutePosts = options.posts !== undefined ? Boolean(options.posts) : true;
    const unmuteStories = Boolean(options.stories);

    const payload = new URLSearchParams();
    if (unmutePosts) payload.append('target_posts_author_id', validUserId);
    if (unmuteStories) payload.append('target_reel_author_id', validUserId);
    if (csrfToken) payload.append('_csrftoken', csrfToken);

    const response = await this.transport.post(
      Endpoints.FRIENDSHIP_UNMUTE_MEDIA,
      payload.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      false
    );

    const data = response.data || {};
    if (data.status && data.status !== 'ok') {
      throw new InstaChatError(data.message || `Failed to unmute user ${validUserId}`, { details: data });
    }

    return {
      success: true,
      userId: validUserId,
      friendshipStatus: this._normalizeFriendshipStatus(
        validUserId,
        data.friendship_status || { muting: false }
      )
    };
  }
}

module.exports = UsersService;
