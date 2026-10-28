'use strict';

const axios = require('axios');
const Session = require('../src/auth/session');

(async () => {
  const s = new Session();
  s.load('./cookie.json');

  const pageRes = await axios.get('https://www.instagram.com/direct/inbox/', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Cookie': s.getCookieString()
    }
  });

  const html = pageRes.data;
  const scriptUrls = Array.from(html.matchAll(/src="([^"]+\.js[^"]*)"/g)).map(m => m[1]);

  for (const url of scriptUrls) {
    try {
      const res = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://www.instagram.com/'
        },
        timeout: 10000
      });
      const js = res.data;
      if (js.includes('4415001') || js.includes('Prompt has contribution') || js.includes('has contribution')) {
        console.log('FOUND MATCH IN:', url);
        const idx = js.indexOf('has contribution');
        console.log(js.slice(Math.max(0, idx - 200), idx + 200));
      }
    } catch (e) {}
  }
})();
