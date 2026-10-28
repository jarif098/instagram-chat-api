'use strict';

const http = require('http');
const https = require('https');
const axios = require('axios');
const Endpoints = require('../constants/endpoints');

const defaultHttpAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 60000, maxSockets: 50 });
const defaultHttpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 60000, maxSockets: 50 });
const {
  AuthenticationError,
  RateLimitError,
  NetworkError,
  NotFoundError,
  InstaChatError
} = require('../utils/errors');
const { withRetry } = require('../utils/retry');

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

class HttpTransport {
  constructor(options = {}) {
    this.session = options.session;
    this.logger = options.logger;
    this.timeout = options.requestTimeoutMs || 15000;
    this.maxRetries = options.maxRetries !== undefined ? options.maxRetries : 2;
    this.userAgent = options.userAgent || DEFAULT_USER_AGENT;

    // Axios client instance with connection pooling & HTTP keep-alive
    this.client = axios.create({
      baseURL: Endpoints.BASE_URL,
      timeout: this.timeout,
      httpAgent: defaultHttpAgent,
      httpsAgent: defaultHttpsAgent,
      headers: {
        'User-Agent': this.userAgent,
        'x-ig-app-id': Endpoints.WEB_APP_ID,
        'x-asbd-id': Endpoints.ASBD_ID,
        'x-requested-with': 'XMLHttpRequest',
        Accept: '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        Origin: Endpoints.BASE_URL,
        Referer: `${Endpoints.BASE_URL}/direct/inbox/`
      },
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 300
    });

    this._setupInterceptors();
  }

  _setupInterceptors() {
    // Request Interceptor: Attach dynamic cookies and CSRF tokens
    this.client.interceptors.request.use((config) => {
      if (this.session) {
        config.headers.Cookie = this.session.getCookieString();
        const csrf = this.session.getCsrfToken();
        if (csrf) {
          config.headers['x-csrftoken'] = csrf;
        }
      }

      if (this.logger && typeof this.logger.debug === 'function') {
        this.logger.debug(`HTTP Request: ${config.method.toUpperCase()} ${config.url}`);
      }

      return config;
    });

    // Response Interceptor: Capture Set-Cookie rotations
    this.client.interceptors.response.use(
      (response) => {
        const setCookie = response.headers['set-cookie'];
        if (setCookie && this.session) {
          this.session.updateFromSetCookie(setCookie);
        }
        return response;
      },
      (error) => {
        // Normalize and wrap error
        const normalized = this._normalizeError(error);
        return Promise.reject(normalized);
      }
    );
  }

  _normalizeError(error) {
    if (!error.response) {
      if (error.code === 'ECONNABORTED' || (error.message && error.message.includes('timeout'))) {
        return new NetworkError(`Request timed out after ${this.timeout}ms`, {
          isTimeout: true,
          code: 'TIMEOUT'
        });
      }
      return new NetworkError(error.message || 'Network connectivity error', {
        code: error.code || 'NETWORK_ERROR'
      });
    }

    const { status, data, headers, config } = error.response;
    const responseData = typeof data === 'object' && data !== null ? data : {};
    const isHtml = typeof data === 'string' && (data.includes('<html') || data.includes('<!DOCTYPE'));
    const isLoggedOutHtml = isHtml && (data.includes('not-logged-in') || data.includes('/accounts/login/') || data.includes('loginLink'));
    const location = headers && (headers.location || headers.Location);
    const isLoginRedirect = location && location.includes('/accounts/login/');

    // Logged-out / Unauthenticated web detection
    // Instagram returns a 404 HTML page ("Page Not Found" / not-logged-in) on direct_v2 endpoints when cookies are invalid or missing sessionid.
    const isDirectApi = config && config.url && config.url.includes('/api/v1/direct_v2/');
    if (isLoginRedirect || isLoggedOutHtml || (status === 404 && isDirectApi && isHtml)) {
      return new AuthenticationError(
        'Instagram session is invalid, expired, or logged out. Please ensure your cookie.json includes a valid, active "sessionid" and "ds_user_id" from a logged-in browser session.',
        {
          code: 'SESSION_EXPIRED',
          status: status || 401,
          details: { isHtml, redirectedToLogin: Boolean(isLoginRedirect) }
        }
      );
    }

    let message = responseData.message;
    if (!message) {
      if (isHtml) {
        message = `Instagram returned an unexpected HTML error page (HTTP ${status}).`;
      } else if (typeof data === 'string' && data.length > 0) {
        message = data.slice(0, 300);
      } else {
        message = error.message;
      }
    }

    // Account Prompt / Contribution Dialog (error_code 4415001)
    if (responseData.content && (responseData.content.error_code === 4415001 || responseData.content.status === 'Prompt has contribution')) {
      return new AuthenticationError(
        'Instagram has a pending account prompt (e.g. Accounts Center / Cross-App sharing / Business tools confirmation). Please open instagram.com in your browser to accept or dismiss it.',
        {
          code: 'PROMPT_REQUIRED',
          details: responseData
        }
      );
    }

    // Rate Limiting (429)
    if (status === 429 || responseData.feedback_required) {
      const retryAfterHeader = headers && headers['retry-after'];
      const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) : 5;
      return new RateLimitError(message || 'Rate limit reached or feedback required by Instagram', {
        status,
        retryAfter,
        feedbackRequired: Boolean(responseData.feedback_required),
        details: responseData
      });
    }

    // Checkpoint / Challenge (400 with checkpoint_required)
    if (
      responseData.checkpoint_url ||
      responseData.message === 'checkpoint_required' ||
      responseData.message === 'challenge_required'
    ) {
      return new AuthenticationError('Account checkpoint verification required by Instagram', {
        code: 'CHECKPOINT_REQUIRED',
        checkpointRequired: true,
        checkpointUrl: responseData.checkpoint_url || (responseData.challenge && responseData.challenge.url) || null,
        details: responseData
      });
    }

    // Authentication Errors (401 / 403 login redirects)
    if (status === 401 || (status === 403 && (message.includes('login') || message.includes('authenticated')))) {
      return new AuthenticationError(message || 'Authentication session has expired or is invalid', {
        code: 'SESSION_EXPIRED',
        status,
        details: responseData
      });
    }

    // Not Found (404)
    if (status === 404) {
      return new NotFoundError(message || 'Requested resource, thread, or message not found', {
        details: responseData
      });
    }

    return new InstaChatError(message || `Instagram API returned HTTP status ${status}`, {
      status,
      code: `HTTP_${status}`,
      details: responseData
    });
  }

  /**
   * Executes GET request with retry.
   */
  async get(url, config = {}) {
    return withRetry(() => this.client.get(url, config), {
      maxRetries: this.maxRetries,
      isIdempotent: true,
      logger: this.logger
    });
  }

  /**
   * Executes POST request.
   * If isIdempotent is false, will not automatically retry to prevent duplicate sends.
   */
  async post(url, data = {}, config = {}, isIdempotent = false) {
    return withRetry(() => this.client.post(url, data, config), {
      maxRetries: isIdempotent ? this.maxRetries : 0,
      isIdempotent,
      logger: this.logger
    });
  }
}

module.exports = HttpTransport;
