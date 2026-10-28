'use strict';

const crypto = require('crypto');
const Endpoints = require('../constants/endpoints');
const Note = require('../models/note');
const {
  validateNoteText,
  validateNoteAudience,
  NOTE_AUDIENCES
} = require('../utils/validators');
const {
  ValidationError,
  NotFoundError,
  AuthenticationError,
  RateLimitError,
  InstaChatError
} = require('../utils/errors');

/**
 * Service for managing Instagram Direct Notes (24h status bubbles at top of inbox).
 */
class NotesService {
  /**
   * @param {Object} options
   * @param {import('../transport/http')} options.transport
   * @param {import('../auth/session')} options.session
   * @param {import('../utils/logger').Logger} [options.logger]
   * @param {import('./conversations')} [options.conversationsService]
   * @param {import('./messages')} [options.messagesService]
   */
  constructor(options = {}) {
    this.transport = options.transport;
    this.session = options.session;
    this.logger = options.logger;
    this.conversationsService = options.conversationsService;
    this.messagesService = options.messagesService;
  }

  get currentUserId() {
    return this.session ? String(this.session.userId || '') : null;
  }

  _generateUuid() {
    return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
  }

  /**
   * Translates Meta internal failure responses into descriptive errors.
   *
   * @private
   * @param {Object} [data]
   * @param {string} [defaultMsg]
   */
  _handleNoteApiError(data, defaultMsg) {
    const rawMsg = data && data.message ? String(data.message) : '';
    const isMobileSessionError =
      rawMsg.toLowerCase().includes('something went wrong') ||
      rawMsg.toLowerCase().includes("we're sorry") ||
      (data && data.status === 'fail' && !rawMsg);

    if (isMobileSessionError) {
      throw new InstaChatError(
        'Instagram Notes are restricted by Meta to official mobile app sessions. ' +
        'Sessions extracted from Instagram Web browser cookies cannot create or modify Notes on Instagram servers.',
        { details: data, code: 'MOBILE_SESSION_REQUIRED' }
      );
    }
    throw new InstaChatError(rawMsg || defaultMsg, { details: data });
  }

  /**
   * Retrieves active Direct Notes currently visible in the inbox tray.
   *
   * @param {Object} [options]
   * @returns {Promise<{notes: Array<Note>, raw: Object}>}
   */
  async getNotes(options = {}) {
    let response;
    try {
      response = await this.transport.get(Endpoints.NOTES_GET, {
        headers: {
          Referer: `${Endpoints.BASE_URL}/direct/inbox/`
        }
      });
    } catch (err) {
      if (err instanceof AuthenticationError || err instanceof RateLimitError) throw err;
      if (this.logger && typeof this.logger.debug === 'function') {
        this.logger.debug(`NOTES_GET primary failed (${err.message}), trying web fallback...`);
      }
      try {
        response = await this.transport.get(Endpoints.NOTES_GET_WEB, {
          headers: {
            Referer: `${Endpoints.BASE_URL}/direct/inbox/`
          }
        });
      } catch (fallbackErr) {
        if (fallbackErr instanceof AuthenticationError || fallbackErr instanceof RateLimitError) throw fallbackErr;
        if (this.logger && typeof this.logger.warn === 'function') {
          this.logger.warn(`Failed to fetch notes inbox tray: ${fallbackErr.message}`);
        }
        return { notes: [], raw: fallbackErr.details || {} };
      }
    }

    const data = response.data || {};
    if (data.status === 'fail') {
      if (this.logger && typeof this.logger.warn === 'function') {
        this.logger.warn(
          'Instagram Notes inbox tray returned status: fail. Notes are restricted by Meta to mobile app sessions; web browser sessions cannot access the Notes tray.'
        );
      }
      return {
        notes: [],
        raw: data
      };
    }

    const rawItems = Array.isArray(data.items)
      ? data.items
      : Array.isArray(data.notes)
        ? data.notes
        : Array.isArray(data.tray)
          ? data.tray
          : [];

    const notes = rawItems
      .filter(Boolean)
      .map((item) => Note.fromRaw(item, this.currentUserId));

    return {
      notes,
      raw: data
    };
  }

  /**
   * Retrieves the current authenticated user's active Note, or null if none is posted.
   *
   * @returns {Promise<Note|null>}
   */
  async getMyNote() {
    const { notes } = await this.getNotes();
    const uid = this.currentUserId;
    if (!uid) return null;

    return notes.find((n) => n.isSelf || String(n.userId) === uid) || null;
  }

  /**
   * Finds an active note posted by a specific user (by handle or user ID).
   *
   * @param {string|number} usernameOrUserId
   * @returns {Promise<Note|null>}
   */
  async getNoteByUser(usernameOrUserId) {
    if (!usernameOrUserId) {
      throw new ValidationError('usernameOrUserId must be provided.', { field: 'usernameOrUserId' });
    }

    const clean = String(usernameOrUserId).replace(/^@/, '').toLowerCase().trim();
    const { notes } = await this.getNotes();

    return (
      notes.find((n) => {
        if (String(n.userId) === clean) return true;
        if (n.user && n.user.username && n.user.username.toLowerCase() === clean) return true;
        return false;
      }) || null
    );
  }

  /**
   * Publishes a new Direct Note (up to 60 characters) to mutual followers or close friends.
   *
   * @param {string} text - Note message (1 to 60 characters)
   * @param {Object} [options]
   * @param {number|'mutual'|'close_friends'} [options.audience=0] - 0: Mutual Followers, 1: Close Friends
   * @param {number} [options.noteStyle=0] - Note style (default: 0 standard text)
   * @returns {Promise<Note>}
   */
  async createNote(text, options = {}) {
    const cleanText = validateNoteText(text);
    const audience = validateNoteAudience(options.audience);
    const noteStyle = options.noteStyle !== undefined ? Number(options.noteStyle) : 0;
    const csrfToken = this.session ? this.session.getCsrfToken() : '';
    const uuid = this._generateUuid();

    const payload = new URLSearchParams();
    payload.append('text', cleanText);
    payload.append('audience', String(audience));
    payload.append('note_style', String(noteStyle));
    payload.append('_uuid', uuid);
    if (csrfToken) {
      payload.append('_csrftoken', csrfToken);
    }

    let response;
    try {
      response = await this.transport.post(
        Endpoints.NOTES_CREATE,
        payload.toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Referer: `${Endpoints.BASE_URL}/direct/inbox/`
          }
        },
        false
      );
    } catch (err) {
      if (err instanceof AuthenticationError || err instanceof RateLimitError) throw err;
      const msg = err.message || '';
      if (
        msg.toLowerCase().includes('something went wrong') ||
        msg.toLowerCase().includes("we're sorry")
      ) {
        this._handleNoteApiError(err.details || { message: msg }, 'Failed to create note.');
      }
      if (this.logger && typeof this.logger.debug === 'function') {
        this.logger.debug(`NOTES_CREATE primary failed (${err.message}), retrying web fallback...`);
      }
      try {
        response = await this.transport.post(
          Endpoints.NOTES_CREATE_WEB,
          payload.toString(),
          {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              Referer: `${Endpoints.BASE_URL}/direct/inbox/`
            }
          },
          false
        );
      } catch (fallbackErr) {
        if (fallbackErr instanceof AuthenticationError || fallbackErr instanceof RateLimitError) throw fallbackErr;
        this._handleNoteApiError(fallbackErr.details || { message: fallbackErr.message }, 'Failed to create note.');
      }
    }

    const data = response.data || {};
    if (data.status && data.status !== 'ok') {
      this._handleNoteApiError(data, 'Failed to create note.');
    }

    const rawNote = data.note || data.item || data;
    const createdNote = new Note(
      {
        id: rawNote.id || rawNote.note_id || data.id || `note_${Date.now()}`,
        text: cleanText,
        user_id: this.currentUserId,
        audience,
        created_at: Math.floor(Date.now() / 1000),
        expires_at: Math.floor(Date.now() / 1000) + 86400,
        ...rawNote
      },
      this.currentUserId
    );

    if (this.logger && typeof this.logger.info === 'function') {
      this.logger.info(`Direct Note published: "${cleanText}" (Audience: ${createdNote.audienceName})`);
    }

    return createdNote;
  }

  /**
   * Deletes an active note. If noteId is omitted, automatically finds and deletes viewer's note.
   *
   * @param {string|number} [noteId=null] - Target note ID (or null to delete viewer's active note)
   * @returns {Promise<{success: boolean, noteId: string}>}
   */
  async deleteNote(noteId = null) {
    let targetId = noteId ? String(noteId).trim() : null;

    if (!targetId) {
      const myNote = await this.getMyNote();
      if (!myNote || !myNote.id) {
        throw new NotFoundError('No active note found for the current user to delete.');
      }
      targetId = myNote.id;
    }

    const csrfToken = this.session ? this.session.getCsrfToken() : '';
    const uuid = this._generateUuid();

    const payload = new URLSearchParams();
    payload.append('id', targetId);
    payload.append('_uuid', uuid);
    if (csrfToken) {
      payload.append('_csrftoken', csrfToken);
    }

    let response;
    try {
      response = await this.transport.post(
        Endpoints.NOTES_DELETE,
        payload.toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Referer: `${Endpoints.BASE_URL}/direct/inbox/`
          }
        },
        false
      );
    } catch (err) {
      if (err instanceof AuthenticationError || err instanceof RateLimitError) throw err;
      const msg = err.message || '';
      if (
        msg.toLowerCase().includes('something went wrong') ||
        msg.toLowerCase().includes("we're sorry")
      ) {
        this._handleNoteApiError(err.details || { message: msg }, `Failed to delete note ${targetId}`);
      }
      if (this.logger && typeof this.logger.debug === 'function') {
        this.logger.debug(`NOTES_DELETE primary failed (${err.message}), retrying web fallback...`);
      }
      try {
        response = await this.transport.post(
          Endpoints.NOTES_DELETE_WEB,
          payload.toString(),
          {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              Referer: `${Endpoints.BASE_URL}/direct/inbox/`
            }
          },
          false
        );
      } catch (fallbackErr) {
        if (fallbackErr instanceof AuthenticationError || fallbackErr instanceof RateLimitError) throw fallbackErr;
        this._handleNoteApiError(fallbackErr.details || { message: fallbackErr.message }, `Failed to delete note ${targetId}`);
      }
    }

    const data = response.data || {};
    if (data.status && data.status !== 'ok') {
      this._handleNoteApiError(data, `Failed to delete note ${targetId}`);
    }

    if (this.logger && typeof this.logger.info === 'function') {
      this.logger.info(`Deleted Direct Note: ${targetId}`);
    }

    return {
      success: true,
      noteId: targetId
    };
  }

  /**
   * Likes an Instagram Note.
   *
   * @param {string|number} noteId - Target note ID
   * @returns {Promise<{success: boolean, noteId: string, liked: boolean}>}
   */
  async likeNote(noteId) {
    if (!noteId) {
      throw new ValidationError('noteId must be provided.', { field: 'noteId' });
    }

    const cleanId = String(noteId).trim();
    const csrfToken = this.session ? this.session.getCsrfToken() : '';

    const payload = new URLSearchParams();
    if (csrfToken) {
      payload.append('_csrftoken', csrfToken);
    }

    let response;
    try {
      response = await this.transport.post(
        Endpoints.NOTE_LIKE(cleanId),
        payload.toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Referer: `${Endpoints.BASE_URL}/direct/inbox/`
          }
        },
        false
      );
    } catch (err) {
      if (err instanceof AuthenticationError || err instanceof RateLimitError) throw err;
      this._handleNoteApiError(err.details || { message: err.message }, `Failed to like note ${cleanId}`);
    }

    const data = response.data || {};
    if (data.status && data.status !== 'ok') {
      this._handleNoteApiError(data, `Failed to like note ${cleanId}`);
    }

    return {
      success: true,
      noteId: cleanId,
      liked: true,
      status: data.status || 'ok'
    };
  }

  /**
   * Unlikes an Instagram Note.
   *
   * @param {string|number} noteId - Target note ID
   * @returns {Promise<{success: boolean, noteId: string, liked: boolean}>}
   */
  async unlikeNote(noteId) {
    if (!noteId) {
      throw new ValidationError('noteId must be provided.', { field: 'noteId' });
    }

    const cleanId = String(noteId).trim();
    const csrfToken = this.session ? this.session.getCsrfToken() : '';

    const payload = new URLSearchParams();
    if (csrfToken) {
      payload.append('_csrftoken', csrfToken);
    }

    let response;
    try {
      response = await this.transport.post(
        Endpoints.NOTE_UNLIKE(cleanId),
        payload.toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Referer: `${Endpoints.BASE_URL}/direct/inbox/`
          }
        },
        false
      );
    } catch (err) {
      if (err instanceof AuthenticationError || err instanceof RateLimitError) throw err;
      this._handleNoteApiError(err.details || { message: err.message }, `Failed to unlike note ${cleanId}`);
    }

    const data = response.data || {};
    if (data.status && data.status !== 'ok') {
      this._handleNoteApiError(data, `Failed to unlike note ${cleanId}`);
    }
    return {
      success: true,
      noteId: cleanId,
      liked: false,
      status: data.status || 'ok'
    };
  }

  /**
   * Sends a direct message reply to the creator of a note referencing that note.
   *
   * @param {string|number} noteIdOrNote - Note ID or Note instance
   * @param {string} replyText - The reply text
   * @param {Object} [options]
   * @returns {Promise<import('../models/message')>}
   */
  async replyToNote(noteIdOrNote, replyText, options = {}) {
    if (!replyText || !String(replyText).trim()) {
      throw new ValidationError('replyText must be a non-empty string.', { field: 'replyText' });
    }

    let note = null;
    let targetUserId = null;

    if (noteIdOrNote instanceof Note) {
      note = noteIdOrNote;
      targetUserId = note.userId;
    } else if (typeof noteIdOrNote === 'object' && noteIdOrNote && noteIdOrNote.id) {
      note = Note.fromRaw(noteIdOrNote, this.currentUserId);
      targetUserId = note.userId;
    } else if (noteIdOrNote) {
      const cleanId = String(noteIdOrNote).trim();
      const { notes } = await this.getNotes();
      note = notes.find((n) => n.id === cleanId) || null;
      if (note) {
        targetUserId = note.userId;
      }
    }

    if (!targetUserId) {
      throw new NotFoundError(`Note "${noteIdOrNote}" not found in current inbox tray.`);
    }

    // Resolve or find conversation thread with target author
    let conversationId = options.threadId || options.conversationId || null;
    if (!conversationId && this.conversationsService) {
      const authorUsername = note && note.user ? note.user.username : null;
      if (authorUsername) {
        const found = await this.conversationsService.findByUsername(authorUsername);
        if (found) {
          conversationId = found.id;
        }
      }
    }

    if (!conversationId) {
      throw new InstaChatError(
        `Unable to resolve thread ID for note author (${targetUserId}). Please provide options.threadId.`,
        { code: 'THREAD_RESOLUTION_FAILED' }
      );
    }

    if (!this.messagesService) {
      throw new InstaChatError('MessagesService is required to send note replies.', {
        code: 'SERVICE_UNAVAILABLE'
      });
    }

    const noteContextText = note && note.text ? `[Replying to Note: "${note.text}"]\n${replyText}` : replyText;
    return this.messagesService.sendTextMessage(conversationId, noteContextText, options);
  }
}

module.exports = NotesService;
