import PocketBase from 'pocketbase';
import { config, missingPocketBaseConfig, ENV_FILE } from './config.js';

/**
 * The user's own records in PocketBase, decrypted.
 *
 * Mirrors the app's E2EE exactly (src/utils/crypto.js + src/store/sync.js):
 * AES-GCM-256 with a PBKDF2-SHA256 key from the 4-digit PIN, the whole record
 * JSON-encrypted into `encrypted_payload` as base64(iv || ciphertext), and
 * every plaintext field blanked. Records written here sync into the app like
 * any written by another device.
 */

const SALT = new TextEncoder().encode('BUDGET_APP_E2EE_SALT_V1');
const RESERVED = new Set(['id', 'collectionId', 'collectionName', 'created', 'updated', 'users', 'expand', 'encrypted_payload']);

export const COLLECTIONS = {
  transactions: 'stock_transactions',
  portfolios: 'stock_portfolios',
  insights: 'stock_insights',
  research: 'stock_research'
};

let pb = null;
let userId = null;
let key = null;
let encryptedAccount = null;

async function deriveKey(pin) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), { name: 'PBKDF2' }, false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: SALT, iterations: 100000, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function decrypt(b64) {
  if (!key) {
    throw new Error(`This account's data is end-to-end encrypted. Add E2EE_PIN to ${ENV_FILE} and restart the MCP server.`);
  }
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    throw new Error('Decryption failed: E2EE_PIN does not match the PIN this data was encrypted with.');
  }
}

async function encrypt(payload) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(payload))));
  const combined = new Uint8Array(iv.length + cipher.length);
  combined.set(iv);
  combined.set(cipher, iv.length);
  let bin = '';
  for (const b of combined) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function reachable(url) {
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function connect() {
  if (pb?.authStore.isValid && userId) return pb;
  const missing = missingPocketBaseConfig();
  if (missing.length) {
    throw new Error(`PocketBase login not configured: set ${missing.join(', ')} in ${ENV_FILE} (see mcp/.env.example), then restart the MCP server.`);
  }

  let url = null;
  for (const candidate of config.pbUrls) {
    if (await reachable(candidate)) {
      url = candidate;
      break;
    }
  }
  if (!url) throw new Error(`No PocketBase server reachable (tried ${config.pbUrls.join(', ')}).`);

  pb = new PocketBase(url);
  pb.autoCancellation(false);
  const auth = await pb.collection('users').authWithPassword(config.pbEmail, config.pbPassword);
  userId = auth.record.id;
  if (config.pin) key = await deriveKey(config.pin);
  return pb;
}

/** Whether this account stores its records encrypted (any existing record says so). */
async function isEncryptedAccount() {
  if (encryptedAccount !== null) return encryptedAccount;
  await connect();
  for (const coll of [COLLECTIONS.transactions, COLLECTIONS.portfolios]) {
    const page = await pb.collection(coll).getList(1, 1, { filter: `users = "${userId}" && encrypted_payload != ""` });
    if (page.totalItems > 0) {
      encryptedAccount = true;
      return true;
    }
  }
  encryptedAccount = false;
  return false;
}

async function toItem(record) {
  if (record.encrypted_payload) {
    const data = await decrypt(record.encrypted_payload);
    return { ...data, id: record.id, _updated: record.updated, _created: record.created };
  }
  const { collectionId, collectionName, expand, encrypted_payload, users, ...plain } = record;
  return { ...plain, _updated: record.updated, _created: record.created };
}

export async function list(collection, { filter } = {}) {
  await connect();
  const records = await pb.collection(collection).getFullList({
    filter: filter ? `users = "${userId}" && (${filter})` : `users = "${userId}"`,
    sort: '-created'
  });
  const out = [];
  for (const r of records) {
    const item = await toItem(r);
    if (!item.deleted) out.push(item);
  }
  return out;
}

export async function get(collection, id) {
  await connect();
  return toItem(await pb.collection(collection).getOne(id));
}

/** Build the wire record the way the app's sync does. */
async function toRecord(item) {
  const payload = { ...item };
  delete payload.pendingSync;
  delete payload.updatedAt;
  delete payload._updated;
  delete payload._created;

  if (await isEncryptedAccount()) {
    if (!key) {
      throw new Error(`Refusing to write: this account is end-to-end encrypted and E2EE_PIN is not set in ${ENV_FILE}. Writing plaintext would leak the record and the app could not merge it.`);
    }
    const record = { encrypted_payload: await encrypt(payload), users: userId };
    for (const [k, v] of Object.entries(payload)) {
      if (RESERVED.has(k)) continue;
      record[k] = typeof v === 'number' ? 0 : typeof v === 'boolean' ? false : '';
    }
    return record;
  }
  const { id, ...rest } = payload;
  return { ...rest, encrypted_payload: '', users: userId };
}

/** 15 lowercase alphanumerics: the id format both PocketBase and the app use. */
export function newId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(15));
  return [...bytes].map((b) => chars[b % chars.length]).join('');
}

export async function create(collection, item) {
  await connect();
  const id = item.id && item.id.length === 15 ? item.id : newId();
  const body = { ...(await toRecord({ ...item, id })), id };
  const created = await pb.collection(collection).create(body);
  return toItem(created);
}

export async function update(collection, id, item) {
  await connect();
  const updated = await pb.collection(collection).update(id, await toRecord({ ...item, id }));
  return toItem(updated);
}

export async function remove(collection, id) {
  await connect();
  await pb.collection(collection).delete(id);
  return true;
}

export async function whoami() {
  await connect();
  return { userId, email: pb.authStore.model?.email, pbUrl: pb.baseUrl, encrypted: await isEncryptedAccount(), pinConfigured: Boolean(key) };
}
