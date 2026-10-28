# Known Limitations & Platform Constraints

`instachat-api` is an unofficial, reverse-engineered client library interacting with Meta's private `direct_v2` web endpoints. When deploying or developing with this library, developers must understand the technical and platform constraints outlined below.

---

## 1. Terms of Service & Security Considerations

### 1.1 Meta Terms of Service Warning
Interacting with Instagram through undocumented private interfaces violates Meta's Terms of Service. Unofficial automated access can lead to:
- Temporary feature restrictions ("Action Blocked").
- Account security checkpoints (`checkpoint_required`).
- Permanent account suspension or termination.

**Best Practices:**
- Never run automation against critical personal or primary business accounts.
- Always use a dedicated test or secondary account.
- Maintain human-like request pacing (minimum 2–5 seconds between messages).
- Avoid bulk cold-messaging or spam patterns.

---

## 2. Rate Limits & Action Blocks

### 2.1 Observed Rate Limits
Instagram applies algorithmic rate limiting based on account age, trust score, IP reputation, and action velocity:
- **Text Messages:** Approximately 20–30 messages per minute maximum, with a safe sustained rate of 5–10 messages per minute.
- **Media Uploads:** Approximately 5–10 uploads per 10 minutes.
- **Inbox Polling:** Default safe poll interval is 3,000ms–5,000ms. Aggressive polling below 1,500ms triggers HTTP 429 Too Many Requests.

### 2.2 Response Signatures & Backoff
- **HTTP 429 Too Many Requests:** The client must back off exponentially. The library reads the `Retry-After` header when available.
- **HTTP 400 with `"feedback_required"` or `"checkpoint_required"`:** The account has been placed under a security challenge. The library immediately emits an `auth_error` or `rate_limit` event and halts polling to prevent further penalties.

---

## 3. End-to-End Encrypted (E2EE) Threads

Meta has introduced End-to-End Encryption (E2EE) for direct chats across Instagram and Messenger using the Signal Protocol.
- **E2EE Thread Identification:** In the thread metadata, these chats are identified with flags such as `is_pin_protected` or specific E2EE thread IDs.
- **Library Behavior:** Standard REST endpoints return ciphertext or empty item lists for E2EE chats. The library will detect such threads, log a warning, and throw an `UnsupportedFeatureError` if a message send is attempted against an E2EE thread without proper key exchange.
- Standard cloud-backed threads continue to work seamlessly.

---

## 4. Media Upload Constraints

When uploading media through the `rupload` pipeline:
- **Images:** Supported formats are JPEG and PNG. Maximum recommended dimensions are 1920x1080; maximum recommended size is 8MB.
- **Videos:** Supported format is MP4 (H.264 video codec, AAC audio codec). Maximum size: 25MB. Videos with unsupported codecs will fail server-side processing during the `broadcast/configure_video/` stage.
- **Audio / Voice Notes:** Supported format is AAC/M4A/MP3. Raw WAV files may be rejected by Meta's audio processing pipeline.

---

## 5. Session Expiration & Invalidation

Instagram Web sessions expire under several conditions:
- **Password Change:** Changing the account password immediately invalidates all active sessions.
- **Explicit Logout:** Logging out from the web browser terminates the session on Meta's server.
- **Session Timeout:** Sessions typically remain valid for several weeks or months unless invalidated by a checkpoint or IP anomaly.
- **Rotated Cookies:** If Meta rotates `csrftoken` or `rur` during normal traffic, the transport layer captures and updates the active session automatically.

---

## 6. Distinguishing Unsupported Features from Bugs

| Symptom | Cause | Classification |
|---|---|---|
| HTTP 400 `checkpoint_required` | Account triggered an identity verification challenge | Platform Restriction (Not a bug) |
| HTTP 400 `feedback_required` | Temporary action block triggered by high activity velocity | Rate Limit Restriction (Not a bug) |
| Empty messages in E2EE thread | End-to-End Encryption enabled on the specific chat | Unsupported Feature (By design) |
| HTTP 403 Forbidden on media upload | Corrupt metadata or unsupported media codec | Validation / Transcoding Issue |
| Network timeout during polling | Transient network drop | Network Error (Handled by retry logic) |
