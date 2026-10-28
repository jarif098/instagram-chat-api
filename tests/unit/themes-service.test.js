'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ThemesService = require('../../src/services/themes');
const InstaChatClient = require('../../src/client');

test('ThemesService: resolves themes by slug, name, alias, #index, random, and numeric FBID', () => {
  const service = new ThemesService({ transport: {}, session: {} });
  const catalog = service.getAvailableThemes();

  assert.ok(catalog.length >= 10);

  const ocean = service.resolveTheme('ocean');
  assert.ok(ocean);
  assert.equal(ocean.id, 'ocean');

  const byIndex = service.resolveTheme('#1');
  assert.ok(byIndex);
  assert.equal(byIndex.id, catalog[0].id);

  const random = service.resolveTheme('random');
  assert.ok(random);

  const numericFbid = service.resolveTheme('527564631955494');
  assert.ok(numericFbid);
  assert.equal(numericFbid.id, 'ocean');
});

test('ThemesService: fetchSelectableThemes parses GraphQL catalog and active thread theme', async () => {
  const mockTransport = {
    post: async (url, body) => ({
      data: {
        data: {
          direct_selectable_themes: [
            {
              theme_id: '527564631955494',
              theme_name: 'Ocean',
              theme_type: 'NORMAL',
              is_deprecated: false,
              gradient_colors: ['#00C7D3', '#3653E8']
            }
          ],
          ig_direct_viewer_thread_from_fbid: {
            theme_data: {
              theme_id: '527564631955494',
              gradient_colors: ['#00C7D3', '#3653E8']
            }
          }
        }
      }
    })
  };

  const service = new ThemesService({
    transport: mockTransport,
    session: { _dtsg: 'dtsg', _lsd: 'lsd', getCsrfToken: () => 'c' }
  });

  const res = await service.fetchSelectableThemes('th_1');
  assert.equal(res.themes.length, 1);
  assert.equal(res.themes[0].id, 'ocean');
  assert.ok(res.currentTheme);
  assert.equal(res.currentTheme.themeId, '527564631955494');
});

test('ThemesService: setTheme executes GraphQL mutation and returns theme descriptor', async () => {
  const mockTransport = {
    post: async (url, body) => ({
      data: {
        data: {
          direct_update_chat_theme: {
            theme_data: {
              theme_id: '527564631955494'
            }
          }
        }
      }
    })
  };

  const service = new ThemesService({
    transport: mockTransport,
    session: { _dtsg: 'dtsg', _lsd: 'lsd', getCsrfToken: () => 'c' }
  });

  const updated = await service.setTheme('th_1', 'ocean');
  assert.equal(updated.success, true);
  assert.equal(updated.themeId, '527564631955494');
  assert.equal(updated.themeName, 'Ocean');
});

test('InstaChatClient: exposes full chat theme changer API', () => {
  const client = new InstaChatClient({ cookies: { sessionid: 's', csrftoken: 'c', ds_user_id: '123' } });
  assert.equal(typeof client.setChatTheme, 'function');
  assert.equal(typeof client.resetChatTheme, 'function');
  assert.equal(typeof client.getAvailableThemes, 'function');
  assert.equal(typeof client.fetchChatThemes, 'function');
  assert.equal(typeof client.searchChatThemes, 'function');
});
