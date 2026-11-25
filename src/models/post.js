'use strict';

const User = require('./user');

const MEDIA_TYPE_MAP = Object.freeze({
  1: 'image',
  2: 'video',
  8: 'carousel'
});

/**
 * Picks the highest-resolution image candidate URL from an Instagram media payload.
 *
 * @param {Object} raw
 * @returns {{url: string|null, width: number|null, height: number|null}}
 */
function extractBestImage(raw = {}) {
  const candidates =
    raw.image_versions2 && Array.isArray(raw.image_versions2.candidates)
      ? raw.image_versions2.candidates
      : [];

  if (candidates.length > 0) {
    const best = candidates[0] || {};
    return {
      url: best.url || null,
      width: best.width ? Number(best.width) : (raw.original_width ? Number(raw.original_width) : null),
      height: best.height ? Number(best.height) : (raw.original_height ? Number(raw.original_height) : null)
    };
  }

  const fallbackUrl = raw.display_url || raw.thumbnail_src || raw.imageUrl || null;
  return {
    url: fallbackUrl,
    width: raw.original_width ? Number(raw.original_width) : (raw.width ? Number(raw.width) : null),
    height: raw.original_height ? Number(raw.original_height) : (raw.height ? Number(raw.height) : null)
  };
}

/**
 * Picks the primary video candidate URL from an Instagram media payload.
 *
 * @param {Object} raw
 * @returns {{url: string|null, width: number|null, height: number|null}}
 */
function extractBestVideo(raw = {}) {
  const versions = Array.isArray(raw.video_versions) ? raw.video_versions : [];
  if (versions.length > 0) {
    const best = versions[0] || {};
    return {
      url: best.url || null,
      width: best.width ? Number(best.width) : null,
      height: best.height ? Number(best.height) : null
    };
  }
  return {
    url: raw.video_url || raw.videoUrl || null,
    width: null,
    height: null
  };
}

/**
 * Normalized Instagram Feed Post / Carousel / Reel Model
 */
class Post {
  /**
   * @param {Object} [data={}] - Raw media payload from Instagram API
   */
  constructor(data = {}) {
    const raw = (data && data.media && typeof data.media === 'object') ? data.media : (data || {});

    const pkVal = raw.pk !== undefined && raw.pk !== null
      ? String(raw.pk)
      : (raw.id ? String(raw.id).split('_')[0] : '');

    this.pk = pkVal;
    this.id = raw.id ? String(raw.id) : pkVal;
    this.code = raw.code || raw.shortcode || null;
    this.productType = raw.product_type || raw.productType || null;
    this.mediaTypeCode = Number(raw.media_type || raw.mediaTypeCode || (raw.video_versions || raw.video_url ? 2 : 1));

    const isClips =
      this.productType === 'clips' ||
      Boolean(raw.clips_metadata) ||
      Boolean(raw.isReel);

    this.isCarousel = this.mediaTypeCode === 8 || Array.isArray(raw.carousel_media);
    this.isReel = Boolean(isClips);
    this.isVideo = this.mediaTypeCode === 2 || Boolean(raw.video_versions || raw.video_url || this.isReel);
    this.mediaType = this.isReel
      ? 'reel'
      : (MEDIA_TYPE_MAP[this.mediaTypeCode] || (this.isCarousel ? 'carousel' : (this.isVideo ? 'video' : 'image')));

    this.url = this.code
      ? `https://www.instagram.com/${this.isReel ? 'reel' : 'p'}/${this.code}/`
      : (raw.permalink || raw.url || null);

    // Caption text
    if (typeof raw.caption === 'string') {
      this.caption = raw.caption;
    } else if (raw.caption && typeof raw.caption.text === 'string') {
      this.caption = raw.caption.text;
    } else if (
      raw.edge_media_to_caption &&
      Array.isArray(raw.edge_media_to_caption.edges) &&
      raw.edge_media_to_caption.edges[0] &&
      raw.edge_media_to_caption.edges[0].node
    ) {
      this.caption = String(raw.edge_media_to_caption.edges[0].node.text || '');
    } else {
      this.caption = '';
    }

    // Author / owner
    const rawUser = raw.user || raw.owner || null;
    this.user = rawUser ? (rawUser instanceof User ? rawUser : User.fromRaw(rawUser)) : null;
    this.userId = String(
      (this.user && this.user.id) ||
      raw.user_id ||
      (this.id && this.id.includes('_') ? this.id.split('_')[1] : '') ||
      ''
    );

    // Counts & interaction state
    this.likeCount = raw.like_count !== undefined && raw.like_count !== null
      ? Number(raw.like_count)
      : (raw.edge_media_preview_like && raw.edge_media_preview_like.count !== undefined
          ? Number(raw.edge_media_preview_like.count)
          : null);
    this.commentCount = raw.comment_count !== undefined && raw.comment_count !== null
      ? Number(raw.comment_count)
      : (raw.edge_media_to_comment && raw.edge_media_to_comment.count !== undefined
          ? Number(raw.edge_media_to_comment.count)
          : null);
    this.playCount = raw.play_count !== undefined && raw.play_count !== null
      ? Number(raw.play_count)
      : (raw.ig_play_count !== undefined && raw.ig_play_count !== null ? Number(raw.ig_play_count) : null);
    this.viewCount = raw.view_count !== undefined && raw.view_count !== null
      ? Number(raw.view_count)
      : (raw.video_view_count !== undefined && raw.video_view_count !== null ? Number(raw.video_view_count) : null);

    this.hasLiked = Boolean(raw.has_liked || raw.viewer_has_liked || raw.hasLiked);
    this.hasSaved = Boolean(raw.has_viewer_saved || raw.viewer_has_saved || raw.hasSaved);
    this.commentsDisabled = Boolean(raw.comments_disabled || raw.commentsDisabled);

    // Media assets
    const img = extractBestImage(raw);
    const vid = extractBestVideo(raw);
    this.imageUrl = img.url;
    this.videoUrl = vid.url;
    this.width = img.width || vid.width || null;
    this.height = img.height || vid.height || null;
    this.duration = raw.video_duration !== undefined && raw.video_duration !== null
      ? Number(raw.video_duration)
      : null;

    this.carouselMedia = Array.isArray(raw.carousel_media)
      ? raw.carousel_media.map((child) => {
          const childImg = extractBestImage(child);
          const childVid = extractBestVideo(child);
          const childTypeCode = Number(child.media_type || (childVid.url ? 2 : 1));
          return {
            id: String(child.id || child.pk || ''),
            pk: String(child.pk || (child.id ? String(child.id).split('_')[0] : '')),
            mediaType: MEDIA_TYPE_MAP[childTypeCode] || 'image',
            imageUrl: childImg.url,
            videoUrl: childVid.url,
            width: childImg.width || childVid.width || null,
            height: childImg.height || childVid.height || null
          };
        })
      : [];

    // Timestamp (seconds or milliseconds)
    const rawTaken = Number(raw.taken_at || raw.taken_at_timestamp || raw.device_timestamp || 0);
    if (rawTaken > 0) {
      this.timestamp = rawTaken > 1e14
        ? Math.floor(rawTaken / 1000)
        : (rawTaken > 1e11 ? rawTaken : rawTaken * 1000);
    } else {
      this.timestamp = Date.now();
    }
    this.takenAt = new Date(this.timestamp);

    this.raw = data;
  }

  static fromRaw(raw) {
    if (!raw) return null;
    return new Post(raw);
  }

  toJSON() {
    return {
      id: this.id,
      pk: this.pk,
      code: this.code,
      url: this.url,
      mediaType: this.mediaType,
      productType: this.productType,
      isReel: this.isReel,
      isVideo: this.isVideo,
      isCarousel: this.isCarousel,
      caption: this.caption,
      userId: this.userId,
      user: this.user ? this.user.toJSON() : null,
      likeCount: this.likeCount,
      commentCount: this.commentCount,
      playCount: this.playCount,
      viewCount: this.viewCount,
      hasLiked: this.hasLiked,
      hasSaved: this.hasSaved,
      commentsDisabled: this.commentsDisabled,
      imageUrl: this.imageUrl,
      videoUrl: this.videoUrl,
      width: this.width,
      height: this.height,
      duration: this.duration,
      carouselMedia: this.carouselMedia,
      timestamp: this.timestamp,
      takenAt: this.takenAt.toISOString()
    };
  }
}

module.exports = Post;
