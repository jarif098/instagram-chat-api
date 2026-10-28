'use strict';

const Endpoints = require('../constants/endpoints');
const { validateThreadId } = require('../utils/validators');
const { ValidationError, InstaChatError } = require('../utils/errors');

/**
 * Normalizes Instagram ARGB / RGB hex strings (e.g. "FF00C7D3") into "#RRGGBB".
 *
 * @param {string} hex
 * @returns {string|null}
 */
function normalizeHexColor(hex) {
  if (!hex || typeof hex !== 'string') return null;
  const clean = hex.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{8}$/.test(clean)) {
    return `#${clean.slice(2).toUpperCase()}`;
  }
  if (/^[0-9a-fA-F]{6}$/.test(clean)) {
    return `#${clean.toUpperCase()}`;
  }
  return `#${clean}`;
}

function slugifyThemeName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function compactKey(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Verified Instagram chat themes mapped to their real Instagram numeric theme_id (FBID)
const VERIFIED_THEMES = Object.freeze([
  { id: 'default', themeId: '3259963564026002', name: 'Default', aliases: ['reset', 'normal', 'standard'], colors: ['#AA00FF', '#0080FF'] },
  { id: 'classic', themeId: '3273938616164733', name: 'Classic', aliases: ['blue'], colors: ['#0099FF'] },
  { id: 'monochrome', themeId: '788274591712841', name: 'Monochrome', aliases: ['mono', 'bw', 'minimal'], colors: ['#F0F0F0'] },
  { id: 'ocean', themeId: '527564631955494', name: 'Ocean', aliases: ['sea', 'aqua'], colors: ['#00C7D3', '#3653E8'] },
  { id: 'lavender', themeId: '571193503540759', name: 'Lavender', aliases: ['lilac', 'pastelpurple'], colors: ['#A797FF'] },
  { id: 'berry', themeId: '724096885023603', name: 'Berry', aliases: ['berries'], colors: ['#005FFF', '#9200FF', '#FF2E19'] },
  { id: 'maple', themeId: '2533652183614000', name: 'Maple', aliases: ['autumn', 'fall'], colors: ['#550029', '#AA3232', '#D9A900'] },
  { id: 'sunset', themeId: '3650637715209675', name: 'Besties (Sunset)', aliases: ['besties', 'sunset-gradient', 'warm'], colors: ['#FB961E', '#FF7B01', '#FF6C02'] },
  { id: 'cyberpunk', themeId: '1060619084701625', name: 'Lo-Fi', aliases: ['lofi', 'lo-fi', 'neon', 'synthwave'], colors: ['#CA34FF', '#302CFF', '#BA009C'] },
  { id: 'love', themeId: '741311439775765', name: 'Love', aliases: ['heart', 'hearts', 'valentine'], colors: ['#FF0D9E', '#F9005A'] },
  { id: 'pride', themeId: '968524435055801', name: 'Pride', aliases: ['rainbow'], colors: ['#FF0018', '#FF8701', '#01C92D', '#3F77E6', '#8A39EF'] },
  { id: 'sky', themeId: '3190514984517598', name: 'Sky', aliases: ['clouds'], colors: ['#0080FF', '#9F1AFF'] },
  { id: 'tiedye', themeId: '230032715012014', name: 'Tie-dye', aliases: ['tie-dye'], colors: ['#0052CD', '#00A1E6'] },
  { id: 'cottagecore', themeId: '539927563794799', name: 'Cottagecore', aliases: ['meadow', 'nature'], colors: ['#00D52F', '#006528'] },
  { id: 'astrology', themeId: '3082966625307060', name: 'Astrology', aliases: ['zodiac', 'stars'], colors: ['#FF239A', '#FF8C21'] },
  { id: 'shadow', themeId: '271607034185782', name: 'Shadow', aliases: ['dark', 'midnight'], colors: ['#5E007E', '#331290', '#2825B5'] },
  { id: 'rose', themeId: '1257453361255152', name: 'Rose', aliases: ['red'], colors: ['#FF311E'] },
  { id: 'grape', themeId: '193497045377796', name: 'Grape', aliases: ['purple'], colors: ['#5E007E'] },
  { id: 'honey', themeId: '672058580051520', name: 'Honey', aliases: ['gold', 'yellow'], colors: ['#FAAF00'] },
  { id: 'kiwi', themeId: '3151463484918004', name: 'Kiwi', aliases: ['green', 'lime'], colors: ['#6EDF00'] },
  { id: 'apple', themeId: '403422283881973', name: 'Apple', aliases: ['crimson'], colors: ['#AA3232'] },
  { id: 'tulip', themeId: '2873642949430623', name: 'Tulip', aliases: ['pink'], colors: ['#FB45DE'] },
  { id: 'unicorn', themeId: '273728810607574', name: 'Unicorn', aliases: [], colors: ['#FB45DE', '#841DD5', '#3A1D8A'] },
  { id: 'sweets', themeId: '624266884847972', name: 'Sweets', aliases: ['candy'], colors: ['#FF8FB2', '#A797FF', '#00E5FF'] },
  { id: 'sushi', themeId: '909695489504566', name: 'Sushi', aliases: [], colors: ['#F25C54', '#F4845F', '#F7B267'] },
  { id: 'rocket', themeId: '582065306070020', name: 'Rocket', aliases: ['space'], colors: ['#FAAF00', '#FF2E2E', '#3A12FF'] },
  { id: 'coffee', themeId: '1299135724598332', name: 'Coffee', aliases: ['espresso'], colors: ['#632E00'] },
  { id: 'bubbletea', themeId: '195296273246380', name: 'Bubble tea', aliases: ['boba', 'bubble-tea'], colors: ['#886546', '#A27F57', '#C6A26E'] },
  { id: 'cats', themeId: '418793291211015', name: 'Cats', aliases: ['cat', 'kitty'], colors: ['#FF9900', '#DE7A00', '#BD5B00'] },
  { id: 'dogs', themeId: '1040328944732151', name: 'Dogs', aliases: ['dog', 'puppy'], colors: ['#402E15'] },
  { id: 'pixel', themeId: '2729200940784964', name: 'Pixel Dreamscape', aliases: ['pixel-dreamscape', '8bit', 'retro'], colors: ['#0D3F61'] },
  { id: 'goth', themeId: '846723720930746', name: 'Goth charms', aliases: ['goth-charms'], colors: ['#606060', '#2C2C2C', '#1A1A1A'] },
  { id: 'loops', themeId: '976389323536938', name: 'Loops', aliases: ['noir', 'charcoal'], colors: ['#060606', '#212121', '#424243'] },
  { id: 'foliage', themeId: '1633544640877832', name: 'Foliage', aliases: ['forest', 'emerald'], colors: ['#016741', '#006D59', '#006A71'] },
  { id: 'music', themeId: '339021464972092', name: 'Music', aliases: [], colors: ['#2FA9E4', '#648FEB', '#9B73F2'] },
  { id: 'care', themeId: '275041734441112', name: 'Care', aliases: [], colors: ['#4AC9E4', '#5890FF', '#8C91FF'] },
  { id: 'celebration', themeId: '627144732056021', name: 'Celebration', aliases: ['party'], colors: ['#F1614E', '#660F84'] },
  { id: 'sweetheart', themeId: '1121431622801436', name: 'Sweetheart', aliases: [], colors: ['#D71D93'] },
  { id: 'flirt', themeId: '611878928211423', name: 'Flirt', aliases: [], colors: ['#E11976'] },
  { id: 'lollipop', themeId: '292955489929680', name: 'Lollipop', aliases: [], colors: ['#00C5C5', '#01B4AF', '#02A49A'] },
  { id: 'avocado', themeId: '1508524016651271', name: 'Avocado', aliases: [], colors: ['#6B904E', '#568640', '#467729'] },
  { id: 'pizza', themeId: '704702021720552', name: 'Pizza', aliases: [], colors: ['#D21313'] }
]);

class ThemesService {
  constructor(options = {}) {
    this.transport = options.transport;
    this.session = options.session;
    this.logger = options.logger;
    this.conversationsService = options.conversationsService || null;
    this._liveThemesCache = null;
  }

  /**
   * Ensures valid fb_dtsg and lsd tokens are loaded for GraphQL requests.
   *
   * @returns {Promise<{dtsg: string|null, lsd: string|null}>}
   * @private
   */
  async _ensureDtsgAndLsd() {
    let dtsg = this.session && this.session._dtsg ? this.session._dtsg : null;
    let lsd = this.session && this.session._lsd ? this.session._lsd : null;

    if ((!dtsg || !lsd) && this.transport && typeof this.transport.get === 'function') {
      try {
        const pageRes = await this.transport.get(`${Endpoints.BASE_URL}/direct/inbox/`, {
          validateStatus: (s) => s < 400
        });
        const html = typeof pageRes?.data === 'string' ? pageRes.data : '';
        const dtsgMatches = Array.from(html.matchAll(/"(NAf[^"]+)"/g)).map((m) => m[1]);
        const lsdMatches = Array.from(html.matchAll(/"LSD",\[\],\{"token":"([^"]+)"/g)).map((m) => m[1]);
        if (dtsgMatches[0]) dtsg = dtsgMatches[0];
        if (lsdMatches[0]) lsd = lsdMatches[0];
        if (this.session) {
          if (dtsg) this.session._dtsg = dtsg;
          if (lsd) this.session._lsd = lsd;
        }
      } catch (err) {}
    }

    return { dtsg, lsd };
  }

  /**
   * Resolves a thread ID (which may be a 16-digit GraphQL threadFbid) to its 39-digit threadIgid (v2Id)
   * expected by useIGDUpdateChatThemeOffMsysMutation.
   *
   * @param {string} validThreadId
   * @returns {Promise<string>}
   * @private
   */
  async _resolveThreadIgid(validThreadId) {
    // Already a full direct_v2 IGID (~35-42 digits) or non-numeric mock ID
    if (!/^\d+$/.test(validThreadId) || validThreadId.length >= 28) {
      return validThreadId;
    }

    if (this.session && this.session._threadIgidMap && this.session._threadIgidMap.has(validThreadId)) {
      return this.session._threadIgidMap.get(validThreadId);
    }

    if (this.conversationsService && typeof this.conversationsService.getInbox === 'function') {
      try {
        await this.conversationsService.getInbox({ limit: 20 });
        if (this.session && this.session._threadIgidMap && this.session._threadIgidMap.has(validThreadId)) {
          return this.session._threadIgidMap.get(validThreadId);
        }
      } catch (err) {}
    }

    return validThreadId;
  }

  /**
   * Normalizes a raw selectable theme node from Instagram GraphQL.
   *
   * @param {Object} raw
   * @returns {Object}
   * @private
   */
  _normalizeLiveTheme(raw) {
    const themeId = String(raw.id || raw.theme_id || '');
    const presetMatch = VERIFIED_THEMES.find((p) => p.themeId === themeId);
    const slug = presetMatch ? presetMatch.id : (slugifyThemeName(raw.name) || themeId);
    const colors = Array.isArray(raw.gradient_colors)
      ? raw.gradient_colors.map(normalizeHexColor).filter(Boolean)
      : (presetMatch ? presetMatch.colors : []);

    return {
      id: slug,
      themeId,
      name: raw.name || (presetMatch && presetMatch.name) || `Theme ${themeId}`,
      subtitle: raw.subtitle || '',
      aliases: presetMatch ? presetMatch.aliases : [],
      colors,
      iconUrl: raw.icon_url || null,
      backgroundUrl: (raw.background_asset && raw.background_asset.url_1024) || null,
      isDeprecated: Boolean(raw.is_deprecated)
    };
  }

  /**
   * Returns list of available themes (merging verified presets with any cached live themes).
   *
   * @returns {Array<Object>}
   */
  getAvailableThemes() {
    if (!Array.isArray(this._liveThemesCache) || this._liveThemesCache.length === 0) {
      return VERIFIED_THEMES.map((t) => ({ ...t }));
    }

    const merged = new Map();
    for (const preset of VERIFIED_THEMES) {
      merged.set(preset.themeId, { ...preset });
    }
    for (const live of this._liveThemesCache) {
      if (!merged.has(live.themeId)) {
        merged.set(live.themeId, { ...live });
      } else {
        const existing = merged.get(live.themeId);
        merged.set(live.themeId, {
          ...existing,
          subtitle: live.subtitle || existing.subtitle || '',
          iconUrl: live.iconUrl || existing.iconUrl || null,
          backgroundUrl: live.backgroundUrl || existing.backgroundUrl || null
        });
      }
    }

    return Array.from(merged.values());
  }

  /**
   * Fetches the live selectable themes catalog and current thread theme from Instagram Web GraphQL
   * (IGDInboxInfoThemesDialogQuery).
   *
   * @param {string|null} [threadId=null] - Conversation threadFbid to inspect alongside the catalog
   * @param {Object} [options]
   * @param {boolean} [options.forceRefresh=false]
   * @returns {Promise<{themes: Array<Object>, currentTheme: Object|null}>}
   */
  async fetchSelectableThemes(threadId = null, options = {}) {
    let targetFbid = threadId ? String(threadId).trim() : null;

    if (!targetFbid && this.session && this.session._threadIgidMap && this.session._threadIgidMap.size > 0) {
      for (const [k] of this.session._threadIgidMap.entries()) {
        if (/^\d{10,25}$/.test(k)) {
          targetFbid = k;
          break;
        }
      }
    }

    if (!targetFbid && this.conversationsService && typeof this.conversationsService.getInbox === 'function') {
      try {
        const inbox = await this.conversationsService.getInbox({ limit: 1 });
        if (inbox && inbox.conversations && inbox.conversations[0]) {
          targetFbid = inbox.conversations[0].id;
        }
      } catch (err) {}
    }

    if (!targetFbid || !this.transport || typeof this.transport.post !== 'function') {
      return {
        themes: this.getAvailableThemes(),
        currentTheme: null
      };
    }

    const csrfToken = this.session && typeof this.session.getCsrfToken === 'function'
      ? this.session.getCsrfToken()
      : '';
    const { dtsg, lsd } = await this._ensureDtsgAndLsd();

    const payload = new URLSearchParams();
    if (dtsg) payload.append('fb_dtsg', dtsg);
    if (lsd) payload.append('lsd', lsd);
    payload.append('fb_api_caller_class', 'RelayModern');
    payload.append('fb_api_req_friendly_name', 'IGDInboxInfoThemesDialogQuery');
    payload.append('server_timestamps', 'true');
    payload.append('doc_id', Endpoints.GRAPHQL_DOCS.THEMES_CATALOG);
    payload.append('variables', JSON.stringify({ threadId: targetFbid }));

    const response = await this.transport.post(
      Endpoints.GRAPHQL,
      payload.toString(),
      {
        headers: {
          'x-csrftoken': csrfToken,
          'x-fb-friendly-name': 'IGDInboxInfoThemesDialogQuery',
          'x-ig-app-id': Endpoints.WEB_APP_ID,
          'x-asbd-id': Endpoints.ASBD_ID,
          'x-fb-lsd': lsd || '0l2qtDa0grAFC5qqeoHlvO',
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: Endpoints.BASE_URL,
          Referer: `${Endpoints.BASE_URL}/direct/inbox/`,
          'sec-fetch-dest': 'empty',
          'sec-fetch-mode': 'cors',
          'sec-fetch-site': 'same-origin'
        }
      },
      true
    );

    const data = response && response.data && response.data.data;
    if (!data) {
      return {
        themes: this.getAvailableThemes(),
        currentTheme: null
      };
    }

    const rawList = Array.isArray(data.direct_selectable_themes) ? data.direct_selectable_themes : [];
    const liveThemes = rawList
      .filter((t) => t && !t.is_deprecated)
      .map((t) => this._normalizeLiveTheme(t));

    if (liveThemes.length > 0) {
      this._liveThemesCache = liveThemes;
    }

    const rawCurrent = data.ig_direct_viewer_thread_from_fbid && data.ig_direct_viewer_thread_from_fbid.theme_data;
    let currentTheme = null;
    if (rawCurrent && rawCurrent.theme_id) {
      const currentId = String(rawCurrent.theme_id);
      const catalogEntry = (liveThemes.length > 0 ? liveThemes : VERIFIED_THEMES)
        .find((t) => String(t.themeId) === currentId);
      currentTheme = {
        themeId: currentId,
        id: catalogEntry ? catalogEntry.id : currentId,
        name: catalogEntry ? catalogEntry.name : `Theme #${currentId}`,
        fallbackColor: normalizeHexColor(rawCurrent.fallback_color),
        colors: Array.isArray(rawCurrent.gradient_colors)
          ? rawCurrent.gradient_colors.map(normalizeHexColor).filter(Boolean)
          : (catalogEntry ? catalogEntry.colors : []),
        backgroundUrl: (rawCurrent.thread_background_asset && rawCurrent.thread_background_asset.url_1024) || null
      };
    }

    return {
      themes: liveThemes.length > 0 ? liveThemes : this.getAvailableThemes(),
      currentTheme
    };
  }

  /**
   * Retrieves the active theme currently applied to a specific thread.
   *
   * @param {string} threadId
   * @returns {Promise<Object|null>}
   */
  async getThreadTheme(threadId) {
    const validThreadId = validateThreadId(threadId);
    const { currentTheme } = await this.fetchSelectableThemes(validThreadId);
    return currentTheme;
  }

  /**
   * Searches themes matching a keyword by name, subtitle, slug, or alias.
   *
   * @param {string} query
   * @param {Object} [options]
   * @param {string} [options.threadId]
   * @returns {Promise<Array<Object>>}
   */
  async searchThemes(query, options = {}) {
    if (typeof query !== 'string' || !query.trim()) {
      throw new ValidationError('Theme search query must be a non-empty string', { field: 'query' });
    }

    if (!this._liveThemesCache && options.threadId) {
      try {
        await this.fetchSelectableThemes(options.threadId);
      } catch (err) {}
    }

    const needle = query.trim().toLowerCase();
    const needleCompact = compactKey(needle);
    const catalog = this.getAvailableThemes();

    return catalog.filter((t) => {
      if (t.id.toLowerCase().includes(needle) || compactKey(t.id).includes(needleCompact)) return true;
      if (t.name.toLowerCase().includes(needle) || compactKey(t.name).includes(needleCompact)) return true;
      if (t.subtitle && t.subtitle.toLowerCase().includes(needle)) return true;
      if (String(t.themeId) === needle) return true;
      if (Array.isArray(t.aliases) && t.aliases.some((a) => a.toLowerCase().includes(needle) || compactKey(a).includes(needleCompact))) {
        return true;
      }
      return false;
    });
  }

  /**
   * Resolves a user-provided theme name, slug, alias, `#index`, `'random'`, or numeric FBID
   * into a normalized theme descriptor.
   *
   * @param {string|number} themeInput
   * @param {Array<Object>} [catalog]
   * @returns {Object|null}
   */
  resolveTheme(themeInput, catalog = null) {
    if (themeInput === undefined || themeInput === null || String(themeInput).trim() === '') {
      return null;
    }

    const list = Array.isArray(catalog) && catalog.length > 0 ? catalog : this.getAvailableThemes();
    const raw = String(themeInput).trim();
    const lower = raw.toLowerCase();
    const compact = compactKey(raw);

    // 1. Random theme selector
    if (lower === 'random' || lower === 'surprise') {
      const candidates = list.filter((t) => t.id !== 'default');
      const pool = candidates.length > 0 ? candidates : list;
      return pool[Math.floor(Math.random() * pool.length)];
    }

    // 2. Explicit #index selector (e.g. "#1", "#5")
    const indexMatch = raw.match(/^#(\d+)$/);
    if (indexMatch) {
      const idx = parseInt(indexMatch[1], 10) - 1;
      if (idx >= 0 && idx < list.length) {
        return list[idx];
      }
      return null;
    }

    // 3. Direct numeric Instagram theme FBID (e.g. "527564631955494")
    if (/^\d{6,25}$/.test(raw)) {
      const existing = list.find((t) => String(t.themeId) === raw);
      if (existing) return existing;
      return {
        id: raw,
        themeId: raw,
        name: `Theme #${raw}`,
        aliases: [],
        colors: []
      };
    }

    // 4. Exact match on id, name, or aliases
    const exact = list.find((t) => {
      if (t.id.toLowerCase() === lower || compactKey(t.id) === compact) return true;
      if (t.name.toLowerCase() === lower || compactKey(t.name) === compact) return true;
      if (Array.isArray(t.aliases) && t.aliases.some((a) => a.toLowerCase() === lower || compactKey(a) === compact)) {
        return true;
      }
      return false;
    });
    if (exact) return exact;

    // 5. Partial / substring match on name or slug
    if (compact.length >= 3) {
      const partial = list.find((t) =>
        compactKey(t.name).includes(compact) ||
        compactKey(t.id).includes(compact) ||
        (Array.isArray(t.aliases) && t.aliases.some((a) => compactKey(a).includes(compact)))
      );
      if (partial) return partial;
    }

    return null;
  }

  /**
   * Sets the visual theme of a conversation thread using modern Instagram Web GraphQL
   * (useIGDUpdateChatThemeOffMsysMutation), with fallback to legacy direct_v2 REST.
   *
   * @param {string} threadId - Conversation thread ID (FBID or v2 IGID)
   * @param {string|number} themeId - Theme name, preset slug, alias, 'random', or numeric theme FBID
   * @param {Object} [options]
   * @param {boolean} [options.forceRest=false] - Force legacy REST endpoint
   * @returns {Promise<{success: boolean, threadId: string, themeId: string, themeKey: string, themeName: string, colors: string[], themeData: Object|null}>}
   */
  async setTheme(threadId, themeId, options = {}) {
    const validThreadId = validateThreadId(threadId);

    if (themeId === undefined || themeId === null || String(themeId).trim() === '') {
      throw new ValidationError('themeId must be a valid theme identifier string or number');
    }

    const cleanInput = String(themeId).trim();
    let resolved = this.resolveTheme(cleanInput);

    // If not matched locally and GraphQL is enabled, refresh live catalog once for new seasonal themes
    if (!resolved && !options.forceRest && !this._liveThemesCache) {
      try {
        await this.fetchSelectableThemes(validThreadId);
        resolved = this.resolveTheme(cleanInput);
      } catch (err) {}
    }

    const numericOrRawId = resolved ? String(resolved.themeId) : cleanInput;
    const themeKey = resolved ? resolved.id : cleanInput;
    const themeName = resolved ? resolved.name : cleanInput;
    const colors = resolved && Array.isArray(resolved.colors) ? resolved.colors : [];
    const csrfToken = this.session && typeof this.session.getCsrfToken === 'function'
      ? this.session.getCsrfToken()
      : '';

    // 1. Primary: Modern Instagram Web GraphQL Mutation (useIGDUpdateChatThemeOffMsysMutation)
    if (!options.forceRest) {
      try {
        const { dtsg, lsd } = await this._ensureDtsgAndLsd();
        const igThreadIgid = await this._resolveThreadIgid(validThreadId);

        const gqlPayload = new URLSearchParams();
        if (dtsg) gqlPayload.append('fb_dtsg', dtsg);
        if (lsd) gqlPayload.append('lsd', lsd);
        gqlPayload.append('fb_api_caller_class', 'RelayModern');
        gqlPayload.append('fb_api_req_friendly_name', 'useIGDUpdateChatThemeOffMsysMutation');
        gqlPayload.append('server_timestamps', 'true');
        gqlPayload.append('doc_id', Endpoints.GRAPHQL_DOCS.SET_THEME);
        gqlPayload.append('variables', JSON.stringify({
          ig_thread_igid: igThreadIgid,
          theme_id: numericOrRawId
        }));

        const gqlRes = await this.transport.post(
          Endpoints.GRAPHQL,
          gqlPayload.toString(),
          {
            headers: {
              'x-csrftoken': csrfToken,
              'x-fb-friendly-name': 'useIGDUpdateChatThemeOffMsysMutation',
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

        const respData = gqlRes && gqlRes.data;
        const updated = respData && respData.data && respData.data.direct_update_chat_theme;
        if (updated) {
          return {
            success: true,
            threadId: validThreadId,
            themeId: (updated.theme_data && String(updated.theme_data.theme_id)) || numericOrRawId,
            themeKey,
            themeName,
            colors,
            themeData: updated.theme_data || null
          };
        }

        if (respData && Array.isArray(respData.errors) && respData.errors.length > 0) {
          throw new InstaChatError(respData.errors[0].message || 'GraphQL theme update error', {
            details: respData.errors
          });
        }
      } catch (gqlErr) {
        if (gqlErr instanceof InstaChatError) {
          throw gqlErr;
        }
        if (this.logger && typeof this.logger.debug === 'function') {
          this.logger.debug(`GraphQL setTheme bypassed (${gqlErr.message}), trying REST set_theme.`);
        }
      }
    }

    // 2. Fallback: Legacy mobile REST endpoint (/api/v1/direct_v2/threads/{id}/set_theme/)
    const payload = new URLSearchParams();
    payload.append('theme_id', options.forceRest ? numericOrRawId : cleanInput);
    payload.append('_csrftoken', csrfToken);

    const response = await this.transport.post(
      Endpoints.SET_THEME(validThreadId),
      payload.toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      },
      false
    );

    const data = response.data || {};
    if (data.status !== 'ok') {
      throw new InstaChatError(data.message || 'Failed to set chat theme', {
        details: data
      });
    }

    return {
      success: true,
      threadId: validThreadId,
      themeId: cleanInput,
      themeKey,
      themeName,
      colors,
      themeData: null
    };
  }

  /**
   * Resets a thread's theme back to Instagram's Default theme.
   *
   * @param {string} threadId
   * @param {Object} [options]
   * @returns {Promise<Object>}
   */
  async resetTheme(threadId, options = {}) {
    return this.setTheme(threadId, 'default', options);
  }
}

module.exports = ThemesService;
