import { bytesToBase64Url, pemToArrayBuffer, utf8ToBase64Url } from './encoding.js';

const VERTEX_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const TOKEN_URL='https://oauth2.googleapis.com/token';
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAYS_MS = [1000, 5000, 15000];
const RETRY_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

const accessTokenCache = new Map();
const privateKeyCache = new Map();

export class VertexClient {
  constructor(vertexConfig) {
    this.vertexConfig = vertexConfig;
  }

  async generateContent(model, body, options = {}) {
    const endpoint = this.buildEndpoint(model, 'generateContent');
    const response = await this.fetchVertex(endpoint, body, options);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = payload.error?.message || response.statusText;
      const error = new Error(`Vertex AI request failed: ${friendlyVertexMessage(response.status, message)}`);
      error.status = response.status;
      error.details = payload;
      throw error;
    }

    return payload;
  }

  async *streamGenerateContent(model, body, options = {}) {
    const endpoint = `${this.buildEndpoint(model, 'streamGenerateContent')}?alt=sse`;
    const response = await this.fetchVertex(endpoint, body, options);

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      const message = payload.error?.message || response.statusText;
      const error = new Error(`Vertex AI stream request failed: ${friendlyVertexMessage(response.status, message)}`);
      error.status = response.status;
      error.details = payload;
      throw error;
    }

    yield* parseSseStream(response.body);
  }

  async fetchVertex(endpoint, body, options = {}) {
    let lastResponse = null;
    let lastError = null;

    let signal = options.signal;
    let timeoutId;
    if (!signal) {
      const controller = new AbortController();
      signal = controller.signal;
      timeoutId = setTimeout(() => controller.abort(new Error("Timeout reached (180s)")), 180000);
    }
    
    for (let attempt = 0; attempt <= DEFAULT_RETRY_ATTEMPTS; attempt += 1) {
      let response;
      try {
        const token = await this.getAccessToken();
        response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          signal: signal,
          body: JSON.stringify(body)
        });
      } catch (error) {
        if (signal?.aborted || attempt >= DEFAULT_RETRY_ATTEMPTS) {
          if (timeoutId) clearTimeout(timeoutId);
          throw lastError || error;
        }

        lastError = error;
        await sleep(retryDelayMs(null, attempt));
        continue;
      }

      if (!shouldRetry(response, attempt)) {
        if (timeoutId) clearTimeout(timeoutId);
        return response;
      }

      lastResponse = response;
      await response.body?.cancel?.().catch(() => {});
      await sleep(retryDelayMs(response, attempt));
    }

    if (timeoutId) clearTimeout(timeoutId);
    if (lastError) throw lastError;
    return lastResponse;
  }

  buildEndpoint(model, method) {
    const { projectId, location } = this.vertexConfig;
    const host = location === 'global' ? 'https://aiplatform.googleapis.com' : `https://${location}-aiplatform.googleapis.com`;
    return `${host}/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:${method}`;
  }

  async getAccessToken() {
    const now = Math.floor(Date.now() / 1000);
    const cacheKey = `${this.vertexConfig.projectId}:${this.vertexConfig.clientEmail}`;
    const cached = accessTokenCache.get(cacheKey);
    if (cached && cached.expiresAt - 60 > now) {
      return cached.accessToken;
    }

    const assertion = await this.createJwtAssertion(now);
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion
      })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = payload.error_description || payload.error || response.statusText;
      const error = new Error(`Google OAuth token request failed: ${message}`);
      error.status = response.status;
      error.details = payload;
      throw error;
    }

    accessTokenCache.set(cacheKey, {
      accessToken: payload.access_token,
      expiresAt: now + Number(payload.expires_in || 3600)
    });
    return payload.access_token;
  }

  async createJwtAssertion(now) {
    const header = utf8ToBase64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claim = utf8ToBase64Url(JSON.stringify({
      iss: this.vertexConfig.clientEmail,
      scope: VERTEX_SCOPE,
      aud: TOKEN_URL,
      exp: now + 3600,
      iat: now
    }));
    const unsigned = `${header}.${claim}`;

    let key;
    try {
      key = await importPrivateKey(this.vertexConfig.privateKey);
    } catch (error) {
      const wrapped = new Error('Private key could not be parsed. Set VERTEX_SERVICE_ACCOUNT_JSON or VERTEX_PRIVATE_KEY with the service account private_key value.');
      wrapped.status = 400;
      wrapped.details = { message: error.message };
      throw wrapped;
    }

    const signature = new Uint8Array(await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      key,
      new TextEncoder().encode(unsigned)
    ));
    return `${unsigned}.${bytesToBase64Url(signature)}`;
  }
}

async function importPrivateKey(privateKey) {
  if (privateKeyCache.has(privateKey)) {
    return privateKeyCache.get(privateKey);
  }

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(privateKey),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  privateKeyCache.set(privateKey, key);
  return key;
}

function shouldRetry(response, attempt) {
  return attempt < DEFAULT_RETRY_ATTEMPTS && RETRY_STATUS_CODES.has(response.status);
}

function retryDelayMs(response, attempt) {
  const retryAfter = response?.headers?.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  }

  return DEFAULT_RETRY_DELAYS_MS[Math.min(attempt, DEFAULT_RETRY_DELAYS_MS.length - 1)];
}

function friendlyVertexMessage(status, message) {
  if (status === 429) {
    return `${message} Retried automatically but Vertex AI quota/rate limit is still exhausted. Reduce request rate, switch model/location, or request a higher quota in Google Cloud.`;
  }
  return message;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function* parseSseStream(body) {
  const reader = body?.getReader?.();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() || '';

      for (const event of events) {
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');

        if (!data || data === '[DONE]') continue;
        yield JSON.parse(data);
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      const data = buffer
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data && data !== '[DONE]') yield JSON.parse(data);
    }
  } finally {
    reader.releaseLock();
  }
}
