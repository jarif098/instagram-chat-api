'use strict';

const fs = require('fs');
const path = require('path');
const { ValidationError } = require('./errors');

const SUPPORTED_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png'];
const SUPPORTED_VIDEO_EXTENSIONS = ['.mp4', '.mov'];
const SUPPORTED_AUDIO_EXTENSIONS = ['.mp3', '.m4a', '.aac', '.wav'];

const MAX_IMAGE_SIZE_BYTES = 15 * 1024 * 1024; // 15MB
const MAX_VIDEO_SIZE_BYTES = 50 * 1024 * 1024; // 50MB
const MAX_AUDIO_SIZE_BYTES = 25 * 1024 * 1024; // 25MB
const MAX_TEXT_LENGTH = 10000;
const MAX_NOTE_LENGTH = 60;
const MAX_CAPTION_LENGTH = 2200;
const MAX_COMMENT_LENGTH = 2200;
const MAX_SEARCH_QUERY_LENGTH = 150;
const INSTAGRAM_USERNAME_REGEX = /^[a-zA-Z0-9._]{1,30}$/;

const NOTE_AUDIENCES = Object.freeze({
  MUTUAL_FOLLOWERS: 0,
  CLOSE_FRIENDS: 1
});

const REACTION_ALIASES = Object.freeze({
  like: '❤️',
  heart: '❤️',
  love: '❤️',
  haha: '😂',
  laugh: '😂',
  joy: '😂',
  wow: '😮',
  sad: '😢',
  cry: '😢',
  angry: '😡',
  fire: '🔥',
  lit: '🔥',
  clap: '👏',
  thumbsup: '👍',
  thumbs_up: '👍',
  '+1': '👍',
  thumbsdown: '👎',
  thumbs_down: '👎',
  '-1': '👎',
  party: '🎉',
  tada: '🎉',
  '100': '💯',
  eyes: '👀',
  pray: '🙏',
  skull: '💀'
});

function validateConfig(config = {}) {
  if (typeof config !== 'object' || config === null) {
    throw new ValidationError('Configuration must be an object', { field: 'config' });
  }

  if (config.pollIntervalMs !== undefined) {
    if (typeof config.pollIntervalMs !== 'number' || config.pollIntervalMs < 1000) {
      throw new ValidationError('pollIntervalMs must be a number >= 1000ms', { field: 'pollIntervalMs' });
    }
  }

  if (config.requestTimeoutMs !== undefined) {
    if (typeof config.requestTimeoutMs !== 'number' || config.requestTimeoutMs < 1000) {
      throw new ValidationError('requestTimeoutMs must be a number >= 1000ms', { field: 'requestTimeoutMs' });
    }
  }

  if (config.maxRetries !== undefined) {
    if (typeof config.maxRetries !== 'number' || config.maxRetries < 0) {
      throw new ValidationError('maxRetries must be a non-negative number', { field: 'maxRetries' });
    }
  }

  return true;
}

function validateThreadId(threadId) {
  if (!threadId || (typeof threadId !== 'string' && typeof threadId !== 'number')) {
    throw new ValidationError('Invalid conversation/thread ID. Must be a non-empty string or number.', {
      field: 'threadId'
    });
  }
  return String(threadId).trim();
}

function validateMessageId(messageId) {
  if (!messageId || (typeof messageId !== 'string' && typeof messageId !== 'number')) {
    throw new ValidationError('Invalid message ID (item_id). Must be a non-empty string or number.', {
      field: 'messageId'
    });
  }
  return String(messageId).trim();
}

function validateUserId(userId) {
  if (userId === undefined || userId === null || (typeof userId !== 'string' && typeof userId !== 'number')) {
    throw new ValidationError('Invalid user ID. Must be a non-empty string or number.', {
      field: 'userId'
    });
  }
  const clean = String(userId).trim();
  if (!clean) {
    throw new ValidationError('Invalid user ID. Must be a non-empty string or number.', {
      field: 'userId'
    });
  }
  return clean;
}

function validateUsername(username) {
  if (typeof username !== 'string' || !username.trim()) {
    throw new ValidationError('Username must be a non-empty string.', {
      field: 'username'
    });
  }
  const clean = username.trim().replace(/^@/, '').toLowerCase();
  if (!clean || !INSTAGRAM_USERNAME_REGEX.test(clean)) {
    throw new ValidationError(
      'Invalid Instagram username. Must be 1-30 characters containing letters, numbers, periods, or underscores.',
      { field: 'username' }
    );
  }
  return clean;
}

function validateSearchQuery(query) {
  if (typeof query !== 'string' || !query.trim()) {
    throw new ValidationError('Search query must be a non-empty string.', {
      field: 'query'
    });
  }
  const clean = query.trim();
  if (clean.length > MAX_SEARCH_QUERY_LENGTH) {
    throw new ValidationError(`Search query exceeds maximum length of ${MAX_SEARCH_QUERY_LENGTH} characters.`, {
      field: 'query'
    });
  }
  return clean;
}

function validateTextMessage(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new ValidationError('Message text must be a non-empty string.', { field: 'text' });
  }
  if (text.length > MAX_TEXT_LENGTH) {
    throw new ValidationError(`Message text exceeds max length of ${MAX_TEXT_LENGTH} characters.`, {
      field: 'text'
    });
  }
  return text;
}

function validateMediaFile(filePath, type = 'image') {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new ValidationError('File path must be a non-empty string.', { field: 'filePath' });
  }

  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new ValidationError(`Media file not found at path: ${resolvedPath}`, { field: 'filePath' });
  }

  const stats = fs.statSync(resolvedPath);
  if (!stats.isFile()) {
    throw new ValidationError(`Path is not a regular file: ${resolvedPath}`, { field: 'filePath' });
  }

  const ext = path.extname(resolvedPath).toLowerCase();

  switch (type) {
    case 'image':
      if (!SUPPORTED_IMAGE_EXTENSIONS.includes(ext)) {
        throw new ValidationError(
          `Unsupported image extension "${ext}". Supported: ${SUPPORTED_IMAGE_EXTENSIONS.join(', ')}`,
          { field: 'filePath' }
        );
      }
      if (stats.size > MAX_IMAGE_SIZE_BYTES) {
        throw new ValidationError(
          `Image file size (${(stats.size / 1024 / 1024).toFixed(2)} MB) exceeds maximum limit of ${(MAX_IMAGE_SIZE_BYTES / 1024 / 1024)} MB.`,
          { field: 'filePath' }
        );
      }
      break;

    case 'video':
      if (!SUPPORTED_VIDEO_EXTENSIONS.includes(ext)) {
        throw new ValidationError(
          `Unsupported video extension "${ext}". Supported: ${SUPPORTED_VIDEO_EXTENSIONS.join(', ')}`,
          { field: 'filePath' }
        );
      }
      if (stats.size > MAX_VIDEO_SIZE_BYTES) {
        throw new ValidationError(
          `Video file size (${(stats.size / 1024 / 1024).toFixed(2)} MB) exceeds maximum limit of ${(MAX_VIDEO_SIZE_BYTES / 1024 / 1024)} MB.`,
          { field: 'filePath' }
        );
      }
      break;

    case 'audio':
      if (!SUPPORTED_AUDIO_EXTENSIONS.includes(ext)) {
        throw new ValidationError(
          `Unsupported audio extension "${ext}". Supported: ${SUPPORTED_AUDIO_EXTENSIONS.join(', ')}`,
          { field: 'filePath' }
        );
      }
      if (stats.size > MAX_AUDIO_SIZE_BYTES) {
        throw new ValidationError(
          `Audio file size (${(stats.size / 1024 / 1024).toFixed(2)} MB) exceeds maximum limit of ${(MAX_AUDIO_SIZE_BYTES / 1024 / 1024)} MB.`,
          { field: 'filePath' }
        );
      }
      break;

    default:
      throw new ValidationError(`Unknown media validation type: ${type}`, { field: 'type' });
  }

  return {
    filePath: resolvedPath,
    fileName: path.basename(resolvedPath),
    size: stats.size,
    extension: ext
  };
}

function validateNoteText(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new ValidationError('Note text must be a non-empty string.', { field: 'text' });
  }
  const clean = text.trim();
  if (clean.length > MAX_NOTE_LENGTH) {
    throw new ValidationError(`Note text exceeds maximum length of ${MAX_NOTE_LENGTH} characters (got ${clean.length}).`, {
      field: 'text'
    });
  }
  return clean;
}

function validateNoteAudience(audience = 0) {
  if (audience === 0 || audience === '0' || audience === 'mutual' || audience === 'mutual_followers' || audience === 'followers') {
    return 0;
  }
  if (audience === 1 || audience === '1' || audience === 'close_friends' || audience === 'close') {
    return 1;
  }
  return 0;
}

/**
 * Validates and normalizes an optional post/reel caption.
 *
 * @param {string} [caption='']
 * @returns {string}
 */
function validateCaption(caption = '') {
  if (caption === undefined || caption === null) return '';
  if (typeof caption !== 'string') {
    throw new ValidationError('Caption must be a string.', { field: 'caption' });
  }
  if (caption.length > MAX_CAPTION_LENGTH) {
    throw new ValidationError(
      `Caption exceeds maximum length of ${MAX_CAPTION_LENGTH} characters (got ${caption.length}).`,
      { field: 'caption' }
    );
  }
  return caption;
}

/**
 * Validates a comment text string for posts and reels.
 *
 * @param {string} text
 * @returns {string}
 */
function validateCommentText(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new ValidationError('Comment text must be a non-empty string.', { field: 'text' });
  }
  const clean = text.trim();
  if (clean.length > MAX_COMMENT_LENGTH) {
    throw new ValidationError(
      `Comment exceeds maximum length of ${MAX_COMMENT_LENGTH} characters (got ${clean.length}).`,
      { field: 'text' }
    );
  }
  return clean;
}

/**
 * Validates and normalizes a reaction emoji or named reaction alias (e.g. "like", "fire", "❤️").
 *
 * @param {string} [emoji='❤️']
 * @returns {string}
 */
function validateReactionEmoji(emoji = '❤️') {
  if (typeof emoji !== 'string' || !emoji.trim()) {
    throw new ValidationError('Emoji reaction must be a non-empty string.', { field: 'emoji' });
  }
  const trimmed = emoji.trim();
  const alias = REACTION_ALIASES[trimmed.toLowerCase()];
  return alias || trimmed;
}

/**
 * Parses a user target that may be a numeric user ID, @username, username, profile URL, or User-like object.
 *
 * @param {string|number|Object} target
 * @returns {{type: 'id'|'username', value: string, username: string|null}}
 */
function validateUserIdentifier(target) {
  if (target && typeof target === 'object') {
    const rawId = target.id || target.pk || target.userId || target.user_id;
    const rawUsername = target.username ? String(target.username).trim().replace(/^@/, '').toLowerCase() : null;
    if (rawId !== undefined && rawId !== null && String(rawId).trim()) {
      return {
        type: 'id',
        value: validateUserId(rawId),
        username: rawUsername
      };
    }
    if (rawUsername) {
      const cleanUser = validateUsername(rawUsername);
      return { type: 'username', value: cleanUser, username: cleanUser };
    }
    throw new ValidationError('User target object must contain an id or username.', { field: 'userIdOrUsername' });
  }

  if (target === undefined || target === null || (typeof target !== 'string' && typeof target !== 'number')) {
    throw new ValidationError('User target must be a numeric user ID, @username, or profile URL.', {
      field: 'userIdOrUsername'
    });
  }

  const raw = String(target).trim();
  if (!raw) {
    throw new ValidationError('User target cannot be empty.', { field: 'userIdOrUsername' });
  }

  // Numeric user ID
  if (/^\d+$/.test(raw)) {
    return { type: 'id', value: raw, username: null };
  }

  // Profile URL: https://www.instagram.com/username/
  const urlMatch = raw.match(/instagram\.com\/([a-zA-Z0-9._]{1,30})(?:\/|\?|$)/i);
  if (urlMatch && urlMatch[1]) {
    const reserved = new Set(['p', 'reel', 'reels', 'tv', 'stories', 'explore', 'direct', 'accounts']);
    if (!reserved.has(urlMatch[1].toLowerCase())) {
      const cleanUser = validateUsername(urlMatch[1]);
      return { type: 'username', value: cleanUser, username: cleanUser };
    }
  }

  const cleanUser = validateUsername(raw);
  return { type: 'username', value: cleanUser, username: cleanUser };
}

module.exports = {
  validateConfig,
  validateThreadId,
  validateMessageId,
  validateUserId,
  validateUsername,
  validateUserIdentifier,
  validateSearchQuery,
  validateTextMessage,
  validateCaption,
  validateCommentText,
  validateReactionEmoji,
  validateNoteText,
  validateNoteAudience,
  validateMediaFile,
  SUPPORTED_IMAGE_EXTENSIONS,
  SUPPORTED_VIDEO_EXTENSIONS,
  SUPPORTED_AUDIO_EXTENSIONS,
  MAX_NOTE_LENGTH,
  MAX_CAPTION_LENGTH,
  MAX_COMMENT_LENGTH,
  NOTE_AUDIENCES,
  REACTION_ALIASES
};
