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
  console.log(`Found ${scriptUrls.length} script tags.`);

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
      if (typeof js === 'string') {
        const matches = js.match(/(?:xig_direct_[a-zA-Z0-9_]+|IGDirect[a-zA-Z0-9_]+Mutation|Polaris[a-zA-Z0-9_]+Mutation)/g);
        if (matches) {
          console.log(`Mutations in ${url.slice(-25)}:`, [...new Set(matches)]);
        }
      }
    } catch (e) {}
  }
})();
