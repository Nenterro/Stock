'use strict';

const { RequestLane, request } = require('../http');

// Gmail is generous but not unlimited, and a scan fans out into one request per
// message; keep it to a polite lane.
const lane = new RequestLane({ name: 'gmail', minGapMs: 60, concurrency: 4 });

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

/**
 * Credentials come from the environment, never from the repo. A refresh token
 * is long-lived and grants read access to a mailbox, so it belongs in the
 * server's env alongside the client secret - not in source control, and not in
 * anything the browser can read.
 */
function config() {
  return {
    clientId: process.env.GMAIL_CLIENT_ID || '',
    clientSecret: process.env.GMAIL_CLIENT_SECRET || '',
    refreshToken: process.env.GMAIL_REFRESH_TOKEN || '',
    // Who KTrade confirmations arrive from; overridable without a code change.
    sender: process.env.KTRADE_SENDER || 'settlement@kasb.com'
  };
}

function isConfigured() {
  const c = config();
  return Boolean(c.clientId && c.clientSecret && c.refreshToken);
}

let accessToken = null;
let accessTokenExpiry = 0;
let refreshing = null;

/** Exchange the refresh token for a short-lived access token, with caching. */
async function getAccessToken(force = false) {
  const now = Date.now();
  if (!force && accessToken && now < accessTokenExpiry - 60000) return accessToken;
  if (refreshing) return refreshing;

  const c = config();
  if (!isConfigured()) throw new Error('Gmail is not configured on this server');

  refreshing = (async () => {
    try {
      const body = new URLSearchParams({
        client_id: c.clientId,
        client_secret: c.clientSecret,
        refresh_token: c.refreshToken,
        grant_type: 'refresh_token'
      }).toString();

      const res = await request(lane, TOKEN_URL, {
        method: 'POST',
        timeout: 15000,
        retries: 1,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
      });

      let parsed = null;
      try {
        parsed = JSON.parse(res.body || 'null');
      } catch {
        parsed = null;
      }

      if (!parsed || !parsed.access_token) {
        const detail = parsed?.error_description || parsed?.error || `HTTP ${res.status}`;
        throw new Error(`Gmail token refresh failed: ${detail}`);
      }

      accessToken = parsed.access_token;
      accessTokenExpiry = Date.now() + (parsed.expires_in || 3600) * 1000;
      return accessToken;
    } finally {
      refreshing = null;
    }
  })();

  return refreshing;
}

async function apiGet(path, { retryOnAuth = true } = {}) {
  const token = await getAccessToken();
  const res = await request(lane, `${API}${path}`, {
    timeout: 20000,
    retries: 1,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
  });

  if (res.status === 401 && retryOnAuth) {
    await getAccessToken(true);
    return apiGet(path, { retryOnAuth: false });
  }

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Gmail API ${path} -> HTTP ${res.status}`);
  }

  try {
    return JSON.parse(res.body || 'null');
  } catch {
    throw new Error(`Gmail API ${path} returned unparseable JSON`);
  }
}

/** Message ids matching a Gmail search query. */
async function searchMessages({ since = null, max = 50 } = {}) {
  const c = config();
  const terms = [`from:${c.sender}`, 'has:attachment'];
  if (since) {
    // Gmail's after: wants YYYY/MM/DD.
    terms.push(`after:${String(since).replace(/-/g, '/')}`);
  }

  const q = encodeURIComponent(terms.join(' '));
  const data = await apiGet(`/messages?q=${q}&maxResults=${Math.min(max, 100)}`);
  return (data?.messages || []).map((m) => m.id);
}

function headerValue(payload, name) {
  const h = (payload?.headers || []).find(
    (x) => String(x.name).toLowerCase() === name.toLowerCase()
  );
  return h ? h.value : null;
}

/** Walk the MIME tree and collect PDF attachment stubs. */
function collectPdfParts(part, acc = []) {
  if (!part) return acc;
  const filename = part.filename || '';
  const mime = part.mimeType || '';
  const isPdf = /\.pdf$/i.test(filename) || mime === 'application/pdf';

  if (isPdf && part.body?.attachmentId) {
    acc.push({ filename, attachmentId: part.body.attachmentId });
  }
  for (const child of part.parts || []) collectPdfParts(child, acc);
  return acc;
}

async function getMessage(id) {
  const msg = await apiGet(`/messages/${encodeURIComponent(id)}?format=full`);
  return {
    id,
    subject: headerValue(msg.payload, 'Subject'),
    date: headerValue(msg.payload, 'Date'),
    from: headerValue(msg.payload, 'From'),
    attachments: collectPdfParts(msg.payload)
  };
}

async function getAttachment(messageId, attachmentId) {
  const data = await apiGet(
    `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`
  );
  if (!data?.data) return null;
  // Gmail returns base64url.
  return Buffer.from(String(data.data).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** Mailbox address the refresh token belongs to - handy for a status display. */
async function profile() {
  const p = await apiGet('/profile');
  return { emailAddress: p?.emailAddress || null, messagesTotal: p?.messagesTotal ?? null };
}

module.exports = {
  isConfigured,
  config,
  getAccessToken,
  searchMessages,
  getMessage,
  getAttachment,
  profile
};
