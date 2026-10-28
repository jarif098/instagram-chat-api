'use strict';

const InstaChatClient = require('../src/client');
const axios = require('axios');
const crypto = require('crypto');

(async () => {
  const client = new InstaChatClient({ sessionPath: './cookie.json' });
  await client.connect();

  const threadId = '1118689617483421';

  // Send a fresh message
  console.log('Sending message to test unsend...');
  const msg = await client.sendMessage(threadId, 'Hello delete test ' + Date.now());
  console.log('Sent message ID:', msg.id);

  const csrfToken = client.session.getCsrfToken();
  const cookieHeader = client.session.getCookieString();
  const uuid = crypto.randomUUID();

  const payload = new URLSearchParams();
  payload.append('_csrftoken', csrfToken);
  payload.append('_uuid', uuid);

  const configs = [
    {
      name: 'Mobile headers with Instagram user agent',
      url: `https://i.instagram.com/api/v1/direct_v2/threads/${threadId}/items/${msg.id}/delete/`,
      headers: {
        'Cookie': cookieHeader,
        'X-CSRFToken': csrfToken,
        'User-Agent': 'Instagram 314.0.0.19.109 Android (33/13; 420dpi; 1080x2400; Google/google; Pixel 7; cheetah; cheetah; en_US; 555627670)',
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    },
    {
      name: 'Web headers on i.instagram.com',
      url: `https://i.instagram.com/api/v1/direct_v2/threads/${threadId}/items/${msg.id}/delete/`,
      headers: {
        'Cookie': cookieHeader,
        'X-CSRFToken': csrfToken,
        'x-csrftoken': csrfToken,
        'x-ig-app-id': '936619743392459',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    }
  ];

  for (const c of configs) {
    console.log(`\nTesting: ${c.name}`);
    const res = await axios.post(c.url, payload.toString(), {
      headers: c.headers,
      validateStatus: () => true
    });
    console.log(`Status: ${res.status}`, res.data);
    if (res.data && res.data.status === 'ok') {
      console.log('>>> SUCCESSFUL DELETE via:', c.name);
      break;
    }
  }

  await client.disconnect();
})();
