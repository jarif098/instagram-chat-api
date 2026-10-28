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
    const base = data.node ? (data.node.note || data.node) : data;
    const raw = base.note_dict ? { ...base, ...base.note_dict } : base;

    this.id = String(raw.id || raw.note_id || raw.inbox_tray_item_id || raw.pk || '');
    this.text = String(raw.text || raw.content || '').trim();

    const pogUser =
      base.pog_info && Array.isArray(base.pog_info.pog_users) && base.pog_info.pog_users.length > 0
        ? base.pog_info.pog_users[0]
        : null;
    const rawUser = raw.user || raw.author || pogUser || null;

    this.userId = String(
      raw.user_id ||
        raw.author_id ||
        (rawUser && (rawUser.pk || rawUser.id || rawUser.strong_id__)) ||
        ''
    );

    // Parse creator
    this.user = rawUser
      ? (rawUser instanceof User ? rawUser : new User(rawUser, currentUserId))
      : null;

    // Timestamps
    const rawCreated = Number(raw.created_at || raw['1lcreated_at'] || raw.created_at_timestamp || 0);
    this.createdAt = rawCreated > 0
      ? (rawCreated > 1e11 ? Math.floor(rawCreated / 1000) : rawCreated) * 1000
      : Date.now();

    const rawExpires = Number(raw.expires_at || raw['1lexpires_at'] || raw.expires_at_timestamp || 0);
    this.expiresAt = rawExpires > 0
      ? (rawExpires > 1e11 ? Math.floor(rawExpires / 1000) : rawExpires) * 1000
      : this.createdAt + 24 * 60 * 60 * 1000;

    // Audience: 0 = Mutual Followers, 1 = Close Friends
    this.audience = Number(raw.audience !== undefined ? raw.audience : 0);
    this.audienceName = this.audience === 1 ? 'close_friends' : 'mutual_followers';

    // State & reactions
    const reactionsList =
      (raw.reaction_info && Array.isArray(raw.reaction_info.reactions) && raw.reaction_info.reactions) ||
      (Array.isArray(raw.reactions) && raw.reactions) ||
      [];
    this.isSelf = Boolean(currentUserId && String(this.userId) === String(currentUserId));
    this.isLiked = Boolean(raw.is_liked_by_viewer || raw.viewer_has_liked || raw.has_liked);
    this.likeCount = Number(
      raw.like_count ||
        raw.likes_count ||
        (raw.likes && raw.likes.count) ||
        reactionsList.length ||
        0
    );
    this.hasTranslation = Boolean(raw.has_translation);

    // Media (music / audio / video if present)
    this.media = null;
    const nestedMusic =
      raw.note_response_info &&
      raw.note_response_info.music_note_response_info &&
      raw.note_response_info.music_note_response_info.music_info &&
      (raw.note_response_info.music_note_response_info.music_info.music_asset_info ||
        raw.note_response_info.music_note_response_info.music_info);

    if (raw.media || raw.audio_info || raw.music_info || raw.music_asset_info || nestedMusic) {
      const music =
        nestedMusic ||
        raw.music_info ||
        raw.music_asset_info ||
        (raw.media && raw.media.music_info);
      this.media = {
        type: music ? 'music' : (raw.media && raw.media.type) || 'audio',
        title: (music && (music.title || music.song_title || music.display_artist)) || null,
        artist: (music && (music.artist_name || music.display_artist)) || null,
        audioClusterId: (music && music.audio_cluster_id) || raw.audio_cluster_id || null,
        audioAssetId: (music && (music.audio_asset_id || music.id)) || null,
        audioUrl: (music && music.progressive_download_url) || null,
        coverArtworkUrl: (music && (music.cover_artwork_uri || music.cover_artwork_thumbnail_uri)) || null,
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
