'use strict';

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { URL } = require('url');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

// Connection reuse matters a lot here: nearly every upstream call goes to one of
// three hosts, and TLS handshakes dominated latency in the old implementation.
const agents = {
  http: new http.Agent({ keepAlive: true, maxSockets: 24, keepAliveMsecs: 30000 }),
  https: new https.Agent({ keepAlive: true, maxSockets: 24, keepAliveMsecs: 30000 })
};

function decompress(res, buffer) {
  const encoding = (res.headers['content-encoding'] || '').toLowerCase();
  try {
    if (encoding === 'gzip') return zlib.gunzipSync(buffer);
    if (encoding === 'deflate') return zlib.inflateSync(buffer);
    if (encoding === 'br') return zlib.brotliDecompressSync(buffer);
  } catch (err) {
    // A corrupt encoded body is worth surfacing as "no data" rather than throwing.
    return null;
  }
  return buffer;
}

/**
 * Single HTTP request. Resolves { status, headers, body, url } and never rejects
 * for transport errors - callers treat a null body as failure.
 */
function once(targetUrl, options = {}) {
  const {
    timeout = 8000,
    headers = {},
    method = 'GET',
    cookieJar = null,
    maxRedirects = 4
  } = options;

  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch {
      return resolve({ status: 0, headers: {}, body: null, url: targetUrl });
    }

    const isHttps = parsed.protocol === 'https:';
    const client = isHttps ? https : http;

    const reqHeaders = {
      'User-Agent': UA,
      Accept: 'application/json,text/html,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      ...headers
    };
    if (cookieJar && cookieJar.header()) reqHeaders.Cookie = cookieJar.header();

    const req = client.request(
      targetUrl,
      { method, headers: reqHeaders, agent: isHttps ? agents.https : agents.http, timeout },
      (res) => {
        if (cookieJar) cookieJar.absorb(res.headers['set-cookie']);

        const status = res.statusCode || 0;

        if (status >= 300 && status < 400 && res.headers.location && maxRedirects > 0) {
          res.resume();
          const next = new URL(res.headers.location, targetUrl).toString();
          return resolve(once(next, { ...options, maxRedirects: maxRedirects - 1 }));
        }

        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = decompress(res, Buffer.concat(chunks));
          resolve({
            status,
            headers: res.headers,
            body: raw ? raw.toString('utf8') : null,
            url: targetUrl
          });
        });
        res.on('error', () => resolve({ status, headers: res.headers, body: null, url: targetUrl }));
      }
    );

    req.on('error', () => resolve({ status: 0, headers: {}, body: null, url: targetUrl }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, headers: {}, body: null, url: targetUrl, timedOut: true });
    });

    if (options.body) req.write(options.body);
    req.end();
  });
}

/**
 * Cookie jar just rich enough for Yahoo's crumb handshake.
 */
class CookieJar {
  constructor() {
    this.jar = new Map();
  }
  absorb(setCookie) {
    if (!setCookie) return;
    for (const line of [].concat(setCookie)) {
      const [pair] = line.split(';');
      const idx = pair.indexOf('=');
      if (idx > 0) this.jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }
  header() {
    if (this.jar.size === 0) return '';
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  clear() {
    this.jar.clear();
  }
}

/**
 * Serialised, rate-limited request lane for one upstream host.
 *
 * Yahoo answers 429 to even mildly bursty traffic, so every provider funnels
 * through a lane that enforces a minimum gap between requests and backs off
 * exponentially when it sees 429/503.
 */
class RequestLane {
  constructor({ name, minGapMs = 0, concurrency = 4, maxBackoffMs = 60000 }) {
    this.name = name;
    this.minGapMs = minGapMs;
    this.concurrency = concurrency;
    this.maxBackoffMs = maxBackoffMs;
    this.queue = [];
    this.active = 0;
    this.lastStart = 0;
    this.penaltyUntil = 0;
    this.backoffMs = 0;
    this.stats = { sent: 0, throttled: 0, failed: 0 };
  }

  get throttledUntil() {
    return this.penaltyUntil;
  }

  penalise() {
    this.backoffMs = this.backoffMs ? Math.min(this.backoffMs * 2, this.maxBackoffMs) : 2000;
    this.penaltyUntil = Date.now() + this.backoffMs;
    this.stats.throttled += 1;
  }

  relax() {
    this.backoffMs = 0;
    this.penaltyUntil = 0;
  }

  run(targetUrl, options) {
    return new Promise((resolve) => {
      this.queue.push({ targetUrl, options, resolve });
      this._pump();
    });
  }

  _pump() {
    if (this.active >= this.concurrency || this.queue.length === 0) return;

    const now = Date.now();
    const earliest = Math.max(this.lastStart + this.minGapMs, this.penaltyUntil);
    if (earliest > now) {
      setTimeout(() => this._pump(), earliest - now);
      return;
    }

    const job = this.queue.shift();
    this.active += 1;
    this.lastStart = Date.now();
    this.stats.sent += 1;

    once(job.targetUrl, job.options)
      .then((res) => {
        if (res.status === 429 || res.status === 503) this.penalise();
        else if (res.status >= 200 && res.status < 300) this.relax();
        else if (res.status === 0) this.stats.failed += 1;
        job.resolve(res);
      })
      .catch(() => job.resolve({ status: 0, headers: {}, body: null, url: job.targetUrl }))
      .finally(() => {
        this.active -= 1;
        this._pump();
      });

    this._pump();
  }
}

/** Retry wrapper: retries transport failures and throttling, not 404s. */
async function request(lane, targetUrl, options = {}) {
  const { retries = 2, ...rest } = options;
  let res = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    res = await lane.run(targetUrl, rest);
    const retryable = res.status === 0 || res.status === 429 || res.status === 503;
    if (!retryable) return res;
    if (attempt < retries) {
      await new Promise((r) => setTimeout(r, 400 * Math.pow(2, attempt)));
    }
  }
  return res;
}

async function getJson(lane, targetUrl, options = {}) {
  const res = await request(lane, targetUrl, options);
  if (!res.body || res.status < 200 || res.status >= 300) return null;
  try {
    return JSON.parse(res.body);
  } catch {
    return null;
  }
}

async function getText(lane, targetUrl, options = {}) {
  const res = await request(lane, targetUrl, options);
  if (!res.body || res.status < 200 || res.status >= 300) return null;
  return res.body;
}

module.exports = { once, request, getJson, getText, RequestLane, CookieJar, UA, agents };
