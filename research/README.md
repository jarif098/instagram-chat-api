# InstaChat API — Protocol Research & Session Extraction Tools

This directory contains standalone, optional development tools for protocol discovery, traffic inspection, and interactive session extraction using Puppeteer.

> [!IMPORTANT]
> **Production Isolation Notice:**  
> These tools and their dependencies (e.g. Puppeteer) are strictly isolated inside `research/`. They are **never** included, imported, or executed by the production library (`src/`). The production runtime runs completely independent of Puppeteer or any browser automation framework.

---

## Tool 1: Interactive Session Extractor (`session-extractor.js`)

Because Instagram Web employs robust anti-bot protections (reCAPTCHA, device telemetry, browser fingerprinting) on its login endpoint, automated programmatic username/password submission frequently leads to account checkpoints or bans.

The safest, officially sanctioned workflow for obtaining an authorized session is **interactive manual login**:

1. Run the extractor:
   ```bash
   cd research
   npm install
   npm run extract-session
   ```
2. A browser window opens to `https://www.instagram.com/accounts/login/`.
3. Enter your credentials, complete two-factor authentication (SMS/Authenticator), and solve any verification challenges in the browser.
4. Once you reach the Instagram inbox or feed, the extractor automatically detects the authenticated cookies:
   - `sessionid`
   - `csrftoken`
   - `ds_user_id`
   - `mid`
   - `ig_did`
   - `rur`
5. The extractor writes these tokens securely to `../data/session.json` and closes the browser.
6. The production library can then use `data/session.json` without any browser running.

---

## Tool 2: Network Inspector (`network-inspector.js`)

Used during reverse engineering to monitor live Direct v2 XHR/Fetch network traffic between the official web frontend and Instagram's servers:

```bash
cd research
npm run inspect-network
```

Filters and logs headers, endpoints, query parameters, and payload structures for `direct_v2` requests, masking sensitive tokens.
