'use strict';

/**
 * Interactive Session Extractor for Instagram Web
 *
 * Launches an interactive Puppeteer session allowing the user to manually log in,
 * solve 2FA/MFA challenges, and export the resulting authorized cookies into session.json.
 *
 * NOTE: This tool is strictly for development/setup and is NEVER imported by production src/.
 */

const path = require('path');
const fs = require('fs');

async function extractSession() {
  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch (err) {
    console.error('[SessionExtractor] Puppeteer is not installed.');
    console.error('[SessionExtractor] Run: cd research && npm install');
    process.exit(1);
  }

  const outputDir = path.resolve(__dirname, '../data');
  const outputPath = path.join(outputDir, 'session.json');

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  console.log('====================================================');
  console.log('   InstaChat API — Interactive Session Extractor    ');
  console.log('====================================================');
  console.log('[1] Launching Chromium browser window...');
  console.log('[2] Please log in manually in the browser.');
  console.log('[3] Complete any Two-Factor Authentication or Checkpoints.');
  console.log('[4] Once you reach the direct inbox or feed, the session will be captured.');
  console.log('----------------------------------------------------');

  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: { width: 1280, height: 800 },
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
  );

  await page.goto('https://www.instagram.com/accounts/login/', {
    waitUntil: 'networkidle2'
  });

  console.log('[*] Waiting for user authentication (sessionid & ds_user_id cookies)...');

  // Polling for authentication cookies
  const startTime = Date.now();
  const maxWaitMs = 5 * 60 * 1000; // 5 minutes timeout

  const checkInterval = setInterval(async () => {
    try {
      const cookies = await page.cookies();
      const cookieMap = {};
      cookies.forEach((c) => {
        cookieMap[c.name] = c.value;
      });

      if (cookieMap.sessionid && cookieMap.ds_user_id) {
        clearInterval(checkInterval);

        const sessionData = {
          userId: cookieMap.ds_user_id,
          username: null,
          cookies: {
            sessionid: cookieMap.sessionid,
            csrftoken: cookieMap.csrftoken || '',
            ds_user_id: cookieMap.ds_user_id,
            mid: cookieMap.mid || '',
            ig_did: cookieMap.ig_did || '',
            rur: cookieMap.rur || ''
          },
          cookieString: Object.entries(cookieMap)
            .map(([k, v]) => `${k}=${v}`)
            .join('; '),
          createdAt: new Date().toISOString(),
          expiresAt: null
        };

        fs.writeFileSync(outputPath, JSON.stringify(sessionData, null, 2), 'utf-8');

        console.log('\n[SUCCESS] Session cookies extracted successfully!');
        console.log(`[INFO] Authenticated User ID: ${sessionData.userId}`);
        console.log(`[INFO] Session saved securely to: ${outputPath}`);
        console.log('[INFO] Sensitive tokens have been redacted in this console view.');
        console.log('====================================================\n');

        await browser.close();
        process.exit(0);
      }

      if (Date.now() - startTime > maxWaitMs) {
        clearInterval(checkInterval);
        console.error('\n[TIMEOUT] Session extraction timed out. Please try again.');
        await browser.close();
        process.exit(1);
      }
    } catch (e) {
      // Continue polling
    }
  }, 1000);
}

if (require.main === module) {
  extractSession().catch((err) => {
    console.error('[SessionExtractor Error]', err.message);
    process.exit(1);
  });
}

module.exports = { extractSession };
