'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const Endpoints = require('../constants/endpoints');
const Message = require('../models/message');
const { validateThreadId, validateMediaFile } = require('../utils/validators');
const { ValidationError, InstaChatError } = require('../utils/errors');

/**
 * Safely converts any Readable stream or Buffer into a Buffer.
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

class MediaService {
  constructor(options = {}) {
    this.transport = options.transport;
    this.session = options.session;
    this.logger = options.logger;
  }

  _generateUploadId() {
    return `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  }

  _generateClientContext() {
    return crypto.randomUUID();
  }

  /**
   * Helper to extract or reuse fb_dtsg and lsd tokens for Web GraphQL.
   *
   * @private
   * @returns {Promise<{dtsg: string|null, lsd: string|null}>}
   */
  async _extractDtsgAndLsd() {
    let dtsg = this.session && this.session._dtsg ? this.session._dtsg : null;
    let lsd = this.session && this.session._lsd ? this.session._lsd : null;

    if (!dtsg || !lsd) {
      if (!this.transport || typeof this.transport.get !== 'function') {
        throw new Error('Transport does not support GET for token scraping');
      }

      try {
        const pageRes = await this.transport.get(`${Endpoints.BASE_URL}/direct/inbox/`, {
          validateStatus: (s) => s < 400
        });
        const html = typeof pageRes.data === 'string' ? pageRes.data : '';
        const dtsgMatches = Array.from(html.matchAll(/"(NAf[^"]+)"/g)).map((m) => m[1]);
        const lsdMatches = Array.from(html.matchAll(/"LSD",\[\],\{"token":"([^"]+)"/g)).map((m) => m[1]);
        if (dtsgMatches[0]) dtsg = dtsgMatches[0];
        if (lsdMatches[0]) lsd = lsdMatches[0];
        if (this.session) {
          if (dtsg) this.session._dtsg = dtsg;
          if (lsd) this.session._lsd = lsd;
        }
      } catch (err) {
        if (this.logger && typeof this.logger.debug === 'function') {
          this.logger.debug(`Could not scrape dtsg/lsd tokens: ${err.message}`);
        }
      }
    }

    return { dtsg, lsd };
  }

  /**
   * Sends image using modern Instagram Web GraphQL mutation (IGDirectMediaSendMutation).
   *
   * @param {string} threadId
   * @param {Buffer} fileBuffer
   * @param {string} fileName
   * @param {string} mimeType
   * @param {Object} [options]
   * @returns {Promise<Message>}
   */
  async sendGraphQLImage(threadId, fileBuffer, fileName, mimeType, options = {}) {
    const validThreadId = validateThreadId(threadId);
    const { dtsg, lsd } = await this._extractDtsgAndLsd();

    const uploadId = crypto.randomUUID();
    const currentUserId = this.session ? this.session.userId : null;
    const csrfToken = this.session ? this.session.getCsrfToken() : '';

    if (this.logger && typeof this.logger.debug === 'function') {
      this.logger.debug(`Uploading image attachment (${fileBuffer.length} bytes) via rupload messenger_image...`);
    }

    // Stage 1: Upload binary to rupload messenger_image
    const ruploadResponse = await this.transport.post(
      Endpoints.RUPLOAD_MESSENGER_IMAGE(uploadId),
      fileBuffer,
      {
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Entity-Type': mimeType || 'image/jpeg',
          'X-Entity-Name': fileName || 'image.jpg',
          'X-Entity-Length': String(fileBuffer.length),
          Offset: '0',
          image_type: 'FILE_ATTACHMENT',
          'ig-u-ds-user-id': currentUserId || '',
          'x-instagram-rupload-params': JSON.stringify({
            upload_id: uploadId,
            media_type: 1
          })
        }
      },
      false
    );

    const uploadData = ruploadResponse.data || {};
    const mediaIdStr = uploadData.media_id_str || (uploadData.media_id ? String(uploadData.media_id) : null);
    if (!mediaIdStr) {
      throw new InstaChatError('Rupload did not return valid media_id_str', { details: uploadData });
    }

    // Stage 2: Publish photo attachment via IGDirectMediaSendMutation
    const offlineId = String(BigInt(Date.now()) * 1000000n + BigInt(Math.floor(Math.random() * 1000000)));

    const payload = new URLSearchParams();
    if (dtsg) payload.append('fb_dtsg', dtsg);
    if (lsd) payload.append('lsd', lsd);
    payload.append('fb_api_caller_class', 'RelayModern');
    payload.append('fb_api_req_friendly_name', 'IGDirectMediaSendMutation');
    payload.append('server_timestamps', 'true');
    payload.append('doc_id', Endpoints.GRAPHQL_DOCS.SEND_MEDIA);
    payload.append('variables', JSON.stringify({
      attachment_fbid: mediaIdStr,
      thread_id: validThreadId,
      offline_threading_id: offlineId,
      reply_to_message_id: options.replyToItemId || null,
      forwarded_from_thread_id: null,
      is_forwarded_from_own_message: null
    }));

    const response = await this.transport.post(
      Endpoints.GRAPHQL,
      payload.toString(),
      {
        headers: {
          'x-csrftoken': csrfToken,
          'x-fb-friendly-name': 'IGDirectMediaSendMutation',
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
    const sendResp = data && data.xig_direct_media_send_with_slide_messaging_response;
    if (!sendResp) {
      throw new InstaChatError('Malformed GraphQL media send response', { details: response.data });
    }

    const rawItem = {
      item_id: sendResp.message_id || sendResp.id || offlineId,
      thread_id: validThreadId,
      user_id: currentUserId,
      timestamp: Number(sendResp.timestamp_ms || Date.now()) * 1000,
      item_type: 'media',
      media: {
        media_type: 1,
        id: mediaIdStr,
        image_versions2: {
          candidates: [{ url: `media://${mediaIdStr}`, width: 1080, height: 1080 }]
        }
      }
    };

    return Message.fromRaw(rawItem, currentUserId);
  }

  /**
   * Downloads remote image from URL and sends it as a native attachment.
   *
   * @param {string} threadId
   * @param {string} imageUrl
   * @param {Object} [options]
   * @returns {Promise<Message>}
   */
  async sendImageFromUrl(threadId, imageUrl, options = {}) {
    const validThreadId = validateThreadId(threadId);
    if (!imageUrl || typeof imageUrl !== 'string') {
      throw new ValidationError('imageUrl must be a valid URL string');
    }

    if (this.logger && typeof this.logger.debug === 'function') {
      this.logger.debug(`Fetching image from URL: ${imageUrl}...`);
    }

    const res = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: options.downloadTimeoutMs || 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    const buffer = Buffer.from(res.data);
    const contentType = (res.headers && res.headers['content-type']) || 'image/jpeg';
    let mimeType = 'image/jpeg';
    let ext = '.jpg';

    if (contentType.includes('png')) {
      mimeType = 'image/png';
      ext = '.png';
    } else if (contentType.includes('webp')) {
      mimeType = 'image/webp';
      ext = '.webp';
    } else if (contentType.includes('gif')) {
      mimeType = 'image/gif';
      ext = '.gif';
    }

    const fileName = options.fileName || `image_${Date.now()}${ext}`;
    return this.sendImage(validThreadId, buffer, {
      ...options,
      fileName,
      mimeType
    });
  }

  /**
   * Uploads an image from local filesystem, Buffer, or remote URL and sends it to a conversation thread.
   *
   * @param {string} threadId
   * @param {string|Buffer} fileInput - Local file path, URL string, or Buffer
   * @param {Object} [options]
   * @returns {Promise<Message>}
   */
  async sendImage(threadId, fileInput, options = {}) {
    const validThreadId = validateThreadId(threadId);

    // If input is an HTTP/HTTPS URL, download and send
    if (typeof fileInput === 'string' && (fileInput.startsWith('http://') || fileInput.startsWith('https://'))) {
      return this.sendImageFromUrl(validThreadId, fileInput, options);
    }

    let fileBuffer;
    let fileName = options.fileName || `image_${Date.now()}.jpg`;
    let mimeType = options.mimeType || 'image/jpeg';
    let fileSize;

    if (fileInput && (typeof fileInput.pipe === 'function' || fileInput[Symbol.asyncIterator])) {
      // Readable Stream support (e.g. fs.createReadStream or getStreamFromURL)
      fileBuffer = await streamToBuffer(fileInput);
      fileSize = fileBuffer.length;
      if (fileInput.path && typeof fileInput.path === 'string' && !options.fileName) {
        fileName = path.basename(fileInput.path);
      }
    } else if (Buffer.isBuffer(fileInput)) {
      fileBuffer = fileInput;
      fileSize = fileBuffer.length;
    } else {
      const validated = validateMediaFile(fileInput, 'image');
      fileBuffer = fs.readFileSync(validated.filePath);
      fileName = validated.fileName;
      mimeType = validated.extension === '.png' ? 'image/png' : 'image/jpeg';
      fileSize = validated.size;
    }

    // Auto-detect image MIME type from magic bytes if not explicitly provided
    if (!options.mimeType && fileBuffer && fileBuffer.length >= 4) {
      if (fileBuffer[0] === 0x89 && fileBuffer[1] === 0x50 && fileBuffer[2] === 0x4E && fileBuffer[3] === 0x47) {
        mimeType = 'image/png';
        if (!fileName.endsWith('.png')) fileName = fileName.replace(/\.[^.]+$/, '') + '.png';
      } else if (fileBuffer[0] === 0xFF && fileBuffer[1] === 0xD8) {
        mimeType = 'image/jpeg';
        if (!fileName.endsWith('.jpg') && !fileName.endsWith('.jpeg')) fileName = fileName.replace(/\.[^.]+$/, '') + '.jpg';
      } else if (fileBuffer[0] === 0x47 && fileBuffer[1] === 0x49 && fileBuffer[2] === 0x46) {
        mimeType = 'image/gif';
        if (!fileName.endsWith('.gif')) fileName = fileName.replace(/\.[^.]+$/, '') + '.gif';
      } else if (fileBuffer.slice(0, 4).toString() === 'RIFF') {
        mimeType = 'image/webp';
        if (!fileName.endsWith('.webp')) fileName = fileName.replace(/\.[^.]+$/, '') + '.webp';
      }
    }

    // Stage 1: Try modern GraphQL direct media pipeline (default for Web sessions)
    if (!options.forceRest) {
      try {
        return await this.sendGraphQLImage(validThreadId, fileBuffer, fileName, mimeType, options);
      } catch (err) {
        if (this.logger && typeof this.logger.debug === 'function') {
          this.logger.debug(`GraphQL media send failed: ${err.message}. Falling back to REST configure_photo.`);
        }
      }
    }

    // Stage 2: Legacy REST broadcast fallback
    const uploadId = this._generateUploadId();
    const clientContext = options.clientContext || this._generateClientContext();
    const csrfToken = this.session ? this.session.getCsrfToken() : '';
    const currentUserId = this.session ? this.session.userId : null;

    const ruploadParams = JSON.stringify({
      upload_id: uploadId,
      media_type: 1
    });

    if (this.logger && typeof this.logger.debug === 'function') {
      this.logger.debug(`Uploading image (${fileSize} bytes) via rupload endpoint...`);
    }

    const ruploadResponse = await this.transport.post(
      Endpoints.RUPLOAD_PHOTO(uploadId),
      fileBuffer,
      {
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Entity-Type': mimeType,
          'X-Entity-Name': fileName,
          'X-Entity-Length': String(fileSize),
          Offset: '0',
          'X-Instagram-Rupload-Params': ruploadParams
        }
      },
      false
    );

    if (ruploadResponse.data && ruploadResponse.data.status === 'fail') {
      throw new InstaChatError('Failed during image rupload stage', { details: ruploadResponse.data });
    }

    // Broadcast / Configure photo in thread
    const payload = new URLSearchParams();
    payload.append('action', 'send_item');
    payload.append('thread_ids', JSON.stringify([validThreadId]));
    payload.append('upload_id', uploadId);
    payload.append('client_context', clientContext);
    payload.append('_csrftoken', csrfToken);
    payload.append('_uuid', clientContext);

    const configureResponse = await this.transport.post(
      Endpoints.CONFIGURE_PHOTO,
      payload.toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      },
      false
    );

    const configData = configureResponse.data || {};
    if (configData.status !== 'ok') {
      throw new InstaChatError(configData.message || 'Failed to configure photo in thread', {
        details: configData
      });
    }

    const rawItem = {
      item_id: configData.item_id || clientContext,
      thread_id: validThreadId,
      user_id: currentUserId,
      timestamp: configData.timestamp || Date.now() * 1000,
      item_type: 'media',
      media: {
        media_type: 1,
        image_versions2: {
          candidates: [{ url: `local://${fileName}`, width: 1080, height: 1080 }]
        }
      }
    };

    return Message.fromRaw(rawItem, currentUserId);
  }

  /**
   * Uploads a video from local filesystem, URL, Buffer, or Stream and sends it to a conversation thread.
   *
   * @param {string} threadId
   * @param {string|Buffer|import('stream').Readable} filePathOrInput
   * @param {Object} [options]
   * @returns {Promise<Message>}
   */
  async sendVideo(threadId, filePathOrInput, options = {}) {
    const validThreadId = validateThreadId(threadId);

    let fileBuffer;
    let fileName = options.fileName || `video_${Date.now()}.mp4`;
    let fileSize;

    if (typeof filePathOrInput === 'string' && (filePathOrInput.startsWith('http://') || filePathOrInput.startsWith('https://'))) {
      const res = await axios.get(filePathOrInput, {
        responseType: 'arraybuffer',
        timeout: options.downloadTimeoutMs || 60000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      fileBuffer = Buffer.from(res.data);
      fileSize = fileBuffer.length;
    } else if (filePathOrInput && (typeof filePathOrInput.pipe === 'function' || filePathOrInput[Symbol.asyncIterator])) {
      fileBuffer = await streamToBuffer(filePathOrInput);
      fileSize = fileBuffer.length;
      if (filePathOrInput.path && typeof filePathOrInput.path === 'string' && !options.fileName) {
        fileName = path.basename(filePathOrInput.path);
      }
    } else if (Buffer.isBuffer(filePathOrInput)) {
      fileBuffer = filePathOrInput;
      fileSize = fileBuffer.length;
    } else {
      const validated = validateMediaFile(filePathOrInput, 'video');
      fileBuffer = fs.readFileSync(validated.filePath);
      fileName = validated.fileName;
      fileSize = validated.size;
    }

    const mimeType = options.mimeType || (fileName.toLowerCase().endsWith('.mov') ? 'video/quicktime' : 'video/mp4');

    // Stage 1: Try modern GraphQL direct video pipeline (messenger_video + IGDirectMediaSendMutation)
    if (!options.forceRest) {
      try {
        return await this.sendGraphQLVideo(validThreadId, fileBuffer, fileName, mimeType, options);
      } catch (err) {
        if (this.logger && typeof this.logger.debug === 'function') {
          this.logger.debug(`GraphQL video send failed: ${err.message}. Falling back to REST configure_video.`);
        }
      }
    }

    const uploadId = this._generateUploadId();
    const clientContext = options.clientContext || this._generateClientContext();
    const csrfToken = this.session ? this.session.getCsrfToken() : '';
    const currentUserId = this.session ? this.session.userId : null;

    const ruploadParams = JSON.stringify({
      upload_id: uploadId,
      media_type: 2
    });

    if (this.logger && typeof this.logger.debug === 'function') {
      this.logger.debug(`Uploading video (${fileSize} bytes) via rupload endpoint...`);
    }

    // Stage 1: Rupload video binary
    await this.transport.post(
      Endpoints.RUPLOAD_VIDEO(uploadId),
      fileBuffer,
      {
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Entity-Type': 'video/mp4',
          'X-Entity-Name': fileName,
          'X-Entity-Length': String(fileSize),
          Offset: '0',
          'X-Instagram-Rupload-Params': ruploadParams
        }
      },
      false
    );

    // Stage 2: Configure video
    const payload = new URLSearchParams();
    payload.append('action', 'send_item');
    payload.append('thread_ids', JSON.stringify([validThreadId]));
    payload.append('upload_id', uploadId);
    payload.append('client_context', clientContext);
    payload.append('_csrftoken', csrfToken);
    payload.append('_uuid', clientContext);

    const configureResponse = await this.transport.post(
      Endpoints.CONFIGURE_VIDEO,
      payload.toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      },
      false
    );

    const configData = configureResponse.data || {};
    if (configData.status !== 'ok') {
      throw new InstaChatError(configData.message || 'Failed to configure video in thread', {
        details: configData
      });
    }

    const rawItem = {
      item_id: configData.item_id || clientContext,
      thread_id: validThreadId,
      user_id: currentUserId,
      timestamp: configData.timestamp || Date.now() * 1000,
      item_type: 'media',
      media: {
        media_type: 2,
        video_versions: [{ url: `local://${fileName}`, width: 1920, height: 1080 }]
      }
    };

    return Message.fromRaw(rawItem, currentUserId);
  }

  /**
   * Sends a video attachment using modern Instagram Web GraphQL (messenger_video + IGDirectMediaSendMutation).
   *
   * @param {string} threadId
   * @param {Buffer} fileBuffer
   * @param {string} fileName
   * @param {string} mimeType
   * @param {Object} [options]
   * @returns {Promise<Message>}
   */
  async sendGraphQLVideo(threadId, fileBuffer, fileName, mimeType, options = {}) {
    const validThreadId = validateThreadId(threadId);
    const { dtsg, lsd } = await this._extractDtsgAndLsd();

    const uploadId = crypto.randomUUID();
    const currentUserId = this.session ? this.session.userId : null;
    const csrfToken = this.session ? this.session.getCsrfToken() : '';

    if (this.logger && typeof this.logger.debug === 'function') {
      this.logger.debug(`Uploading video attachment (${fileBuffer.length} bytes) via rupload messenger_video...`);
    }

    const ruploadResponse = await this.transport.post(
      Endpoints.RUPLOAD_MESSENGER_VIDEO(uploadId),
      fileBuffer,
      {
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Entity-Type': mimeType || 'video/mp4',
          'X-Entity-Name': fileName || 'video.mp4',
          'X-Entity-Length': String(fileBuffer.length),
          Offset: '0',
          video_type: options.videoType || 'FILE_ATTACHMENT',
          'ig-u-ds-user-id': currentUserId || '',
          'x-instagram-rupload-params': JSON.stringify({
            upload_id: uploadId,
            media_type: 2
          })
        }
      },
      false
    );

    const uploadData = ruploadResponse.data || {};
    const mediaIdStr = uploadData.media_id_str || (uploadData.media_id ? String(uploadData.media_id) : null);
    if (!mediaIdStr) {
      throw new InstaChatError('Rupload video did not return valid media_id_str', { details: uploadData });
    }

    const offlineId = String(BigInt(Date.now()) * 1000000n + BigInt(Math.floor(Math.random() * 1000000)));
    const payload = new URLSearchParams();
    if (dtsg) payload.append('fb_dtsg', dtsg);
    if (lsd) payload.append('lsd', lsd);
    payload.append('fb_api_caller_class', 'RelayModern');
    payload.append('fb_api_req_friendly_name', 'IGDirectMediaSendMutation');
    payload.append('server_timestamps', 'true');
    payload.append('doc_id', Endpoints.GRAPHQL_DOCS.SEND_MEDIA);
    payload.append('variables', JSON.stringify({
      attachment_fbid: mediaIdStr,
      thread_id: validThreadId,
      offline_threading_id: offlineId,
      reply_to_message_id: options.replyToItemId || null,
      forwarded_from_thread_id: null,
      is_forwarded_from_own_message: null
    }));

    const response = await this.transport.post(
      Endpoints.GRAPHQL,
      payload.toString(),
      {
        headers: {
          'x-csrftoken': csrfToken,
          'x-fb-friendly-name': 'IGDirectMediaSendMutation',
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
    const sendResp = data && data.xig_direct_media_send_with_slide_messaging_response;
    if (!sendResp) {
      throw new InstaChatError('Malformed GraphQL video send response', { details: response.data });
    }

    return Message.fromRaw({
      item_id: sendResp.message_id || sendResp.id || offlineId,
      thread_id: validThreadId,
      user_id: currentUserId,
      timestamp: Number(sendResp.timestamp_ms || Date.now()) * 1000,
      item_type: 'media',
      media: {
        media_type: 2,
        id: mediaIdStr,
        video_versions: [{ url: `media://${mediaIdStr}`, width: 1920, height: 1080 }]
      }
    }, currentUserId);
  }

  /**
   * Sends audio/voice clip using modern Instagram Web GraphQL mutation (IGDirectMediaSendMutation).
   *
   * @param {string} threadId
   * @param {Buffer} fileBuffer
   * @param {string} fileName
   * @param {string} mimeType
   * @param {Object} [options]
   * @returns {Promise<Message>}
   */
  async sendGraphQLAudio(threadId, fileBuffer, fileName, mimeType, options = {}) {
    const validThreadId = validateThreadId(threadId);
    const { dtsg, lsd } = await this._extractDtsgAndLsd();

    const uploadId = crypto.randomUUID();
    const currentUserId = this.session ? this.session.userId : null;
    const csrfToken = this.session ? this.session.getCsrfToken() : '';

    if (this.logger && typeof this.logger.debug === 'function') {
      this.logger.debug(`Uploading audio attachment (${fileBuffer.length} bytes) via rupload messenger_audio...`);
    }

    // Stage 1: Upload binary to rupload messenger_audio
    const ruploadResponse = await this.transport.post(
      Endpoints.RUPLOAD_MESSENGER_AUDIO(uploadId),
      fileBuffer,
      {
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Entity-Type': mimeType || 'audio/mp4',
          'X-Entity-Name': fileName || 'voice.m4a',
          'X-Entity-Length': String(fileBuffer.length),
          Offset: '0',
          audio_type: options.audioType || 'VOICE_MESSAGE',
          'ig-u-ds-user-id': currentUserId || '',
          'x-instagram-rupload-params': JSON.stringify({
            upload_id: uploadId,
            media_type: 11
          })
        }
      },
      false
    );

    const uploadData = ruploadResponse.data || {};
    const mediaIdStr = uploadData.media_id_str || (uploadData.media_id ? String(uploadData.media_id) : null);
    if (!mediaIdStr) {
      throw new InstaChatError('Rupload audio did not return valid media_id_str', { details: uploadData });
    }

    // Stage 2: Publish voice attachment via IGDirectMediaSendMutation
    const offlineId = String(BigInt(Date.now()) * 1000000n + BigInt(Math.floor(Math.random() * 1000000)));

    const payload = new URLSearchParams();
    if (dtsg) payload.append('fb_dtsg', dtsg);
    if (lsd) payload.append('lsd', lsd);
    payload.append('fb_api_caller_class', 'RelayModern');
    payload.append('fb_api_req_friendly_name', 'IGDirectMediaSendMutation');
    payload.append('server_timestamps', 'true');
    payload.append('doc_id', Endpoints.GRAPHQL_DOCS.SEND_MEDIA);
    payload.append('variables', JSON.stringify({
      attachment_fbid: mediaIdStr,
      thread_id: validThreadId,
      offline_threading_id: offlineId,
      reply_to_message_id: options.replyToItemId || null,
      forwarded_from_thread_id: null,
      is_forwarded_from_own_message: null
    }));

    const response = await this.transport.post(
      Endpoints.GRAPHQL,
      payload.toString(),
      {
        headers: {
          'x-csrftoken': csrfToken,
          'x-fb-friendly-name': 'IGDirectMediaSendMutation',
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
    const sendResp = data && data.xig_direct_media_send_with_slide_messaging_response;
    if (!sendResp) {
      throw new InstaChatError('Malformed GraphQL audio send response', { details: response.data });
    }

    const rawItem = {
      item_id: sendResp.message_id || sendResp.id || offlineId,
      thread_id: validThreadId,
      user_id: currentUserId,
      timestamp: Number(sendResp.timestamp_ms || Date.now()) * 1000,
      item_type: 'voice_media',
      voice_media: {
        media: {
          id: mediaIdStr,
          audio: {
            audio_src: `media://${mediaIdStr}`
          }
        }
      }
    };

    return Message.fromRaw(rawItem, currentUserId);
  }

  /**
   * Downloads remote audio from URL and sends it as a native voice/audio attachment.
   *
   * @param {string} threadId
   * @param {string} audioUrl
   * @param {Object} [options]
   * @returns {Promise<Message>}
   */
  async sendAudioFromUrl(threadId, audioUrl, options = {}) {
    const validThreadId = validateThreadId(threadId);
    if (!audioUrl || typeof audioUrl !== 'string') {
      throw new ValidationError('audioUrl must be a valid URL string');
    }

    if (this.logger && typeof this.logger.debug === 'function') {
      this.logger.debug(`Fetching audio from URL: ${audioUrl}...`);
    }

    const res = await axios.get(audioUrl, {
      responseType: 'arraybuffer',
      timeout: options.downloadTimeoutMs || 60000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    const buffer = Buffer.from(res.data);
    const contentType = (res.headers && res.headers['content-type']) || 'audio/mp4';
    let mimeType = 'audio/mp4';
    let ext = '.m4a';

    if (contentType.includes('mpeg') || contentType.includes('mp3')) {
      mimeType = 'audio/mpeg';
      ext = '.mp3';
    } else if (contentType.includes('ogg')) {
      mimeType = 'audio/ogg';
      ext = '.ogg';
    } else if (contentType.includes('wav')) {
      mimeType = 'audio/wav';
      ext = '.wav';
    }

    const fileName = options.fileName || `audio_${Date.now()}${ext}`;
    return this.sendAudio(validThreadId, buffer, {
      ...options,
      fileName,
      mimeType
    });
  }

  /**
   * Uploads an audio clip or voice note and sends it to a conversation thread.
   *
   * @param {string} threadId
   * @param {string|Buffer|import('stream').Readable} fileInput - Local path, URL, Buffer, or Stream
   * @param {Object} [options]
   * @returns {Promise<Message>}
   */
  async sendAudio(threadId, fileInput, options = {}) {
    const validThreadId = validateThreadId(threadId);

    // If input is an HTTP/HTTPS URL, download and send
    if (typeof fileInput === 'string' && (fileInput.startsWith('http://') || fileInput.startsWith('https://'))) {
      return this.sendAudioFromUrl(validThreadId, fileInput, options);
    }

    let fileBuffer;
    let fileName = options.fileName || `voice_${Date.now()}.m4a`;
    let mimeType = options.mimeType || 'audio/mp4';
    let fileSize;

    if (fileInput && (typeof fileInput.pipe === 'function' || fileInput[Symbol.asyncIterator])) {
      // Readable Stream support
      fileBuffer = await streamToBuffer(fileInput);
      fileSize = fileBuffer.length;
      if (fileInput.path && typeof fileInput.path === 'string' && !options.fileName) {
        fileName = path.basename(fileInput.path);
      }
    } else if (Buffer.isBuffer(fileInput)) {
      fileBuffer = fileInput;
      fileSize = fileBuffer.length;
    } else {
      const validated = validateMediaFile(fileInput, 'audio');
      fileBuffer = fs.readFileSync(validated.filePath);
      fileName = validated.fileName;
      mimeType = validated.extension === '.mp3' ? 'audio/mpeg' : 'audio/mp4';
      fileSize = validated.size;
    }

    // Auto-detect audio MIME type from magic bytes if not explicitly provided
    if (!options.mimeType && fileBuffer && fileBuffer.length >= 4) {
      if (fileBuffer[0] === 0x49 && fileBuffer[1] === 0x44 && fileBuffer[2] === 0x33) {
        // ID3 tag -> MP3
        mimeType = 'audio/mpeg';
        if (!fileName.endsWith('.mp3')) fileName = fileName.replace(/\.[^.]+$/, '') + '.mp3';
      } else if (fileBuffer[0] === 0xFF && (fileBuffer[1] & 0xE0) === 0xE0) {
        // MPEG sync word -> MP3
        mimeType = 'audio/mpeg';
        if (!fileName.endsWith('.mp3')) fileName = fileName.replace(/\.[^.]+$/, '') + '.mp3';
      } else if (fileBuffer.slice(0, 4).toString() === 'OggS') {
        mimeType = 'audio/ogg';
        if (!fileName.endsWith('.ogg')) fileName = fileName.replace(/\.[^.]+$/, '') + '.ogg';
      } else if (fileBuffer.slice(0, 4).toString() === 'RIFF') {
        mimeType = 'audio/wav';
        if (!fileName.endsWith('.wav')) fileName = fileName.replace(/\.[^.]+$/, '') + '.wav';
      }
    }

    // Stage 1: Try modern GraphQL direct media pipeline (default for Web sessions)
    if (!options.forceRest) {
      try {
        return await this.sendGraphQLAudio(validThreadId, fileBuffer, fileName, mimeType, options);
      } catch (err) {
        if (this.logger && typeof this.logger.debug === 'function') {
          this.logger.debug(`GraphQL audio send failed: ${err.message}. Falling back to REST configure_voice.`);
        }
      }
    }

    // Stage 2: Legacy REST broadcast fallback
    const uploadId = this._generateUploadId();
    const clientContext = options.clientContext || this._generateClientContext();
    const csrfToken = this.session ? this.session.getCsrfToken() : '';
    const currentUserId = this.session ? this.session.userId : null;

    const ruploadParams = JSON.stringify({
      upload_id: uploadId,
      media_type: 11
    });

    if (this.logger && typeof this.logger.debug === 'function') {
      this.logger.debug(`Uploading audio (${fileSize} bytes) via rupload endpoint...`);
    }

    await this.transport.post(
      Endpoints.RUPLOAD_VOICE(uploadId),
      fileBuffer,
      {
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Entity-Type': mimeType,
          'X-Entity-Name': fileName,
          'X-Entity-Length': String(fileSize),
          Offset: '0',
          'X-Instagram-Rupload-Params': ruploadParams
        }
      },
      false
    );

    // Stage 2: Configure voice
    const payload = new URLSearchParams();
    payload.append('action', 'send_item');
    payload.append('thread_ids', JSON.stringify([validThreadId]));
    payload.append('upload_id', uploadId);
    payload.append('client_context', clientContext);
    payload.append('_csrftoken', csrfToken);
    payload.append('_uuid', clientContext);

    const configureResponse = await this.transport.post(
      Endpoints.CONFIGURE_VOICE,
      payload.toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      },
      false
    );

    const configData = configureResponse.data || {};
    if (configData.status !== 'ok') {
      throw new InstaChatError(configData.message || 'Failed to configure voice audio in thread', {
        details: configData
      });
    }

    const rawItem = {
      item_id: configData.item_id || clientContext,
      thread_id: validThreadId,
      user_id: currentUserId,
      timestamp: configData.timestamp || Date.now() * 1000,
      item_type: 'voice_media',
      voice_media: {
        media: {
          audio: {
            audio_src: `local://${fileName}`
          }
        }
      }
    };

    return Message.fromRaw(rawItem, currentUserId);
  }

  /**
   * Downloads media attachment to local filesystem.
   *
   * @param {string} mediaUrl - Remote media URL
   * @param {string} destinationPath - Target local file path
   * @returns {Promise<string>} - Absolute path to downloaded file
   */
  async downloadMedia(mediaUrl, destinationPath) {
    if (!mediaUrl || typeof mediaUrl !== 'string') {
      throw new ValidationError('mediaUrl must be a valid URL string');
    }
    if (!destinationPath || typeof destinationPath !== 'string') {
      throw new ValidationError('destinationPath must be a valid path string');
    }

    const resolved = path.resolve(destinationPath);
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const writer = fs.createWriteStream(resolved);
    const response = await axios({
      method: 'GET',
      url: mediaUrl,
      responseType: 'stream',
      timeout: 30000
    });

    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => resolve(resolved));
      writer.on('error', (err) => {
        fs.unlink(resolved, () => {});
        reject(new InstaChatError(`Failed to download media: ${err.message}`));
      });
    });
  }
}

module.exports = MediaService;
