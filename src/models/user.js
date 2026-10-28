'use strict';

/**
 * Extracts a numeric count when available, returning null when absent.
 *
 * @param {...any} candidates
 * @returns {number|null}
 */
function pickCount(...candidates) {
  for (const val of candidates) {
    if (val !== undefined && val !== null && val !== '' && !Number.isNaN(Number(val))) {
      return Number(val);
    }
  }
  return null;
}

/**
 * Normalizes optional friendship relationship fields embedded on a user payload.
 *
 * @param {Object} data
 * @returns {Object|null}
 */
function extractFriendship(data) {
  if (!data || typeof data !== 'object') return null;

  if (data.friendship_status && typeof data.friendship_status === 'object') {
    const fs = data.friendship_status;
    return {
      following: Boolean(fs.following),
      followedBy: Boolean(fs.followed_by),
      outgoingRequest: Boolean(fs.outgoing_request),
      incomingRequest: Boolean(fs.incoming_request),
      blocking: Boolean(fs.blocking),
      muting: Boolean(fs.muting),
      isRestricted: Boolean(fs.is_restricted),
      isBestie: Boolean(fs.is_bestie)
    };
  }

  if (
    data.followed_by_viewer !== undefined ||
    data.follows_viewer !== undefined ||
    data.requested_by_viewer !== undefined ||
    data.blocked_by_viewer !== undefined
  ) {
    return {
      following: Boolean(data.followed_by_viewer),
      followedBy: Boolean(data.follows_viewer),
      outgoingRequest: Boolean(data.requested_by_viewer),
      incomingRequest: Boolean(data.has_requested_viewer),
      blocking: Boolean(data.blocked_by_viewer),
      muting: false,
      isRestricted: Boolean(data.is_restricted),
      isBestie: false
    };
  }

  return data.friendship || null;
}

/**
 * Normalized Instagram User & Profile Model
 */
class User {
  constructor(data = {}) {
    this.id = String(data.pk || data.id || data.user_id || '');
    this.interopFbid = data.interop_messaging_user_fbid || data.fbid_v2 || data.interopFbid
      ? String(data.interop_messaging_user_fbid || data.fbid_v2 || data.interopFbid)
      : null;
    this.username = data.username || '';
    this.fullName = data.full_name || data.fullName || '';
    this.profilePicUrl = data.profile_pic_url || data.profilePicUrl || '';
    this.profilePicUrlHd =
      data.profile_pic_url_hd ||
      (data.hd_profile_pic_url_info && data.hd_profile_pic_url_info.url) ||
      data.profilePicUrlHd ||
      this.profilePicUrl ||
      '';
    this.isVerified = Boolean(data.is_verified || data.isVerified);
    this.isPrivate = Boolean(data.is_private || data.isPrivate);

    // Extended profile metadata (populated by profile & user info endpoints)
    this.biography = typeof data.biography === 'string'
      ? data.biography
      : (typeof data.bio === 'string' ? data.bio : '');
    this.externalUrl = data.external_url || data.externalUrl || null;
    this.bioLinks = Array.isArray(data.bio_links)
      ? data.bio_links
          .filter((l) => l && (l.url || l.lynx_url))
          .map((l) => ({ title: l.title || '', url: l.url || l.lynx_url }))
      : (Array.isArray(data.bioLinks) ? data.bioLinks : []);

    this.followerCount = pickCount(
      data.follower_count,
      data.edge_followed_by && data.edge_followed_by.count,
      data.followerCount
    );
    this.followingCount = pickCount(
      data.following_count,
      data.edge_follow && data.edge_follow.count,
      data.followingCount
    );
    this.mediaCount = pickCount(
      data.media_count,
      data.edge_owner_to_timeline_media && data.edge_owner_to_timeline_media.count,
      data.mediaCount
    );

    this.isBusiness = Boolean(
      data.is_business ||
      data.is_business_account ||
      data.is_professional_account ||
      data.isBusiness
    );
    this.category = data.category_name || data.category || null;
    this.pronouns = Array.isArray(data.pronouns) ? data.pronouns.filter(Boolean) : [];
    this.friendship = extractFriendship(data);

    this.raw = data;
  }

  static fromRaw(raw) {
    if (!raw) return null;
    return new User(raw);
  }

  toJSON() {
    return {
      id: this.id,
      interopFbid: this.interopFbid,
      username: this.username,
      fullName: this.fullName,
      profilePicUrl: this.profilePicUrl,
      profilePicUrlHd: this.profilePicUrlHd,
      isVerified: this.isVerified,
      isPrivate: this.isPrivate,
      biography: this.biography,
      externalUrl: this.externalUrl,
      bioLinks: this.bioLinks,
      followerCount: this.followerCount,
      followingCount: this.followingCount,
      mediaCount: this.mediaCount,
      isBusiness: this.isBusiness,
      category: this.category,
      pronouns: this.pronouns,
      friendship: this.friendship
    };
  }
}

module.exports = User;
