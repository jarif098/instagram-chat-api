'use strict';

/**
 * Example: Initializing and Connecting InstaChatClient
 *
 * Demonstrates loading an authorized session from a file or directly from cookies.
 */

const { InstaChatClient } = require('../src');

async function main() {
  // Automatically loads cookie.json, cookies.json, or ./data/session.json
  const client = new InstaChatClient({
    debug: true
  });

  /*
  // Option 2: Pass cookies directly in code (e.g. from environment variables)
  const client = new InstaChatClient({
    cookies: {
      sessionid: process.env.IG_SESSION_ID,
      csrftoken: process.env.IG_CSRF_TOKEN,
      ds_user_id: process.env.IG_USER_ID
    }
  });
  */

  client.on('connected', () => {
    console.log('[App] Connected to Instagram network.');
  });

  client.on('ready', () => {
    console.log('[App] Client is ready for direct messaging operations.');
  });

  client.on('auth_error', (err) => {
    console.error('[App] Authentication error:', err.message);
    if (err.checkpointRequired) {
      console.warn('[App] Checkpoint required. Please solve verification in a web browser.');
    }
  });

  try {
    await client.connect();
    console.log(`[App] Successfully authenticated! Logged-in User ID: ${client.session.userId}`);

    // Disconnect cleanly
    await client.disconnect();
  } catch (err) {
    console.error('[App] Connection failed:', err.message);
  }
}

if (require.main === module) {
  main();
}
