'use strict';

const User = require('./user');
const Message = require('./message');

/**
 * Normalized Instagram Direct Conversation / Thread Model
 */
class Conversation {
  constructor(data = {}, currentUserId = null) {
    this._currentUserId = currentUserId ? String(currentUserId) : null;
    // Unpack GraphQL node / as_ig_direct_thread if provided
    const raw = data.node
      ? (data.node.as_ig_direct_thread || data.node)
      : (data.as_ig_direct_thread || data);

    this.id = String(raw.thread_fbid || raw.thread_key || raw.id || raw.thread_id || '');
    this.v2Id = raw.thread_id ? String(raw.thread_id) : (raw.thread_v2_id ? String(raw.thread_v2_id) : null);
    this.isGroup = Boolean(raw.is_group || (raw.thread_subtype !== undefined && Number(raw.thread_subtype) > 0 && Array.isArray(raw.users) && raw.users.length > 1));
    this.muted = Boolean(raw.muted || raw.is_muted);
    this.isPinned = Boolean(raw.is_pinned || raw.pinned_timestamp);
    this.folder = raw.folder !== undefined ? raw.folder : null;
    this.systemFolder = raw.system_folder || null;
    this.imageUrl = raw.thread_image_url || (raw.thread_image && raw.thread_image.url) || null;

    // Group admins
    this.adminUserIds = Array.isArray(raw.admin_user_ids)
      ? raw.admin_user_ids.map((id) => String(id))
      : [];

    // Parse participants
    this.participants = [];
    if (Array.isArray(raw.users)) {
      this.participants = raw.users.map((u) => (u instanceof User ? u : new User(u)));
    }

    // Build lookup for participant interop fbid -> Instagram user id
    const fbidMap = {};
    if (raw.viewer && raw.viewer.interop_messaging_user_fbid) {
      fbidMap[raw.viewer.interop_messaging_user_fbid] = String(raw.viewer.id || raw.viewer_id || currentUserId || '');
    }
    if (Array.isArray(raw.users)) {
      for (const u of raw.users) {
        if (u && u.interop_messaging_user_fbid) {
          fbidMap[u.interop_messaging_user_fbid] = String(u.id || u.pk || '');
        }
      }
    }

    // Normalize custom nicknames ({ [userId]: nickname })
    this.nicknames = this._extractNicknames(raw, fbidMap);

    // Determine thread title
    if (raw.thread_title) {
      this.title = raw.thread_title;
    } else if (this.participants.length > 0) {
      this.title = this.participants.map((u) => u.username || u.fullName).filter(Boolean).join(', ');
    } else {
      this.title = 'Direct Message';
    }

    // Parse messages inside thread
    this.messages = [];
    if (Array.isArray(raw.items)) {
      this.messages = raw.items.map((item) => {
        return item instanceof Message
          ? item
          : new Message({ ...item, thread_id: this.id }, currentUserId, this.participants);
      });
    } else if (raw.slide_messages && Array.isArray(raw.slide_messages.edges)) {
      for (const edge of raw.slide_messages.edges) {
        const node = edge && edge.node;
        const s = node && node.sender;
        if (s && s.id && (s.igid || (s.user_dict && s.user_dict.id))) {
          fbidMap[s.id] = String(s.igid || s.user_dict.id);
        }
        if (node && Array.isArray(node.msg_reactions)) {
          for (const mr of node.msg_reactions) {
            if (mr && mr.sender_fbid && mr.sender_igid) {
              fbidMap[mr.sender_fbid] = String(mr.sender_igid);
            }
          }
        }
      }

      this.messages = raw.slide_messages.edges.map((edge) => {
        const node = edge.node || {};
        const senderId = (node.sender && node.sender.igid) || fbidMap[node.sender_fbid] || node.sender_fbid || '';
        const rawReply = node.replied_to_message || node.reply_source_message || null;
        let normalizedReply = null;
        if (rawReply) {
          const replySenderFbid = rawReply.sender_fbid || (rawReply.sender && rawReply.sender.id) || '';
          const resolvedReplyUserId =
            rawReply.user_id ||
            (rawReply.sender && rawReply.sender.igid) ||
            fbidMap[replySenderFbid] ||
            replySenderFbid;
          normalizedReply = {
            ...rawReply,
            user_id: resolvedReplyUserId
          };
        }

        let normalizedReactions = null;
        if (Array.isArray(node.reactions)) {
          normalizedReactions = node.reactions.map((r) => ({
            ...r,
            sender_igid: r.sender_igid || fbidMap[r.sender_fbid] || r.sender_fbid || ''
          }));
        }

        const item = {
          item_id: node.message_id || node.id,
          thread_id: this.id,
          user_id: senderId,
          item_type: (node.content_type || 'text').toLowerCase(),
          text: node.text_body || (node.content && node.content.text_body) || '',
          timestamp: Number(node.timestamp_ms || Date.now()) * 1000,
          reactions: normalizedReactions,
          replied_to_message_id: node.replied_to_message_id || null,
          replied_to_message: normalizedReply,
          is_pinned: Boolean(node.is_pinned),
          igd_is_forwarded: Boolean(node.igd_is_forwarded || node.is_forwarded),
          slide_edit_history: node.slide_edit_history || null,
          animated_media: node.animated_media || null
        };
        return new Message(item, currentUserId, this.participants);
      });
    }

    // Pinned messages
    if (Array.isArray(raw.pinned_messages)) {
      this.pinnedMessages = raw.pinned_messages.map((pm) =>
        pm instanceof Message ? pm : new Message({ ...pm, thread_id: this.id, is_pinned: true }, currentUserId, this.participants)
      );
    } else {
      this.pinnedMessages = this.messages.filter((m) => m.isPinned);
    }

    // Read receipts / watermarks per participant
    this.readReceipts = this._extractReadReceipts(raw, fbidMap);

    // Last message
    this.lastMessage = this.messages.length > 0 ? this.messages[0] : null;

    // Activity timestamp
    const rawActivity = Number(raw.last_activity_timestamp_ms || raw.last_activity_at || 0);
    this.lastActivityAt = rawActivity > 1e14 ? Math.floor(rawActivity / 1000) : rawActivity;

    // Read state
    this.readState = raw.read_state !== undefined ? Number(raw.read_state) : 0;
    this.hasUnread = Boolean(raw.has_unseen || raw.marked_as_unread || this.readState > 0);

    // Chat theme
    this.themeId = null;
    if (raw.theme) {
      this.themeId = raw.theme.theme_id || raw.theme.id || null;
    } else if (raw.theme_data) {
      this.themeId = raw.theme_data.theme_id || raw.theme_data.id || null;
    }

    // Detection for End-to-End Encrypted (E2EE) threads
    this.isEncrypted = Boolean(
      raw.is_pin_protected ||
      raw.thread_type === 'e2ee' ||
      raw.e2ee_thread_id ||
      (raw.thread_title && raw.thread_title.toLowerCase().includes('end-to-end encrypted'))
    );

    this.raw = data;
  }

  _extractNicknames(raw, fbidMap = {}) {
    const map = {};
    const source = raw.nicknames || raw.participant_nicknames;
    if (!source) return map;

    if (Array.isArray(source)) {
      for (const entry of source) {
        if (!entry) continue;
        const rawUid = String(
          entry.user_id ||
          entry.igid ||
          entry.participant_igid ||
          fbidMap[entry.participant_fbid || entry.fbid] ||
          entry.participant_fbid ||
          entry.id ||
          ''
        );
        const nick = entry.nickname || entry.custom_nickname || '';
        if (rawUid && nick) {
          map[rawUid] = String(nick);
        }
      }
      return map;
    }

    if (typeof source === 'object') {
      for (const [k, v] of Object.entries(source)) {
        const resolvedKey = fbidMap[k] || k;
        if (typeof v === 'string' && v) {
          map[resolvedKey] = v;
        } else if (v && typeof v === 'object' && v.nickname) {
          map[resolvedKey] = String(v.nickname);
        }
      }
    }

    return map;
  }

  _extractReadReceipts(raw, fbidMap = {}) {
    const receipts = [];
    if (Array.isArray(raw.slide_read_receipts)) {
      for (const r of raw.slide_read_receipts) {
        if (!r) continue;
        const eimu = String(r.participant_eimu_id || r.participant_fbid || '');
        const rawTs = Number(r.watermark_timestamp_ms || r.timestamp_ms || 0);
        receipts.push({
          userId: fbidMap[eimu] || String(r.user_id || eimu),
          interopFbid: eimu || null,
          messageId: r.item_id || r.message_id || null,
          timestamp: rawTs > 1e14 ? Math.floor(rawTs / 1000) : rawTs
        });
      }
      return receipts;
    }

    if (raw.last_seen_at && typeof raw.last_seen_at === 'object') {
      for (const [uid, info] of Object.entries(raw.last_seen_at)) {
        if (!info) continue;
        const rawTs = Number(info.timestamp || 0);
        receipts.push({
          userId: String(uid),
          interopFbid: null,
          messageId: info.item_id ? String(info.item_id) : null,
          timestamp: rawTs > 1e14 ? Math.floor(rawTs / 1000) : rawTs
        });
      }
    }

    return receipts;
  }

  get isViewerAdmin() {
    if (!this._currentUserId || !Array.isArray(this.adminUserIds)) return false;
    return this.adminUserIds.includes(String(this._currentUserId));
  }

  static fromRaw(raw, currentUserId = null) {
    if (!raw) return null;
    return new Conversation(raw, currentUserId);
  }

  toJSON() {
    return {
      id: this.id,
      v2Id: this.v2Id,
      title: this.title,
      isGroup: this.isGroup,
      muted: this.muted,
      isPinned: this.isPinned,
      folder: this.folder,
      systemFolder: this.systemFolder,
      imageUrl: this.imageUrl,
      adminUserIds: this.adminUserIds,
      nicknames: this.nicknames,
      participants: this.participants.map((u) => u.toJSON()),
      pinnedMessages: this.pinnedMessages.map((m) => m.toJSON()),
      readReceipts: this.readReceipts,
      lastMessage: this.lastMessage ? this.lastMessage.toJSON() : null,
      lastActivityAt: this.lastActivityAt,
      hasUnread: this.hasUnread,
      themeId: this.themeId,
      isEncrypted: this.isEncrypted
    };
  }
}

module.exports = Conversation;
