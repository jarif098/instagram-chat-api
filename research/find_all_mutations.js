'use strict';

const axios = require('axios');

(async () => {
  const page = await axios.get('https://www.instagram.com/direct/inbox/', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  });
  const html = page.data;
  const scriptUrls = Array.from(html.matchAll(/src="(https:[^"]+rsrc\.php[^"]+\.js[^"]*)"/g)).map(m => m[1]);
  console.log('Found script URLs:', scriptUrls.length);

  for (const url of scriptUrls) {
    try {
      const res = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://www.instagram.com/'
        }
      });
      const js = res.data;
      const allMutations = js.match(/[a-zA-Z0-9_]+Mutation/g);
      if (allMutations) {
        const directOrMsg = allMutations.filter(m =>
          m.toLowerCase().includes('direct') ||
          m.toLowerCase().includes('message') ||
          m.toLowerCase().includes('unsend') ||
          m.toLowerCase().includes('delete')
        );
        if (directOrMsg.length > 0) {
          console.log('Mutations in', url.slice(-25), ':', [...new Set(directOrMsg)]);
        }
      }
    } catch (e) {
      console.log('Error fetching script:', e.message);
    }
  }
})();
