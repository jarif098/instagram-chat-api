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
const MAX_SEARCH_QUERY_LENGTH = 150;
const INSTAGRAM_USERNAME_REGEX = /^[a-zA-Z0-9._]{1,30}$/;

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

module.exports = {
  validateConfig,
  validateThreadId,
  validateMessageId,
  validateUserId,
  validateUsername,
  validateSearchQuery,
  validateTextMessage,
  validateMediaFile,
  SUPPORTED_IMAGE_EXTENSIONS,
  SUPPORTED_VIDEO_EXTENSIONS,
  SUPPORTED_AUDIO_EXTENSIONS
};
