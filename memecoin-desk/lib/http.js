import { sleep } from './util.js';

export class HttpError extends Error {
  constructor(message, { status, url, body } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

// fetch() with per-key spacing (rate limits), timeouts, and retry on 429 / 5xx / network errors.
// Keys default to the hostname; callers can pass their own (e.g. one per RPC method).
export class Http {
  constructor({ intervals = {}, timeoutMs = 15_000, fetchImpl = globalThis.fetch.bind(globalThis), onRetry } = {}) {
    this.intervals = { ...intervals };
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
    this.onRetry = onRetry;
    this.next = new Map();
    this.stats = { requests: 0, retries: 0, failures: 0 };
  }

  setInterval(key, ms) {
    this.intervals[key] = ms;
  }

  // Reserve the next slot synchronously so concurrent callers queue up instead of bursting.
  reserve(key) {
    const gap = this.intervals[key];
    if (!gap) return 0;
    const now = Date.now();
    const at = Math.max(now, this.next.get(key) || 0);
    this.next.set(key, at + gap);
    return at - now;
  }

  pushBack(key, ms) {
    this.next.set(key, Math.max(this.next.get(key) || 0, Date.now() + ms));
  }

  async json(url, { method = 'GET', body, headers = {}, key, retries = 3 } = {}) {
    const limitKey = key || new URL(url).hostname;
    for (let attempt = 0; ; attempt++) {
      await sleep(this.reserve(limitKey));
      this.stats.requests++;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      let res;
      let text;
      try {
        res = await this.fetch(url, {
          method,
          headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
          body: body ? JSON.stringify(body) : undefined,
          signal: ctrl.signal,
        });
        text = await res.text();
      } catch (err) {
        clearTimeout(timer);
        if (attempt < retries) {
          await this.backoff(limitKey, attempt, null, `network: ${err.name === 'AbortError' ? 'timeout' : err.message}`, url);
          continue;
        }
        this.stats.failures++;
        throw new HttpError(`${method} ${shortUrl(url)} failed: ${err.name === 'AbortError' ? 'timeout' : err.message}`, { url });
      }
      clearTimeout(timer);

      if (res.status === 429 || res.status >= 500) {
        if (attempt < retries) {
          await this.backoff(limitKey, attempt, res.headers.get('retry-after'), `HTTP ${res.status}`, url);
          continue;
        }
        this.stats.failures++;
        throw new HttpError(`${method} ${shortUrl(url)} -> HTTP ${res.status}`, { status: res.status, url, body: text.slice(0, 300) });
      }
      if (!res.ok) {
        this.stats.failures++;
        throw new HttpError(`${method} ${shortUrl(url)} -> HTTP ${res.status}`, { status: res.status, url, body: text.slice(0, 300) });
      }
      try {
        return JSON.parse(text);
      } catch {
        this.stats.failures++;
        throw new HttpError(`${method} ${shortUrl(url)} returned invalid JSON`, { status: res.status, url, body: text.slice(0, 300) });
      }
    }
  }

  async backoff(key, attempt, retryAfter, reason, url) {
    this.stats.retries++;
    const hinted = retryAfter && Number.isFinite(+retryAfter) ? +retryAfter * 1000 : 0;
    const wait = Math.min(60_000, Math.max(hinted, 1500 * 2 ** attempt));
    this.pushBack(key, wait);
    this.onRetry?.({ key, attempt, wait, reason, url: shortUrl(url) });
    await sleep(wait);
  }
}

const shortUrl = (url) => {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 48 ? `${u.pathname.slice(0, 48)}…` : u.pathname;
    return `${u.hostname}${path}`;
  } catch {
    return String(url).slice(0, 64);
  }
};
