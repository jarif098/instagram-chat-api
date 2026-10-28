'use strict';

const User = require('./user');

/**
 * Normalized Instagram Direct Message Model
 */
class Message {
  constructor(data = {}, currentUserId = null, threadUsers = []) {
    this.id = String(data.item_id || data.message_id || data.id || '');
    this.messageID = this.id;
    this.threadId = String(data.thread_id || data.threadId || data.thread_fbid || '');
    this.senderId = String(data.user_id || data.senderId || data.userId || '');
    this.type = data.item_type || data.type || 'text';

    // Normalize timestamp (Instagram uses microsecond timestamps)
    const rawTimestamp = Number(data.timestamp || Date.now() * 1000);
    this.timestamp = rawTimestamp > 1e14 ? Math.floor(rawTimestamp / 1000) : rawTimestamp;
    this.createdAt = new Date(this.timestamp);

    this.isSelf = Boolean(currentUserId && String(currentUserId) === this.senderId);

    // Resolve sender details if thread users provided
    this.sender = null;
    if (threadUsers && threadUsers.length > 0) {
      const foundUser = threadUsers.find((u) => String(u.pk || u.id) === this.senderId);
      if (foundUser) {
        this.sender = foundUser instanceof User ? foundUser : new User(foundUser);
      }
    }
    if (!this.sender) {
      this.sender = new User({ pk: this.senderId });
    }

    // Extract text
    this.text = this._extractText(data);

    // Extract media & rich shares (images, videos, voice, GIFs, stickers, links, posts, reels, stories, polls)
    this.media = this._extractMedia(data);
    this.share = this._extractShare(data);

    // Extract reactions
    this.reactions = this._extractReactions(data);

    // Extract reply reference
    this.replyTo = this._extractReply(data);

    // Advanced message flags & metadata
    this.isPinned = Boolean(data.is_pinned || data.isPinned);
    this.isForwarded = Boolean(data.igd_is_forwarded || data.is_forwarded || data.isForwarded);
    this.editHistory = this._extractEditHistory(data);
    this.isEdited = Boolean(data.is_edited || data.isEdited || this.editHistory.length > 0);
    this.mentions = this._extractMentions(data);

    this.raw = data;
  }

  _extractText(data) {
    if (typeof data.text === 'string') return data.text;
    if (data.link && typeof data.link.text === 'string') return data.link.text;
    if (data.item_type === 'like') return '❤️';
    if (data.placeholder && typeof data.placeholder.message === 'string') {
      return data.placeholder.message;
    }
    return '';
  }

  _extractMedia(data) {
    if (data.item_type === 'media' && data.media) {
      const media = data.media;
      const isVideo = media.media_type === 2 || Boolean(media.video_versions);
      const candidates = media.image_versions2 && media.image_versions2.candidates ? media.image_versions2.candidates : [];
      const primaryImage = candidates[0] || {};
      const videoCandidate = isVideo && media.video_versions ? media.video_versions[0] : null;

      return {
        type: isVideo ? 'video' : 'image',
        url: isVideo && videoCandidate ? videoCandidate.url : primaryImage.url || null,
        width: primaryImage.width || (videoCandidate && videoCandidate.width) || null,
        height: primaryImage.height || (videoCandidate && videoCandidate.height) || null,
        originalWidth: media.original_width || null,
        originalHeight: media.original_height || null,
        duration: isVideo ? media.video_duration || null : null
      };
    }

    if (data.item_type === 'voice_media' && data.voice_media) {
      const audio = data.voice_media.media && data.voice_media.media.audio;
      return {
        type: 'audio',
        url: audio ? audio.audio_src : null,
        duration: audio ? audio.duration : null
      };
    }

    if ((data.item_type === 'animated_media' || data.animated_media) && data.animated_media) {
      const am = data.animated_media;
      const fixed = (am.images && am.images.fixed_height) || am;
      return {
        type: am.is_sticker ? 'sticker' : 'gif',
        id: am.id ? String(am.id) : null,
        url: fixed.url || am.attachment_webp_url || am.attachment_mp4_url || am.url || null,
        mp4Url: fixed.mp4 || am.attachment_mp4_url || null,
        webpUrl: fixed.webp || am.attachment_webp_url || null,
        width: fixed.width ? Number(fixed.width) : null,
        height: fixed.height ? Number(fixed.height) : null
      };
    }

    if (data.store_sticker || data.static_stickers) {
      const st = data.store_sticker || (Array.isArray(data.static_stickers) ? data.static_stickers[0] : data.static_stickers) || {};
      return {
        type: 'sticker',
        id: st.sticker_id || st.id ? String(st.sticker_id || st.id) : null,
        url: st.image_url || st.url || null,
        width: st.width ? Number(st.width) : null,
        height: st.height ? Number(st.height) : null
      };
    }

    return null;
  }

  _extractShare(data) {
    if (!data) return null;

    if (data.link && data.link.link_context) {
      const ctx = data.link.link_context;
      return {
        type: 'link',
        url: ctx.link_url || null,
        title: ctx.link_title || null,
        summary: ctx.link_summary || null,
        imageUrl: ctx.link_image_url || null
      };
    }

    if (data.clip && data.clip.clip) {
      const c = data.clip.clip;
      return {
        type: 'reel',
        mediaId: String(c.pk || c.id || ''),
        code: c.code || null,
        caption: c.caption && c.caption.text ? c.caption.text : '',
        ownerUsername: c.user && c.user.username ? c.user.username : null
      };
    }

    if (data.media_share) {
      const ms = data.media_share;
      return {
        type: 'post',
        mediaId: String(ms.pk || ms.id || ''),
        code: ms.code || null,
        caption: ms.caption && ms.caption.text ? ms.caption.text : '',
        ownerUsername: ms.user && ms.user.username ? ms.user.username : null
      };
    }

    if (data.story_share || data.reel_share) {
      const ss = data.story_share || data.reel_share;
      const sm = ss.media || {};
      return {
        type: 'story',
        mediaId: String(sm.pk || sm.id || ss.reel_id || ''),
        text: ss.text || ss.message || '',
        ownerUsername: sm.user && sm.user.username ? sm.user.username : null
      };
    }

    if (data.profile) {
      return {
        type: 'profile',
        userId: String(data.profile.pk || data.profile.id || ''),
        username: data.profile.username || '',
        fullName: data.profile.full_name || ''
      };
    }

    if (data.group_poll || data.poll) {
      const poll = data.group_poll || data.poll;
      return {
        type: 'poll',
        pollId: String(poll.poll_id || poll.id || ''),
        question: poll.question || '',
        options: Array.isArray(poll.options)
          ? poll.options.map((opt) => ({
              id: String(opt.id || opt.option_id || ''),
              text: opt.text || opt.option_text || '',
              count: Number(opt.count || opt.vote_count || 0)
            }))
          : []
      };
    }

    return null;
  }

  _extractEditHistory(data) {
    const rawHist = data.slide_edit_history || data.edit_history;
    if (!Array.isArray(rawHist)) return [];
    return rawHist
      .filter(Boolean)
      .map((entry) => {
        const rawTs = Number(entry.timestamp_ms || entry.timestamp || 0);
        return {
          text: entry.body || entry.text_body || entry.text || '',
          timestamp: rawTs > 1e14 ? Math.floor(rawTs / 1000) : rawTs || null
        };
      });
  }

  _extractMentions(data) {
    const rawMentions = data.mentions || data.mentioned_users;
    if (!Array.isArray(rawMentions)) return [];
    return rawMentions
      .filter(Boolean)
      .map((m) => ({
        userId: String(m.user_id || m.mentioned_user_id || m.id || m.pk || ''),
        username: m.username || null,
        offset: m.offset !== undefined ? Number(m.offset) : null,
        length: m.length !== undefined ? Number(m.length) : null
      }));
  }

  _extractReactions(data) {
    const list = [];
    if (!data.reactions) return list;

    // GraphQL SlideMessage reactions array
    if (Array.isArray(data.reactions)) {
      for (const rec of data.reactions) {
        if (!rec) continue;
        const rawEmoji = rec.emoji || rec.reaction || '❤️';
        const emoji = rawEmoji === '❤' ? '❤️' : rawEmoji;
        list.push({
          senderId: String(rec.senderId || rec.sender_igid || rec.user_id || rec.sender_id || rec.sender_fbid || ''),
          emoji,
          timestamp: rec.timestamp ? (rec.timestamp > 1e14 ? Math.floor(rec.timestamp / 1000) : rec.timestamp) : null
        });
      }
      return list;
    }

    // Like reactions
    if (Array.isArray(data.reactions.likes)) {
      for (const like of data.reactions.likes) {
        list.push({
          senderId: String(like.sender_id || like.user_id),
          emoji: '❤️',
          timestamp: like.timestamp ? Math.floor(like.timestamp / 1000) : null
        });
      }
    }

    // Custom emoji reactions
    if (Array.isArray(data.reactions.emojis)) {
      for (const reaction of data.reactions.emojis) {
        list.push({
          senderId: String(reaction.sender_id || reaction.user_id),
          emoji: reaction.emoji || '❤️',
          timestamp: reaction.timestamp ? Math.floor(reaction.timestamp / 1000) : null
        });
      }
    }

    return list;
  }

  _extractReply(data) {
    if (!data) return null;
    const rep = data.replied_to_message || data.reply_to_message || data.reply_source_message;
    if (rep) {
      const repId = String(rep.item_id || rep.message_id || rep.id || data.replied_to_message_id || '');
      if (repId) {
        return {
          id: repId,
          senderId: String(
            rep.user_id ||
            rep.sender_igid ||
            (rep.sender && (rep.sender.igid || (rep.sender.user_dict && rep.sender.user_dict.id) || rep.sender.id)) ||
            rep.sender_id ||
            rep.sender_fbid ||
            ''
          ),
          text: rep.text || rep.text_body || (rep.content && rep.content.text_body) || '',
          type: (rep.item_type || rep.content_type || 'text').toLowerCase()
        };
      }
    }
    const bareReplyId = data.replied_to_message_id || data.reply_to_message_id || data.replied_to_item_id;
    if (bareReplyId) {
      return {
        id: String(bareReplyId),
        senderId: '',
        text: '',
        type: 'text'
      };
    }
    return null;
  }

  static fromRaw(raw, currentUserId = null, threadUsers = []) {
    if (!raw) return null;
    return new Message(raw, currentUserId, threadUsers);
  }

  toJSON() {
    return {
      id: this.id,
      threadId: this.threadId,
      senderId: this.senderId,
      sender: this.sender ? this.sender.toJSON() : null,
      type: this.type,
      text: this.text,
      timestamp: this.timestamp,
      createdAt: this.createdAt.toISOString(),
      isSelf: this.isSelf,
      isPinned: this.isPinned,
      isForwarded: this.isForwarded,
      isEdited: this.isEdited,
      editHistory: this.editHistory,
      mentions: this.mentions,
      reactions: this.reactions,
      replyTo: this.replyTo,
      media: this.media,
      share: this.share
    };
  }
}

module.exports = Message;
