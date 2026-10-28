'use strict';

/**
 * Direct Messaging Network Traffic Inspector
 *
 * Launches a browser and attaches request/response listeners to intercept and log
 * internal `direct_v2` and `rupload` network traffic for protocol reverse engineering.
 *
 * NOTE: Research utility only. Never imported in production.
 */

const path = require('path');
const fs = require('fs');

async function inspectNetwork() {
  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch (err) {
    console.error('[NetworkInspector] Puppeteer is not installed in research/.');
    console.error('[NetworkInspector] Run: cd research && npm install');
    process.exit(1);
  }

  const sessionPath = path.resolve(__dirname, '../data/session.json');
  let savedCookies = [];

  if (fs.existsSync(sessionPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
      if (raw.cookies) {
        savedCookies = Object.entries(raw.cookies).map(([name, value]) => ({
          name,
          value,
          domain: '.instagram.com',
          path: '/'
        }));
      }
    } catch (e) {
      console.warn('[NetworkInspector] Could not load saved session. Starting with fresh cookies.');
    }
  }

  console.log('[NetworkInspector] Launching browser to monitor direct messaging traffic...');
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: { width: 1280, height: 800 },
    args: ['--no-sandbox']
  });

  const page = await browser.newPage();
  if (savedCookies.length > 0) {
    await page.setCookie(...savedCookies);
  }

  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('/api/v1/direct_v2/') || url.includes('/rupload_ig')) {
      console.log(`\n>>> [REQUEST] ${req.method()} ${url}`);
      console.log('Headers:', JSON.stringify(maskHeaders(req.headers()), null, 2));
      const postData = req.postData();
      if (postData) {
        console.log('Payload:', postData.length > 300 ? postData.slice(0, 300) + '...[TRUNCATED]' : postData);
      }
    }
  });

  page.on('response', async (res) => {
    const url = res.url();
    if (url.includes('/api/v1/direct_v2/') || url.includes('/rupload_ig')) {
      console.log(`\n<<< [RESPONSE] ${res.status()} ${url}`);
      try {
        const text = await res.text();
        console.log('Body Preview:', text.length > 500 ? text.slice(0, 500) + '...[TRUNCATED]' : text);
      } catch (e) {
        console.log('[Response body could not be read]');
      }
    }
  });

  await page.goto('https://www.instagram.com/direct/inbox/', {
    waitUntil: 'networkidle2'
  });

  console.log('[NetworkInspector] Ready! Interact with direct messages in the browser to view network calls.');
}

function maskHeaders(headers) {
  const masked = { ...headers };
  if (masked.cookie) masked.cookie = '[MASKED_COOKIE_DATA]';
  if (masked['x-csrftoken']) masked['x-csrftoken'] = '[MASKED_CSRF_TOKEN]';
  if (masked.authorization) masked.authorization = '[MASKED_AUTH]';
  return masked;
}

if (require.main === module) {
  inspectNetwork().catch(console.error);
}

module.exports = { inspectNetwork };
