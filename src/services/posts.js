'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const Endpoints = require('../constants/endpoints');
const Post = require('../models/post');
const User = require('../models/user');
const SharingService = require('./sharing');
const {
  validateUserId,
  validateMediaFile,
  validateCaption,
  validateCommentText,
  validateReactionEmoji
} = require('../utils/validators');
const {
  ValidationError,
  NotFoundError,
  AuthenticationError,
  RateLimitError,
  UnsupportedFeatureError,
  InstaChatError
} = require('../utils/errors');

const MOBILE_APP_ID = '567067343352427';
const MOBILE_USER_AGENT =
  'Instagram 449.0.0.52.84 Android (34/14; 480dpi; 1344x2992; Google/google; Pixel 8 Pro; husky; husky; en_US; 1079242191)';

const HEART_EMOJIS = new Set(['❤️', '❤', '♥️', '♥']);

/**
 * Safely collects a Readable stream or Buffer into a Buffer.
 *
 * @param {import('stream').Readable|Buffer} stream
 * @returns {Promise<Buffer|null>}
 */
async function streamToBuffer(stream) {
  if (Buffer.isBuffer(stream)) return stream;
  if (!stream) return null;
  if (typeof stream.pipe !== 'function' && !stream[Symbol.asyncIterator]) return null;

  const chunks = [];
  if (stream[Symbol.asyncIterator]) {
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
  } else {
    await new Promise((resolve, reject) => {
      stream.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      stream.once('end', resolve);
      stream.once('error', reject);
    });
  }
  return Buffer.concat(chunks);
}

/**
 * Extracts width and height from a JPEG or PNG Buffer without external dependencies.
 * Falls back to 1080x1080 if format headers are unrecognized.
 *
 * @param {Buffer} buffer
 * @returns {{width: number, height: number}}
 */
function getImageDimensions(buffer) {
  const fallback = { width: 1080, height: 1080 };
  if (!Buffer.isBuffer(buffer) || buffer.length < 11) {
    return fallback;
  }

  // PNG: 8-byte signature + IHDR chunk (width @ 16, height @ 20)
  if (
    buffer.length >= 24 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4E &&
    buffer[3] === 0x47
  ) {
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    if (width > 0 && height > 0) {
      return { width, height };
    }
    return fallback;
  }

  // JPEG: SOI (0xFF 0xD8), scan markers for SOF0..SOF3/SOF5..SOF7/SOF9..SOF11/SOF13..SOF15
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) {
    let offset = 2;
    while (offset + 4 < buffer.length) {
      if (buffer[offset] !== 0xFF) {
        offset++;
        continue;
      }
      while (offset < buffer.length && buffer[offset] === 0xFF) {
        offset++;
      }
      if (offset >= buffer.length) break;

      const marker = buffer[offset];
      offset++;

      // Standalone markers without length
      if (marker === 0xD8 || marker === 0xD9 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) {
        continue;
      }
      if (offset + 2 > buffer.length) break;
      const segLength = buffer.readUInt16BE(offset);
      if (segLength < 2 || offset + segLength > buffer.length) break;

      const isSof =
        (marker >= 0xC0 && marker <= 0xC3) ||
        (marker >= 0xC5 && marker <= 0xC7) ||
        (marker >= 0xC9 && marker <= 0xCB) ||
        (marker >= 0xCD && marker <= 0xCF);

      if (isSof && offset + 7 <= buffer.length) {
        const height = buffer.readUInt16BE(offset + 3);
        const width = buffer.readUInt16BE(offset + 5);
        if (width > 0 && height > 0) {
          return { width, height };
        }
        return fallback;
      }

      offset += segLength;
    }
  }

  return fallback;
}

/**
 * Resolves a numeric media ID, composite ID, shortcode, or Instagram post/reel URL
 * into its underlying numeric media PK plus optional shortcode & kind hint.
 *
 * @param {string|number|Object} mediaIdOrUrl
 * @returns {{mediaId: string, fullId: string|null, shortcode: string|null, detectedKind: 'reel'|'post'}}
 */
function parseMediaReference(mediaIdOrUrl) {
  if (mediaIdOrUrl && typeof mediaIdOrUrl === 'object') {
    const candidate = mediaIdOrUrl.pk || mediaIdOrUrl.id || mediaIdOrUrl.code || mediaIdOrUrl.url;
    const parsed = parseMediaReference(candidate);
    return {
      mediaId: parsed.mediaId,
      fullId: mediaIdOrUrl.id ? String(mediaIdOrUrl.id) : parsed.fullId,
      shortcode: mediaIdOrUrl.code || mediaIdOrUrl.shortcode || parsed.shortcode,
      detectedKind: mediaIdOrUrl.isReel ? 'reel' : parsed.detectedKind
    };
  }

  const raw = mediaIdOrUrl === undefined || mediaIdOrUrl === null ? '' : String(mediaIdOrUrl).trim();
  const mediaId = SharingService.resolveMediaId(mediaIdOrUrl);

  let shortcode = null;
  let detectedKind = 'post';
  let fullId = null;

  if (/^\d+_\d+$/.test(raw)) {
    fullId = raw;
  } else {
    const urlMatch = raw.match(/instagram\.com\/(?:[^/]+\/)?(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
    if (urlMatch) {
      const seg = urlMatch[1].toLowerCase();
      detectedKind = seg === 'reel' || seg === 'reels' ? 'reel' : 'post';
      shortcode = urlMatch[2];
    } else if (!/^\d+$/.test(raw) && /^[A-Za-z0-9_-]{5,24}$/.test(raw)) {
      shortcode = raw;
    }
  }

  return { mediaId, fullId, shortcode, detectedKind };
}

/**
 * Service for Instagram Feed Posts, Carousels, Reels, Post/Reel/Story Reactions, Comments & Saves.
 */
class PostsService {
  /**
   * @param {Object} options
   * @param {import('../transport/http')} options.transport
   * @param {import('../auth/session')} options.session
   * @param {import('../utils/logger').Logger} [options.logger]
   * @param {import('./users')} [options.usersService]
   * @param {import('./reactions')} [options.reactionsService]
   */
  constructor(options = {}) {
    this.transport = options.transport;
    this.session = options.session;
    this.logger = options.logger;
    this.usersService = options.usersService || null;
    this.reactionsService = options.reactionsService || null;
    this._deviceId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
    this._phoneId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
    this._lastUploadTs = 0;
  }

  _getCsrfToken() {
    return this.session && typeof this.session.getCsrfToken === 'function'
      ? this.session.getCsrfToken()
      : '';
  }

  _generateUploadId() {
    let now = Date.now();
    if (now <= this._lastUploadTs) {
      now = this._lastUploadTs + 1;
    }
    this._lastUploadTs = now;
    return String(now);
  }

  _generateUuid() {
    return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
  }

  /**
   * Builds mobile private API headers including the Bearer IGT:2 token derived from session cookies.
   *
   * @private
   * @param {Object} [extraHeaders={}]
   * @returns {Object}
   */
  _buildMobileHeaders(extraHeaders = {}) {
    const cookies = (this.session && this.session.cookies) || {};
    const rawSessionId = cookies.sessionid ? String(cookies.sessionid) : '';
    const decodedSessionId = rawSessionId ? decodeURIComponent(rawSessionId) : '';
    const userId = String(
      (this.session && this.session.userId) ||
        cookies.ds_user_id ||
        (decodedSessionId ? decodedSessionId.split(':')[0] : '') ||
        '0'
    );
    const androidId =
      'android-' + crypto.createHash('sha256').update(userId).digest('hex').slice(0, 16);

    const headers = {
      'User-Agent': MOBILE_USER_AGENT,
      'x-ig-app-id': MOBILE_APP_ID,
      'X-IG-App-ID': MOBILE_APP_ID,
      'X-IG-Device-ID': this._deviceId,
      'X-IG-Family-Device-ID': this._phoneId,
      'X-IG-Android-ID': androidId,
      'X-IG-Capabilities': '3brTv10=',
      'X-IG-Connection-Type': 'WIFI',
      'IG-INTENDED-USER-ID': userId,
      'IG-U-DS-USER-ID': userId
    };

    if (decodedSessionId) {
      const authData = {
        ds_user_id: userId,
        sessionid: decodedSessionId,
        should_use_header_over_cookies: true
      };
      headers.Authorization = `Bearer IGT:2:${Buffer.from(JSON.stringify(authData)).toString('base64')}`;
    }

    return { ...headers, ...extraHeaders };
  }

  /**
   * Resolves a user ID or @username via UsersService when available.
   *
   * @private
   */
  async _resolveUserId(userIdOrUsername) {
    if (this.usersService && typeof this.usersService.resolveTargetUser === 'function') {
      return this.usersService.resolveTargetUser(userIdOrUsername);
    }
    return { userId: validateUserId(userIdOrUsername), username: null };
  }

  /**
   * Loads image or video bytes from a local file path, HTTP(S) URL, Buffer, or Readable stream.
   *
   * @private
   * @param {string|Buffer|import('stream').Readable} fileInput
   * @param {'image'|'video'} kind
   * @param {Object} [options]
   * @returns {Promise<{buffer: Buffer, fileName: string, mimeType: string}>}
   */
  async _loadMediaBuffer(fileInput, kind = 'image', options = {}) {
    if (!fileInput) {
      throw new ValidationError(`${kind} input (file path, URL, Buffer, or Stream) is required.`, {
        field: kind === 'video' ? 'videoInput' : 'fileInput'
      });
    }

    let buffer;
    let fileName = options.fileName || (kind === 'video' ? `reel_${Date.now()}.mp4` : `post_${Date.now()}.jpg`);
    let mimeType = options.mimeType || (kind === 'video' ? 'video/mp4' : 'image/jpeg');

    if (typeof fileInput === 'string' && (fileInput.startsWith('http://') || fileInput.startsWith('https://'))) {
      const res = await axios.get(fileInput, {
        responseType: 'arraybuffer',
        timeout: options.downloadTimeoutMs || (kind === 'video' ? 60000 : 30000),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      buffer = Buffer.from(res.data);
      const ct = (res.headers && res.headers['content-type']) || '';
      if (kind === 'image') {
        if (ct.includes('png')) mimeType = 'image/png';
        else mimeType = 'image/jpeg';
      } else if (ct.includes('quicktime')) {
        mimeType = 'video/quicktime';
      }
    } else if (fileInput && (typeof fileInput.pipe === 'function' || fileInput[Symbol.asyncIterator])) {
      buffer = await streamToBuffer(fileInput);
      if (fileInput.path && typeof fileInput.path === 'string' && !options.fileName) {
        fileName = path.basename(fileInput.path);
      }
    } else if (Buffer.isBuffer(fileInput)) {
      buffer = fileInput;
    } else {
      const validated = validateMediaFile(fileInput, kind);
      buffer = fs.readFileSync(validated.filePath);
      fileName = validated.fileName;
      if (kind === 'image') {
        mimeType = validated.extension === '.png' ? 'image/png' : 'image/jpeg';
      } else {
        mimeType = validated.extension === '.mov' ? 'video/quicktime' : 'video/mp4';
      }
    }

    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw new ValidationError(`Provided ${kind} payload is empty.`, {
        field: kind === 'video' ? 'videoInput' : 'fileInput'
      });
    }

    // Magic-byte detection for images
    if (kind === 'image' && !options.mimeType && buffer.length >= 4) {
      if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
        mimeType = 'image/png';
      } else if (buffer[0] === 0xFF && buffer[1] === 0xD8) {
        mimeType = 'image/jpeg';
      }
    }

    return { buffer, fileName, mimeType };
  }

  /**
   * Uploads a feed/carousel/cover photo binary via Instagram's rupload_igphoto pipeline.
   *
   * @private
   * @param {Buffer} buffer
   * @param {Object} [options]
   * @returns {Promise<{uploadId: string, width: number, height: number}>}
   */
  async _uploadFeedPhoto(buffer, options = {}) {
    const uploadId = options.uploadId || this._generateUploadId();
    const dims = getImageDimensions(buffer);
    const width = Number(options.width) || dims.width;
    const height = Number(options.height) || dims.height;
    const mimeType = options.mimeType || 'image/jpeg';

    const ruploadParamsObj = {
      media_type: 1,
      upload_id: uploadId,
      upload_media_height: height,
      upload_media_width: width
    };
    if (options.isSidecar) {
      ruploadParamsObj.is_sidecar = '1';
    }
    if (options.isClipsCover) {
      ruploadParamsObj.is_clips_video = '1';
    }

    const ruploadParams = JSON.stringify(ruploadParamsObj);
    const entityName = `fb_uploader_${uploadId}`;

    const attempts = [
      {
        url: Endpoints.RUPLOAD_FEED_PHOTO(uploadId),
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Entity-Type': mimeType,
          'X-Entity-Name': entityName,
          'X-Entity-Length': String(buffer.length),
          Offset: '0',
          'X-Instagram-Rupload-Params': ruploadParams,
          Referer: `${Endpoints.BASE_URL}/`
        }
      },
      {
        url: Endpoints.RUPLOAD_FEED_PHOTO_RUPLOAD(uploadId),
        headers: this._buildMobileHeaders({
          'Content-Type': 'application/octet-stream',
          'X-Entity-Type': mimeType,
          'X-Entity-Name': `${uploadId}_0_${Math.floor(Math.random() * 9000000000 + 1000000000)}`,
          'X-Entity-Length': String(buffer.length),
          Offset: '0',
          'X-Instagram-Rupload-Params': ruploadParams
        })
      }
    ];

    let response = null;
    let lastError = null;

    for (let i = 0; i < attempts.length; i++) {
      try {
        response = await this.transport.post(
          attempts[i].url,
          buffer,
          { headers: attempts[i].headers },
          false
        );
        if (response && response.data && response.data.status === 'fail') {
          throw new InstaChatError(response.data.message || 'Photo rupload returned status: fail', {
            details: response.data
          });
        }
        break;
      } catch (err) {
        if (err instanceof AuthenticationError || err instanceof RateLimitError) {
          throw err;
        }
        lastError = err;
        if (this.logger && typeof this.logger.debug === 'function') {
          this.logger.debug(`Feed photo upload attempt ${i + 1} failed: ${err.message}`);
        }
      }
    }

    if (!response) {
      throw lastError || new InstaChatError('Failed to upload photo to Instagram rupload.');
    }

    const returnedUploadId = (response.data && response.data.upload_id)
      ? String(response.data.upload_id)
      : uploadId;

    return { uploadId: returnedUploadId, width, height };
  }

  // =========================================================================
  // 1. Publishing & Managing Posts / Carousels / Reels
  // =========================================================================

  /**
   * Publishes a photo post to the authenticated user's Instagram feed.
   * Accepts a local image file path (JPEG/PNG), HTTP(S) URL, Buffer, or Readable stream.
   *
   * @param {string|Buffer|import('stream').Readable} fileInput
   * @param {Object} [options]
   * @param {string} [options.caption=''] - Post caption (up to 2200 characters)
   * @param {string} [options.altText] - Custom accessibility alt text
   * @param {boolean} [options.disableComments=false]
   * @param {boolean} [options.hideLikeAndViewCounts=false]
   * @param {Object} [options.location] - Optional Instagram location object
   * @param {Array<{userId: string|number, position?: [number, number]}>} [options.usertags]
   * @returns {Promise<Post>}
   */
  async createPost(fileInput, options = {}) {
    const caption = validateCaption(options.caption || '');
    const { buffer, mimeType } = await this._loadMediaBuffer(fileInput, 'image', options);
    const { uploadId, width, height } = await this._uploadFeedPhoto(buffer, { ...options, mimeType });

    const csrfToken = this._getCsrfToken();
    const deviceTimestamp = String(Math.floor(Date.now() / 1000));

    const payload = new URLSearchParams();
    payload.append('source_type', 'library');
    payload.append('caption', caption);
    payload.append('upload_id', uploadId);
    payload.append('device_timestamp', deviceTimestamp);
    payload.append('disable_comments', options.disableComments ? '1' : '0');
    payload.append('like_and_view_counts_disabled', options.hideLikeAndViewCounts ? '1' : '0');
    payload.append('igtv_share_preview_to_feed', '1');
    payload.append('is_unified_video', '1');
    payload.append('video_subtitles_enabled', '0');
    if (options.altText) {
      payload.append('custom_accessibility_caption', String(options.altText));
    }
    if (options.location) {
      payload.append('location', typeof options.location === 'string' ? options.location : JSON.stringify(options.location));
    }
    if (Array.isArray(options.usertags) && options.usertags.length > 0) {
      const normalizedTags = {
        in: options.usertags.map((tag) => ({
          user_id: String(tag.userId || tag.user_id || tag.id),
          position: Array.isArray(tag.position) && tag.position.length === 2 ? tag.position : [0.5, 0.5]
        }))
      };
      payload.append('usertags', JSON.stringify(normalizedTags));
    }
    if (csrfToken) payload.append('_csrftoken', csrfToken);

    const bodyStr = payload.toString();

    const attempts = [
      {
        url: Endpoints.MEDIA_CONFIGURE,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: `${Endpoints.BASE_URL}/`
        }
      },
      {
        url: Endpoints.MEDIA_CONFIGURE_MOBILE,
        headers: this._buildMobileHeaders({
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
        })
      }
    ];

    let response = null;
    let lastError = null;
    for (let i = 0; i < attempts.length; i++) {
      try {
        response = await this.transport.post(
          attempts[i].url,
          bodyStr,
          { headers: attempts[i].headers },
          false
        );
        break;
      } catch (err) {
        if (err instanceof AuthenticationError || err instanceof RateLimitError) {
          throw err;
        }
        lastError = err;
        if (this.logger && typeof this.logger.debug === 'function') {
          this.logger.debug(`createPost configure attempt ${i + 1} failed: ${err.message}`);
        }
      }
    }

    if (!response) {
      throw lastError || new InstaChatError('Failed to configure and publish Instagram post.');
    }

    const data = response.data || {};
    if (data.status && data.status !== 'ok') {
      throw new InstaChatError(data.message || 'Failed to publish Instagram post.', { details: data });
    }

    const media = data.media || {
      pk: data.upload_id || uploadId,
      id: data.upload_id || uploadId,
      media_type: 1,
      caption: { text: caption },
      original_width: width,
      original_height: height,
      taken_at: Number(deviceTimestamp)
    };

    return Post.fromRaw(media);
  }

  /**
   * Alias for createPost().
   */
  async postPhoto(fileInput, options = {}) {
    return this.createPost(fileInput, options);
  }

  /**
   * Publishes a multi-photo carousel (album) post with 2 to 10 images.
   *
   * @param {Array<string|Buffer|import('stream').Readable|{file: any, altText?: string}>} fileInputs
   * @param {Object} [options]
   * @param {string} [options.caption='']
   * @param {boolean} [options.disableComments=false]
   * @param {boolean} [options.hideLikeAndViewCounts=false]
   * @returns {Promise<Post>}
   */
  async createCarouselPost(fileInputs, options = {}) {
    if (!Array.isArray(fileInputs) || fileInputs.length < 2 || fileInputs.length > 10) {
      throw new ValidationError('Carousel post requires an array of between 2 and 10 media items.', {
        field: 'fileInputs'
      });
    }

    const caption = validateCaption(options.caption || '');
    const childrenMetadata = [];

    for (let i = 0; i < fileInputs.length; i++) {
      const item = fileInputs[i];
      const isObj = item && typeof item === 'object' && !Buffer.isBuffer(item) && typeof item.pipe !== 'function' && !item[Symbol.asyncIterator];
      const rawFile = isObj ? (item.file || item.image || item.url) : item;
      const itemAlt = isObj && item.altText ? String(item.altText) : null;

      const { buffer, mimeType } = await this._loadMediaBuffer(rawFile, 'image', options);
      const { uploadId, width, height } = await this._uploadFeedPhoto(buffer, {
        ...options,
        mimeType,
        isSidecar: true
      });

      const child = {
        upload_id: uploadId,
        source_type: 'library',
        edits: {
          crop_original_size: [width, height],
          crop_center: [0.0, 0.0],
          crop_zoom: 1.0
        }
      };
      if (itemAlt) {
        child.custom_accessibility_caption = itemAlt;
      }
      childrenMetadata.push(child);
    }

    const csrfToken = this._getCsrfToken();
    const sidecarId = this._generateUploadId();
    const deviceTimestamp = String(Math.floor(Date.now() / 1000));

    const jsonBody = {
      caption,
      client_sidecar_id: sidecarId,
      device_timestamp: deviceTimestamp,
      source_type: 'library',
      disable_comments: options.disableComments ? '1' : '0',
      like_and_view_counts_disabled: options.hideLikeAndViewCounts ? '1' : '0',
      children_metadata: childrenMetadata
    };

    const attempts = [
      {
        url: Endpoints.MEDIA_CONFIGURE_SIDECAR,
        data: jsonBody,
        headers: {
          'Content-Type': 'application/json',
          Referer: `${Endpoints.BASE_URL}/`
        }
      },
      {
        url: Endpoints.MEDIA_CONFIGURE_SIDECAR_MOBILE,
        data: new URLSearchParams({
          signed_body: `SIGNATURE.${JSON.stringify(jsonBody)}`,
          ...(csrfToken ? { _csrftoken: csrfToken } : {})
        }).toString(),
        headers: this._buildMobileHeaders({
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
        })
      }
    ];

    let response = null;
    let lastError = null;
    for (let i = 0; i < attempts.length; i++) {
      try {
        response = await this.transport.post(
          attempts[i].url,
          attempts[i].data,
          { headers: attempts[i].headers },
          false
        );
        break;
      } catch (err) {
        if (err instanceof AuthenticationError || err instanceof RateLimitError) {
          throw err;
        }
        lastError = err;
        if (this.logger && typeof this.logger.debug === 'function') {
          this.logger.debug(`createCarouselPost configure attempt ${i + 1} failed: ${err.message}`);
        }
      }
    }

    if (!response) {
      throw lastError || new InstaChatError('Failed to configure and publish Instagram carousel post.');
    }

    const data = response.data || {};
    if (data.status && data.status !== 'ok') {
      throw new InstaChatError(data.message || 'Failed to publish carousel post.', { details: data });
    }

    const media = data.media || {
      pk: sidecarId,
      id: sidecarId,
      media_type: 8,
      product_type: 'carousel_container',
      caption: { text: caption },
      taken_at: Number(deviceTimestamp)
    };

    return Post.fromRaw(media);
  }

  /**
   * Alias for createCarouselPost().
   */
  async postCarousel(fileInputs, options = {}) {
    return this.createCarouselPost(fileInputs, options);
  }

  /**
   * Publishes a video as an Instagram Reel.
   *
   * @param {string|Buffer|import('stream').Readable} videoInput - Local MP4/MOV path, URL, Buffer, or Stream
   * @param {Object} [options]
   * @param {string} [options.caption='']
   * @param {string|Buffer|import('stream').Readable} [options.coverImage] - Optional thumbnail image
   * @param {boolean} [options.shareToFeed=true] - Show Reel preview on profile grid
   * @param {boolean} [options.audioMuted=false]
   * @param {boolean} [options.disableComments=false]
   * @param {boolean} [options.hideLikeAndViewCounts=false]
   * @param {number} [options.width=1080]
   * @param {number} [options.height=1920]
   * @param {number} [options.durationMs=15000]
   * @returns {Promise<Post>}
   */
  async createReel(videoInput, options = {}) {
    const caption = validateCaption(options.caption || '');
    const { buffer: videoBuffer, fileName, mimeType } = await this._loadMediaBuffer(videoInput, 'video', options);

    const uploadId = this._generateUploadId();
    const width = Number(options.width) || 1080;
    const height = Number(options.height) || 1920;
    const durationMs = Number(options.durationMs) || 15000;

    const ruploadParams = JSON.stringify({
      is_clips_video: '1',
      media_type: 2,
      upload_id: uploadId,
      upload_media_width: width,
      upload_media_height: height,
      upload_media_duration_ms: durationMs,
      xsharing_user_ids: '[]'
    });

    const uploadResponse = await this.transport.post(
      Endpoints.RUPLOAD_VIDEO(uploadId),
      videoBuffer,
      {
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Entity-Type': mimeType,
          'X-Entity-Name': fileName,
          'X-Entity-Length': String(videoBuffer.length),
          Offset: '0',
          'X-Instagram-Rupload-Params': ruploadParams
        }
      },
      false
    );

    if (uploadResponse && uploadResponse.data && uploadResponse.data.status === 'fail') {
      throw new InstaChatError(uploadResponse.data.message || 'Reel video upload failed.', {
        details: uploadResponse.data
      });
    }

    // Optional cover image upload bound to the same upload_id
    if (options.coverImage) {
      const cover = await this._loadMediaBuffer(options.coverImage, 'image', options);
      await this._uploadFeedPhoto(cover.buffer, {
        uploadId,
        mimeType: cover.mimeType,
        isClipsCover: true
      });
    }

    const csrfToken = this._getCsrfToken();
    const deviceTimestamp = String(Math.floor(Date.now() / 1000));
    const shareToFeed = options.shareToFeed !== false;

    const configObj = {
      upload_id: uploadId,
      caption,
      source_type: 'library',
      device_timestamp: deviceTimestamp,
      clips_share_preview_to_feed: shareToFeed ? '1' : '0',
      audio_muted: Boolean(options.audioMuted),
      disable_comments: options.disableComments ? '1' : '0',
      like_and_view_counts_disabled: options.hideLikeAndViewCounts ? '1' : '0',
      poster_frame_index: 0
    };

    const formPayload = new URLSearchParams();
    for (const [key, val] of Object.entries(configObj)) {
      formPayload.append(key, String(val));
    }
    if (csrfToken) formPayload.append('_csrftoken', csrfToken);

    const attempts = [
      {
        url: `${Endpoints.MEDIA_CONFIGURE_CLIPS}?video=1`,
        data: formPayload.toString(),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: `${Endpoints.BASE_URL}/`
        }
      },
      {
        url: `${Endpoints.MEDIA_CONFIGURE_CLIPS_MOBILE}?video=1`,
        data: new URLSearchParams({
          signed_body: `SIGNATURE.${JSON.stringify(configObj)}`,
          ...(csrfToken ? { _csrftoken: csrfToken } : {})
        }).toString(),
        headers: this._buildMobileHeaders({
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
        })
      }
    ];

    let response = null;
    let lastError = null;
    for (let i = 0; i < attempts.length; i++) {
      try {
        response = await this.transport.post(
          attempts[i].url,
          attempts[i].data,
          { headers: attempts[i].headers },
          false
        );
        break;
      } catch (err) {
        if (err instanceof AuthenticationError || err instanceof RateLimitError) {
          throw err;
        }
        lastError = err;
        if (this.logger && typeof this.logger.debug === 'function') {
          this.logger.debug(`createReel configure attempt ${i + 1} failed: ${err.message}`);
        }
      }
    }

    if (!response) {
      throw lastError || new InstaChatError('Failed to configure and publish Instagram Reel.');
    }

    const data = response.data || {};
    if (data.status && data.status !== 'ok') {
      throw new InstaChatError(data.message || 'Failed to publish Instagram Reel.', { details: data });
    }

    const media = data.media || {
      pk: uploadId,
      id: uploadId,
      media_type: 2,
      product_type: 'clips',
      caption: { text: caption },
      original_width: width,
      original_height: height,
      taken_at: Number(deviceTimestamp)
    };

    return Post.fromRaw(media);
  }

  /**
   * Alias for createReel().
   */
  async postReel(videoInput, options = {}) {
    return this.createReel(videoInput, options);
  }

  /**
   * Deletes a post or Reel owned by the authenticated account.
   *
   * @param {string|number|Object} mediaIdOrUrl - Media ID, shortcode, URL, or Post instance
   * @param {Object} [options]
   * @param {'PHOTO'|'VIDEO'|'CAROUSEL'} [options.mediaType='PHOTO']
   * @returns {Promise<{success: boolean, mediaId: string, deleted: boolean}>}
   */
  async deletePost(mediaIdOrUrl, options = {}) {
    const { mediaId, detectedKind } = parseMediaReference(mediaIdOrUrl);
    const csrfToken = this._getCsrfToken();
    const mediaType = options.mediaType
      ? String(options.mediaType).toUpperCase()
      : (detectedKind === 'reel' ? 'VIDEO' : 'PHOTO');

    const payload = new URLSearchParams();
    payload.append('media_id', mediaId);
    payload.append('media_type', mediaType);
    if (csrfToken) payload.append('_csrftoken', csrfToken);
    const bodyStr = payload.toString();

    const attempts = [
      {
        url: `${Endpoints.MEDIA_DELETE(mediaId)}?media_type=${encodeURIComponent(mediaType)}`,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: `${Endpoints.BASE_URL}/`
        }
      },
      {
        url: `${Endpoints.MEDIA_DELETE_MOBILE(mediaId)}?media_type=${encodeURIComponent(mediaType)}`,
        headers: this._buildMobileHeaders({
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
        })
      }
    ];

    let response = null;
    let lastError = null;
    for (let i = 0; i < attempts.length; i++) {
      try {
        response = await this.transport.post(
          attempts[i].url,
          bodyStr,
          { headers: attempts[i].headers },
          false
        );
        break;
      } catch (err) {
        if (err instanceof AuthenticationError || err instanceof RateLimitError || err instanceof NotFoundError) {
          throw err;
        }
        lastError = err;
      }
    }

    if (!response) {
      throw lastError || new InstaChatError(`Failed to delete media ${mediaId}`);
    }

    const data = response.data || {};
    if (data.status && data.status !== 'ok' && !data.did_delete) {
      throw new InstaChatError(data.message || `Failed to delete media ${mediaId}`, { details: data });
    }

    return {
      success: true,
      mediaId,
      deleted: data.did_delete !== undefined ? Boolean(data.did_delete) : true
    };
  }

  // =========================================================================
  // 2. Fetching Posts & Reels
  // =========================================================================

  /**
   * Fetches full details for a Post or Reel by numeric media ID, shortcode, or Instagram URL.
   *
   * @param {string|number|Object} mediaIdOrUrl
   * @returns {Promise<Post>}
   */
  async getPost(mediaIdOrUrl) {
    const { mediaId, shortcode, detectedKind } = parseMediaReference(mediaIdOrUrl);
    const referer = shortcode
      ? `${Endpoints.BASE_URL}/${detectedKind === 'reel' ? 'reel' : 'p'}/${shortcode}/`
      : `${Endpoints.BASE_URL}/`;

    let response;
    try {
      response = await this.transport.get(Endpoints.MEDIA_INFO(mediaId), {
        headers: { Referer: referer }
      });
    } catch (err) {
      if (err instanceof AuthenticationError || err instanceof RateLimitError || err instanceof NotFoundError) {
        throw err;
      }
      response = await this.transport.get(Endpoints.MEDIA_INFO_MOBILE(mediaId), {
        headers: this._buildMobileHeaders()
      });
    }

    const data = response.data || {};
    const rawItem =
      (Array.isArray(data.items) && data.items[0]) ||
      data.media ||
      data.item ||
      null;

    if (!rawItem) {
      throw new NotFoundError(`Instagram media "${mediaId}" was not found.`, { resourceId: mediaId });
    }

    return Post.fromRaw(rawItem);
  }

  /**
   * Alias for getPost() for Reels.
   *
   * @param {string|number|Object} reelIdOrUrl
   * @returns {Promise<Post>}
   */
  async getReel(reelIdOrUrl) {
    return this.getPost(reelIdOrUrl);
  }

  /**
   * Retrieves feed posts for a target user (by userId, @username, or profile URL) with pagination.
   *
   * @param {string|number|Object} userIdOrUsername
   * @param {Object} [options]
   * @param {number} [options.count=12]
   * @param {string} [options.maxId]
   * @returns {Promise<{posts: Post[], nextMaxId: string|null, hasMore: boolean}>}
   */
  async getUserPosts(userIdOrUsername, options = {}) {
    const { userId, username } = await this._resolveUserId(userIdOrUsername);
    const count = Math.min(Math.max(Number(options.count || options.limit) || 12, 1), 50);
    const params = { count };
    if (options.maxId || options.cursor) {
      params.max_id = String(options.maxId || options.cursor);
    }

    const referer = username ? `${Endpoints.BASE_URL}/${username}/` : `${Endpoints.BASE_URL}/`;
    let response;
    try {
      response = await this.transport.get(Endpoints.USER_FEED(userId), {
        params,
        headers: { Referer: referer }
      });
    } catch (err) {
      if (err instanceof AuthenticationError || err instanceof RateLimitError || err instanceof NotFoundError) {
        throw err;
      }
      response = await this.transport.get(Endpoints.USER_FEED_MOBILE(userId), {
        params,
        headers: this._buildMobileHeaders()
      });
    }

    const data = response.data || {};
    const rawItems = Array.isArray(data.items) ? data.items : [];

    return {
      posts: rawItems.map((item) => Post.fromRaw(item)).filter(Boolean),
      nextMaxId: data.next_max_id ? String(data.next_max_id) : null,
      hasMore: Boolean(data.more_available || data.next_max_id)
    };
  }

  /**
   * Retrieves Reels (clips) published by a target user (by userId, @username, or profile URL).
   *
   * @param {string|number|Object} userIdOrUsername
   * @param {Object} [options]
   * @param {number} [options.count=12]
   * @param {string} [options.maxId]
   * @returns {Promise<{reels: Post[], nextMaxId: string|null, hasMore: boolean}>}
   */
  async getUserReels(userIdOrUsername, options = {}) {
    const { userId, username } = await this._resolveUserId(userIdOrUsername);
    const pageSize = Math.min(Math.max(Number(options.count || options.pageSize || options.limit) || 12, 1), 50);
    const csrfToken = this._getCsrfToken();

    const payload = new URLSearchParams();
    payload.append('target_user_id', userId);
    payload.append('page_size', String(pageSize));
    payload.append('include_feed_video', 'true');
    if (options.maxId || options.cursor) {
      payload.append('max_id', String(options.maxId || options.cursor));
    }
    if (csrfToken) payload.append('_csrftoken', csrfToken);

    const referer = username ? `${Endpoints.BASE_URL}/${username}/reels/` : `${Endpoints.BASE_URL}/`;
    const bodyStr = payload.toString();

    let response;
    try {
      response = await this.transport.post(
        Endpoints.USER_CLIPS,
        bodyStr,
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Referer: referer
          }
        },
        true
      );
    } catch (err) {
      if (err instanceof AuthenticationError || err instanceof RateLimitError || err instanceof NotFoundError) {
        throw err;
      }
      response = await this.transport.post(
        Endpoints.USER_CLIPS_MOBILE,
        bodyStr,
        {
          headers: this._buildMobileHeaders({
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
          })
        },
        true
      );
    }

    const data = response.data || {};
    const rawItems = Array.isArray(data.items) ? data.items : [];
    const paging = data.paging_info || {};

    const reels = rawItems
      .map((entry) => {
        const rawMedia = entry && entry.media ? entry.media : entry;
        if (!rawMedia) return null;
        return Post.fromRaw({ product_type: 'clips', ...rawMedia });
      })
      .filter(Boolean);

    return {
      reels,
      nextMaxId: paging.max_id ? String(paging.max_id) : (data.next_max_id ? String(data.next_max_id) : null),
      hasMore: Boolean(paging.more_available || data.more_available)
    };
  }

  // =========================================================================
  // 3. Post & Reel Reactions (Like / Unlike / Emoji React)
  // =========================================================================

  /**
   * Executes a multi-tier resilient Like or Unlike mutation for a Post or Reel.
   *
   * @private
   * @param {string|number|Object} mediaIdOrUrl
   * @param {boolean} liked - true to like, false to unlike
   * @param {'post'|'reel'} kind
   * @param {Object} [options]
   */
  async _mutateMediaLike(mediaIdOrUrl, liked, kind = 'post', options = {}) {
    const { mediaId, shortcode, detectedKind } = parseMediaReference(mediaIdOrUrl);
    const resolvedKind = kind || detectedKind || 'post';
    const csrfToken = this._getCsrfToken();
    const uuid = this._generateUuid();

    const referer = shortcode
      ? `${Endpoints.BASE_URL}/${resolvedKind === 'reel' ? 'reel' : 'p'}/${shortcode}/`
      : `${Endpoints.BASE_URL}/`;
    const moduleName = options.moduleName || (resolvedKind === 'reel' ? 'clips_viewer_clips_tab' : 'profile');

    const v1Payload = new URLSearchParams();
    v1Payload.append('media_id', mediaId);
    v1Payload.append('module_name', moduleName);
    v1Payload.append('d', '0');
    if (csrfToken) v1Payload.append('_csrftoken', csrfToken);
    v1Payload.append('_uuid', uuid);
    const v1Body = v1Payload.toString();

    const mobileSignedObj = {
      media_id: mediaId,
      module_name: moduleName,
      d: '0',
      _uuid: uuid,
      _uid: (this.session && this.session.userId) ? String(this.session.userId) : ''
    };
    const mobilePayload = new URLSearchParams();
    mobilePayload.append('signed_body', `SIGNATURE.${JSON.stringify(mobileSignedObj)}`);
    if (csrfToken) mobilePayload.append('_csrftoken', csrfToken);

    const webUrl = liked ? Endpoints.WEB_MEDIA_LIKE(mediaId) : Endpoints.WEB_MEDIA_UNLIKE(mediaId);
    const mediaWebUrl = liked ? Endpoints.MEDIA_LIKE(mediaId) : Endpoints.MEDIA_UNLIKE(mediaId);
    const mobileUrl = liked ? Endpoints.MEDIA_LIKE_MOBILE(mediaId) : Endpoints.MEDIA_UNLIKE_MOBILE(mediaId);

    const attempts = [
      {
        url: webUrl,
        body: '',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: referer
        }
      },
      {
        url: mediaWebUrl,
        body: v1Body,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: referer
        }
      },
      {
        url: mobileUrl,
        body: mobilePayload.toString(),
        headers: this._buildMobileHeaders({
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
        })
      }
    ];

    let response = null;
    let lastError = null;
    for (let i = 0; i < attempts.length; i++) {
      const attempt = attempts[i];
      try {
        response = await this.transport.post(
          attempt.url,
          attempt.body,
          { headers: attempt.headers },
          false
        );
        break;
      } catch (err) {
        if (
          err instanceof AuthenticationError ||
          err instanceof RateLimitError ||
          err instanceof NotFoundError
        ) {
          throw err;
        }
        lastError = err;
        if (this.logger && typeof this.logger.debug === 'function') {
          this.logger.debug(`${liked ? 'Like' : 'Unlike'} ${resolvedKind} attempt ${i + 1} failed: ${err.message}`);
        }
      }
    }

    if (!response) {
      throw lastError || new InstaChatError(`Failed to ${liked ? 'like' : 'unlike'} ${resolvedKind} ${mediaId}`);
    }

    const data = response.data || {};
    if (data.status && data.status !== 'ok') {
      throw new InstaChatError(
        data.message || `Failed to ${liked ? 'like' : 'unlike'} ${resolvedKind} ${mediaId}`,
        { details: data }
      );
    }

    return {
      success: true,
      mediaId,
      shortcode,
      type: resolvedKind,
      action: liked ? 'like' : 'unlike',
      emoji: liked ? '❤️' : null,
      liked
    };
  }

  /**
   * Likes a feed post (by media ID, shortcode, URL, or Post instance).
   *
   * @param {string|number|Object} postIdOrUrl
   * @param {Object} [options]
   */
  async likePost(postIdOrUrl, options = {}) {
    return this._mutateMediaLike(postIdOrUrl, true, 'post', options);
  }

  /**
   * Unlikes a feed post (by media ID, shortcode, URL, or Post instance).
   *
   * @param {string|number|Object} postIdOrUrl
   * @param {Object} [options]
   */
  async unlikePost(postIdOrUrl, options = {}) {
    return this._mutateMediaLike(postIdOrUrl, false, 'post', options);
  }

  /**
   * Likes an Instagram Reel (by media ID, shortcode, Reel URL, or Post instance).
   *
   * @param {string|number|Object} reelIdOrUrl
   * @param {Object} [options]
   */
  async likeReel(reelIdOrUrl, options = {}) {
    return this._mutateMediaLike(reelIdOrUrl, true, 'reel', options);
  }

  /**
   * Unlikes an Instagram Reel (by media ID, shortcode, Reel URL, or Post instance).
   *
   * @param {string|number|Object} reelIdOrUrl
   * @param {Object} [options]
   */
  async unlikeReel(reelIdOrUrl, options = {}) {
    return this._mutateMediaLike(reelIdOrUrl, false, 'reel', options);
  }

  /**
   * Unified reaction handler for feed posts and Reels.
   *
   * @private
   */
  async _reactMedia(mediaIdOrUrl, emoji = '❤️', kind = 'post', options = {}) {
    const cleanEmoji = validateReactionEmoji(emoji);

    // 1. If reacting to a shared Post/Reel message inside a DM thread
    if (options.threadId && options.messageId) {
      if (!this.reactionsService) {
        throw new InstaChatError('ReactionsService is required to react to DM messages.', {
          code: 'SERVICE_UNAVAILABLE'
        });
      }
      const dmRes = await this.reactionsService.sendReaction(
        options.threadId,
        options.messageId,
        cleanEmoji,
        options
      );
      return {
        ...dmRes,
        type: kind,
        action: 'dm_reaction'
      };
    }

    const { mediaId, shortcode } = parseMediaReference(mediaIdOrUrl);

    // 2. Heart / Like reaction -> native Instagram Like API
    if (HEART_EMOJIS.has(cleanEmoji)) {
      return this._mutateMediaLike(mediaIdOrUrl, true, kind, options);
    }

    // 3. Explicit emoji comment mode (optionally paired with a heart like)
    if (options.asComment === true) {
      let liked = false;
      if (options.alsoLike !== false) {
        await this._mutateMediaLike(mediaIdOrUrl, true, kind, options);
        liked = true;
      }
      const comment = await this.commentOnPost(mediaIdOrUrl, cleanEmoji, options);
      return {
        success: true,
        mediaId,
        shortcode,
        type: kind,
        action: 'emoji_comment',
        emoji: cleanEmoji,
        liked,
        commented: true,
        comment
      };
    }

    // 4. Optional fallback to heart like
    if (options.fallbackToLike === true) {
      const likeRes = await this._mutateMediaLike(mediaIdOrUrl, true, kind, options);
      return {
        ...likeRes,
        requestedEmoji: cleanEmoji,
        fallbackUsed: true
      };
    }

    throw new UnsupportedFeatureError(
      `Instagram public ${kind}s only natively support heart ("❤️" / "like") reactions. ` +
        `Pass '❤️' to like the ${kind}, pass { asComment: true } to post "${cleanEmoji}" as a comment, ` +
        `pass { threadId, messageId } to react to a ${kind} shared in a DM thread, or use reactStory() for Story emoji reactions.`,
      { feature: `${kind.toUpperCase()}_CUSTOM_EMOJI_REACTION` }
    );
  }

  /**
   * Unified unreact handler for feed posts and Reels.
   *
   * @private
   */
  async _unreactMedia(mediaIdOrUrl, kind = 'post', options = {}) {
    if (options.threadId && options.messageId) {
      if (!this.reactionsService) {
        throw new InstaChatError('ReactionsService is required to remove DM reactions.', {
          code: 'SERVICE_UNAVAILABLE'
        });
      }
      const dmRes = await this.reactionsService.deleteReaction(
        options.threadId,
        options.messageId,
        options.emoji || '❤️',
        options
      );
      return {
        ...dmRes,
        type: kind,
        action: 'dm_unreact'
      };
    }

    return this._mutateMediaLike(mediaIdOrUrl, false, kind, options);
  }

  /**
   * Reacts to a feed post: heart/like by default, DM emoji reaction when { threadId, messageId } is provided,
   * or emoji comment when { asComment: true } is passed.
   *
   * @param {string|number|Object} postIdOrUrl
   * @param {string} [emoji='❤️']
   * @param {Object} [options]
   */
  async reactPost(postIdOrUrl, emoji = '❤️', options = {}) {
    return this._reactMedia(postIdOrUrl, emoji, 'post', options);
  }

  /**
   * Removes your reaction/like from a feed post.
   *
   * @param {string|number|Object} postIdOrUrl
   * @param {Object} [options]
   */
  async unreactPost(postIdOrUrl, options = {}) {
    return this._unreactMedia(postIdOrUrl, 'post', options);
  }

  /**
   * Reacts to an Instagram Reel: heart/like by default, DM emoji reaction when { threadId, messageId } is provided,
   * or emoji comment when { asComment: true } is passed.
   *
   * @param {string|number|Object} reelIdOrUrl
   * @param {string} [emoji='❤️']
   * @param {Object} [options]
   */
  async reactReel(reelIdOrUrl, emoji = '❤️', options = {}) {
    return this._reactMedia(reelIdOrUrl, emoji, 'reel', options);
  }

  /**
   * Removes your reaction/like from an Instagram Reel.
   *
   * @param {string|number|Object} reelIdOrUrl
   * @param {Object} [options]
   */
  async unreactReel(reelIdOrUrl, options = {}) {
    return this._unreactMedia(reelIdOrUrl, 'reel', options);
  }

  // =========================================================================
  // 4. Story Likes & Emoji Quick Reactions
  // =========================================================================

  /**
   * Sends a native heart like to an Instagram Story item.
   *
   * @param {string|number} storyMediaId - Story media PK or composite {pk}_{ownerId}
   * @param {Object} [options]
   * @returns {Promise<{success: boolean, storyMediaId: string, liked: boolean, emoji: string}>}
   */
  async likeStory(storyMediaId, options = {}) {
    const { mediaId } = parseMediaReference(storyMediaId);
    const csrfToken = this._getCsrfToken();

    const payload = new URLSearchParams();
    payload.append('media_id', mediaId);
    payload.append('container_module', options.containerModule || 'reel_feed_timeline');
    if (csrfToken) payload.append('_csrftoken', csrfToken);
    const bodyStr = payload.toString();

    const attempts = [
      {
        url: Endpoints.STORY_LIKE_WEB,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: `${Endpoints.BASE_URL}/stories/`
        }
      },
      {
        url: Endpoints.STORY_LIKE,
        headers: this._buildMobileHeaders({
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
        })
      }
    ];

    let response = null;
    let lastError = null;
    for (let i = 0; i < attempts.length; i++) {
      try {
        response = await this.transport.post(
          attempts[i].url,
          bodyStr,
          { headers: attempts[i].headers },
          false
        );
        break;
      } catch (err) {
        if (err instanceof AuthenticationError || err instanceof RateLimitError || err instanceof NotFoundError) {
          throw err;
        }
        lastError = err;
      }
    }

    if (!response) {
      throw lastError || new InstaChatError(`Failed to like story ${mediaId}`);
    }

    const data = response.data || {};
    if (data.status && data.status !== 'ok') {
      throw new InstaChatError(data.message || `Failed to like story ${mediaId}`, { details: data });
    }

    return {
      success: true,
      storyMediaId: mediaId,
      liked: true,
      emoji: '❤️'
    };
  }

  /**
   * Removes a heart like from an Instagram Story item.
   *
   * @param {string|number} storyMediaId
   * @param {Object} [options]
   * @returns {Promise<{success: boolean, storyMediaId: string, liked: boolean}>}
   */
  async unlikeStory(storyMediaId, options = {}) {
    const { mediaId } = parseMediaReference(storyMediaId);
    const csrfToken = this._getCsrfToken();

    const payload = new URLSearchParams();
    payload.append('media_id', mediaId);
    payload.append('container_module', options.containerModule || 'reel_feed_timeline');
    if (csrfToken) payload.append('_csrftoken', csrfToken);
    const bodyStr = payload.toString();

    const attempts = [
      {
        url: Endpoints.STORY_UNLIKE_WEB,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: `${Endpoints.BASE_URL}/stories/`
        }
      },
      {
        url: Endpoints.STORY_UNLIKE,
        headers: this._buildMobileHeaders({
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
        })
      }
    ];

    let response = null;
    let lastError = null;
    for (let i = 0; i < attempts.length; i++) {
      try {
        response = await this.transport.post(
          attempts[i].url,
          bodyStr,
          { headers: attempts[i].headers },
          false
        );
        break;
      } catch (err) {
        if (err instanceof AuthenticationError || err instanceof RateLimitError || err instanceof NotFoundError) {
          throw err;
        }
        lastError = err;
      }
    }

    if (!response) {
      throw lastError || new InstaChatError(`Failed to unlike story ${mediaId}`);
    }

    const data = response.data || {};
    if (data.status && data.status !== 'ok') {
      throw new InstaChatError(data.message || `Failed to unlike story ${mediaId}`, { details: data });
    }

    return {
      success: true,
      storyMediaId: mediaId,
      liked: false
    };
  }

  /**
   * Reacts to an Instagram Story with a heart like (default) or quick emoji reaction (e.g. '🔥', '😂', '👏').
   *
   * @param {string|number} storyMediaId
   * @param {string} [emoji='❤️']
   * @param {Object} [options]
   * @param {string|number} [options.ownerId] - Story owner's user ID (or @username)
   * @param {string|number} [options.reelId] - Story reel ID (usually same as ownerId)
   * @param {string} [options.threadId] - Optional DM thread ID with the story owner
   * @param {boolean} [options.asDmReaction=false] - Force sending heart as a DM quick-reaction instead of story like
   */
  async reactStory(storyMediaId, emoji = '❤️', options = {}) {
    const cleanEmoji = validateReactionEmoji(emoji);

    if (HEART_EMOJIS.has(cleanEmoji) && !options.asDmReaction) {
      return this.likeStory(storyMediaId, options);
    }

    const { mediaId, fullId } = parseMediaReference(storyMediaId);
    let targetOwnerId = options.ownerId || options.reelId || options.recipientUserId || null;

    if (!targetOwnerId && fullId && fullId.includes('_')) {
      targetOwnerId = fullId.split('_')[1];
    }

    if (targetOwnerId && !/^\d+$/.test(String(targetOwnerId).trim())) {
      const resolved = await this._resolveUserId(targetOwnerId);
      targetOwnerId = resolved.userId;
    }

    if (!targetOwnerId && !options.threadId) {
      throw new ValidationError(
        'Story emoji reactions require options.ownerId (or composite "{mediaPk}_{ownerId}" storyMediaId) or options.threadId.',
        { field: 'ownerId' }
      );
    }

    const csrfToken = this._getCsrfToken();
    const clientContext = this._generateUuid();
    const reelId = String(options.reelId || targetOwnerId || '');

    const payload = new URLSearchParams();
    payload.append('action', 'send_item');
    payload.append('media_id', fullId || (targetOwnerId ? `${mediaId}_${targetOwnerId}` : mediaId));
    if (reelId) payload.append('reel_id', reelId);
    payload.append('entry', 'reel');
    payload.append('text', cleanEmoji);
    payload.append('reaction_emoji', cleanEmoji);
    payload.append('client_context', clientContext);
    payload.append('_uuid', clientContext);
    if (csrfToken) payload.append('_csrftoken', csrfToken);

    if (options.threadId) {
      payload.append('thread_ids', JSON.stringify([String(options.threadId)]));
    } else if (targetOwnerId) {
      payload.append('recipient_users', JSON.stringify([[String(targetOwnerId)]]));
    }

    const response = await this.transport.post(
      Endpoints.BROADCAST_REEL_SHARE,
      payload.toString(),
      {
        headers: this._buildMobileHeaders({
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
        })
      },
      false
    );

    const data = response.data || {};
    if (data.status && data.status !== 'ok') {
      throw new InstaChatError(data.message || `Failed to send emoji reaction to story ${mediaId}`, {
        details: data
      });
    }

    return {
      success: true,
      storyMediaId: mediaId,
      ownerId: targetOwnerId ? String(targetOwnerId) : null,
      action: 'story_emoji_reaction',
      emoji: cleanEmoji
    };
  }

  // =========================================================================
  // 5. Comments, Comment Likes, Likers & Saves
  // =========================================================================

  /**
   * Posts a comment (or reply to a comment) on a Post or Reel.
   *
   * @param {string|number|Object} mediaIdOrUrl
   * @param {string} text
   * @param {Object} [options]
   * @param {string|number} [options.replyToCommentId]
   * @returns {Promise<{success: boolean, mediaId: string, commentId: string|null, text: string, createdAt: Date, user: User|null, raw: Object}>}
   */
  async commentOnPost(mediaIdOrUrl, text, options = {}) {
    const { mediaId, shortcode, detectedKind } = parseMediaReference(mediaIdOrUrl);
    const validText = validateCommentText(text);
    const csrfToken = this._getCsrfToken();
    const uuid = this._generateUuid();
    const referer = shortcode
      ? `${Endpoints.BASE_URL}/${detectedKind === 'reel' ? 'reel' : 'p'}/${shortcode}/`
      : `${Endpoints.BASE_URL}/`;

    const payload = new URLSearchParams();
    payload.append('comment_text', validText);
    if (options.replyToCommentId) {
      payload.append('replied_to_comment_id', String(options.replyToCommentId).trim());
    }
    if (csrfToken) payload.append('_csrftoken', csrfToken);
    payload.append('_uuid', uuid);
    const bodyStr = payload.toString();

    const attempts = [
      {
        url: Endpoints.WEB_COMMENT_ADD(mediaId),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: referer
        }
      },
      {
        url: Endpoints.MEDIA_COMMENT_ADD_MOBILE(mediaId),
        headers: this._buildMobileHeaders({
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
        })
      }
    ];

    let response = null;
    let lastError = null;
    for (let i = 0; i < attempts.length; i++) {
      try {
        response = await this.transport.post(
          attempts[i].url,
          bodyStr,
          { headers: attempts[i].headers },
          false
        );
        break;
      } catch (err) {
        if (err instanceof AuthenticationError || err instanceof RateLimitError || err instanceof NotFoundError) {
          throw err;
        }
        lastError = err;
      }
    }

    if (!response) {
      throw lastError || new InstaChatError(`Failed to comment on media ${mediaId}`);
    }

    const data = response.data || {};
    if (data.status && data.status !== 'ok') {
      throw new InstaChatError(data.message || `Failed to comment on media ${mediaId}`, { details: data });
    }

    const rawComment = data.comment || data;
    const rawTs = Number(rawComment.created_time || rawComment.created_at || Math.floor(Date.now() / 1000));
    const tsMs = rawTs > 1e11 ? rawTs : rawTs * 1000;

    return {
      success: true,
      mediaId,
      commentId: rawComment.id || rawComment.pk ? String(rawComment.id || rawComment.pk) : null,
      text: rawComment.text || validText,
      createdAt: new Date(tsMs),
      user: rawComment.from || rawComment.user ? User.fromRaw(rawComment.from || rawComment.user) : null,
      raw: data
    };
  }

  /**
   * Alias for commentOnPost() on a Reel.
   */
  async commentOnReel(reelIdOrUrl, text, options = {}) {
    return this.commentOnPost(reelIdOrUrl, text, options);
  }

  /**
   * Deletes a comment from a Post or Reel.
   *
   * @param {string|number|Object} mediaIdOrUrl
   * @param {string|number} commentId
   */
  async deleteComment(mediaIdOrUrl, commentId) {
    const { mediaId } = parseMediaReference(mediaIdOrUrl);
    if (!commentId || !String(commentId).trim()) {
      throw new ValidationError('commentId must be a non-empty string or number.', { field: 'commentId' });
    }
    const cleanCommentId = String(commentId).trim();
    const csrfToken = this._getCsrfToken();

    const payload = new URLSearchParams();
    if (csrfToken) payload.append('_csrftoken', csrfToken);

    const response = await this.transport.post(
      Endpoints.WEB_COMMENT_DELETE(mediaId, cleanCommentId),
      payload.toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: `${Endpoints.BASE_URL}/`
        }
      },
      false
    );

    const data = response.data || {};
    if (data.status && data.status !== 'ok') {
      throw new InstaChatError(data.message || `Failed to delete comment ${cleanCommentId}`, { details: data });
    }

    return {
      success: true,
      mediaId,
      commentId: cleanCommentId,
      deleted: true
    };
  }

  /**
   * Likes a comment on a Post or Reel.
   *
   * @param {string|number} commentId
   */
  async likeComment(commentId) {
    if (!commentId || !String(commentId).trim()) {
      throw new ValidationError('commentId must be a non-empty string or number.', { field: 'commentId' });
    }
    const cleanId = String(commentId).trim();
    const response = await this.transport.post(
      Endpoints.WEB_COMMENT_LIKE(cleanId),
      '',
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: `${Endpoints.BASE_URL}/` } },
      false
    );

    const data = response.data || {};
    if (data.status && data.status !== 'ok') {
      throw new InstaChatError(data.message || `Failed to like comment ${cleanId}`, { details: data });
    }

    return { success: true, commentId: cleanId, liked: true };
  }

  /**
   * Unlikes a comment on a Post or Reel.
   *
   * @param {string|number} commentId
   */
  async unlikeComment(commentId) {
    if (!commentId || !String(commentId).trim()) {
      throw new ValidationError('commentId must be a non-empty string or number.', { field: 'commentId' });
    }
    const cleanId = String(commentId).trim();
    const response = await this.transport.post(
      Endpoints.WEB_COMMENT_UNLIKE(cleanId),
      '',
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: `${Endpoints.BASE_URL}/` } },
      false
    );

    const data = response.data || {};
    if (data.status && data.status !== 'ok') {
      throw new InstaChatError(data.message || `Failed to unlike comment ${cleanId}`, { details: data });
    }

    return { success: true, commentId: cleanId, liked: false };
  }

  /**
   * Fetches comments on a Post or Reel with cursor pagination.
   *
   * @param {string|number|Object} mediaIdOrUrl
   * @param {Object} [options]
   * @param {string} [options.minId] - Pagination cursor from previous response
   */
  async getPostComments(mediaIdOrUrl, options = {}) {
    const { mediaId } = parseMediaReference(mediaIdOrUrl);
    const params = { can_support_threading: 'true' };
    if (options.minId || options.cursor) {
      params.min_id = String(options.minId || options.cursor);
    }

    const response = await this.transport.get(Endpoints.MEDIA_COMMENTS(mediaId), { params });
    const data = response.data || {};
    const rawComments = Array.isArray(data.comments) ? data.comments : [];

    const comments = rawComments.map((c) => {
      const ts = Number(c.created_at_utc || c.created_at || 0);
      return {
        id: String(c.pk || c.id || ''),
        text: c.text || '',
        likeCount: Number(c.comment_like_count || 0),
        hasLiked: Boolean(c.has_liked_comment),
        replyCount: Number(c.child_comment_count || 0),
        createdAt: ts > 0 ? new Date(ts > 1e11 ? ts : ts * 1000) : null,
        user: c.user ? User.fromRaw(c.user) : null,
        raw: c
      };
    });

    return {
      comments,
      commentCount: data.comment_count !== undefined ? Number(data.comment_count) : comments.length,
      nextMinId: data.next_min_id ? String(data.next_min_id) : null,
      hasMore: Boolean(data.has_more_comments || data.next_min_id)
    };
  }

  /**
   * Fetches users who liked a Post or Reel.
   *
   * @param {string|number|Object} mediaIdOrUrl
   * @returns {Promise<{users: User[], userCount: number}>}
   */
  async getPostLikers(mediaIdOrUrl) {
    const { mediaId } = parseMediaReference(mediaIdOrUrl);
    const response = await this.transport.get(Endpoints.MEDIA_LIKERS(mediaId));
    const data = response.data || {};
    const rawUsers = Array.isArray(data.users) ? data.users : [];

    return {
      users: rawUsers.map((u) => User.fromRaw(u)).filter(Boolean),
      userCount: data.user_count !== undefined ? Number(data.user_count) : rawUsers.length
    };
  }

  /**
   * Bookmarks (saves) a Post or Reel to the authenticated user's Saved collection.
   *
   * @param {string|number|Object} mediaIdOrUrl
   */
  async savePost(mediaIdOrUrl) {
    const { mediaId, shortcode, detectedKind } = parseMediaReference(mediaIdOrUrl);
    const referer = shortcode
      ? `${Endpoints.BASE_URL}/${detectedKind === 'reel' ? 'reel' : 'p'}/${shortcode}/`
      : `${Endpoints.BASE_URL}/`;

    const response = await this.transport.post(
      Endpoints.WEB_MEDIA_SAVE(mediaId),
      '',
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: referer } },
      false
    );

    const data = response.data || {};
    if (data.status && data.status !== 'ok') {
      throw new InstaChatError(data.message || `Failed to save media ${mediaId}`, { details: data });
    }

    return { success: true, mediaId, saved: true };
  }

  /**
   * Removes a Post or Reel from the authenticated user's Saved collection.
   *
   * @param {string|number|Object} mediaIdOrUrl
   */
  async unsavePost(mediaIdOrUrl) {
    const { mediaId, shortcode, detectedKind } = parseMediaReference(mediaIdOrUrl);
    const referer = shortcode
      ? `${Endpoints.BASE_URL}/${detectedKind === 'reel' ? 'reel' : 'p'}/${shortcode}/`
      : `${Endpoints.BASE_URL}/`;

    const response = await this.transport.post(
      Endpoints.WEB_MEDIA_UNSAVE(mediaId),
      '',
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: referer } },
      false
    );

    const data = response.data || {};
    if (data.status && data.status !== 'ok') {
      throw new InstaChatError(data.message || `Failed to unsave media ${mediaId}`, { details: data });
    }

    return { success: true, mediaId, saved: false };
  }
}

PostsService.parseMediaReference = parseMediaReference;
PostsService.getImageDimensions = getImageDimensions;

module.exports = PostsService;
