'use strict';

const User = require('./user');

/**
 * Normalized Instagram Direct Note Model
 */
class Note {
  /**
   * @param {Object} data - Raw note object from Instagram API
   * @param {string} [currentUserId=null] - Authenticated user ID
   */
  constructor(data = {}, currentUserId = null) {
    const raw = data.node ? (data.node.note || data.node) : data;

    this.id = String(raw.id || raw.note_id || raw.pk || '');
    this.text = String(raw.text || raw.content || '').trim();
    this.userId = String(raw.user_id || (raw.user && (raw.user.pk || raw.user.id)) || '');

    // Parse creator
    this.user = raw.user
      ? (raw.user instanceof User ? raw.user : new User(raw.user, currentUserId))
      : null;

    // Timestamps
    const rawCreated = Number(raw.created_at || raw.created_at_timestamp || 0);
    this.createdAt = rawCreated > 0
      ? (rawCreated > 1e11 ? Math.floor(rawCreated / 1000) : rawCreated) * 1000
      : Date.now();

    const rawExpires = Number(raw.expires_at || raw.expires_at_timestamp || 0);
    this.expiresAt = rawExpires > 0
      ? (rawExpires > 1e11 ? Math.floor(rawExpires / 1000) : rawExpires) * 1000
      : this.createdAt + 24 * 60 * 60 * 1000;

    // Audience: 0 = Mutual Followers, 1 = Close Friends
    this.audience = Number(raw.audience !== undefined ? raw.audience : 0);
    this.audienceName = this.audience === 1 ? 'close_friends' : 'mutual_followers';

    // State & reactions
    this.isSelf = Boolean(currentUserId && String(this.userId) === String(currentUserId));
    this.isLiked = Boolean(raw.is_liked_by_viewer || raw.viewer_has_liked || raw.has_liked);
    this.likeCount = Number(raw.like_count || raw.likes_count || (raw.likes && raw.likes.count) || 0);
    this.hasTranslation = Boolean(raw.has_translation);

    // Media (music / audio / video if present)
    this.media = null;
    if (raw.media || raw.audio_info || raw.music_info || raw.music_asset_info) {
      const music = raw.music_info || raw.music_asset_info || (raw.media && raw.media.music_info);
      this.media = {
        type: music ? 'music' : (raw.media && raw.media.type) || 'audio',
        title: (music && (music.title || music.display_artist)) || null,
        artist: (music && (music.artist_name || music.display_artist)) || null,
        audioClusterId: (music && music.audio_cluster_id) || raw.audio_cluster_id || null,
        raw: raw.media || music
      };
    }

    // Mentioned users
    this.mentionedUsers = Array.isArray(raw.e2ee_mentioned_user_list)
      ? raw.e2ee_mentioned_user_list.map((u) => String(u.pk || u.id || u))
      : [];

    this.raw = data;
  }

  get isExpired() {
    return Date.now() > this.expiresAt;
  }

  get remainingMs() {
    return Math.max(0, this.expiresAt - Date.now());
  }

  static fromRaw(raw, currentUserId = null) {
    if (!raw) return null;
    return new Note(raw, currentUserId);
  }

  toJSON() {
    return {
      id: this.id,
      text: this.text,
      userId: this.userId,
      user: this.user ? this.user.toJSON() : null,
      createdAt: this.createdAt,
      expiresAt: this.expiresAt,
      isExpired: this.isExpired,
      remainingMs: this.remainingMs,
      audience: this.audience,
      audienceName: this.audienceName,
      isSelf: this.isSelf,
      isLiked: this.isLiked,
      likeCount: this.likeCount,
      hasTranslation: this.hasTranslation,
      media: this.media,
      mentionedUsers: this.mentionedUsers
    };
  }
}

module.exports = Note;
