import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * mcp/.auth.json (gitignored): the PocketBase session from signing in with
 * Google via scripts/login.js. Accounts created through OAuth have no usable
 * password, so this token stands in for PB_EMAIL/PB_PASSWORD. The server
 * refreshes it on every start, which keeps it alive as long as it is used at
 * least once per token lifetime (14 days by default).
 */
export const SESSION_FILE = join(here, '..', '.auth.json');

export function readSession() {
  if (!existsSync(SESSION_FILE)) return null;
  try {
    const s = JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
    return s?.token ? s : null;
  } catch {
    return null;
  }
}

export function writeSession({ token, record, pbUrl }) {
  const body = { token, record: { id: record?.id, email: record?.email, collectionId: record?.collectionId, collectionName: record?.collectionName }, pbUrl, savedAt: new Date().toISOString() };
  writeFileSync(SESSION_FILE, JSON.stringify(body, null, 2));
  try {
    chmodSync(SESSION_FILE, 0o600);
  } catch {
    // Windows ignores POSIX modes; the file sits in a gitignored folder of the user's profile.
  }
}
