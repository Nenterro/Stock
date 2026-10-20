import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const ENV_FILE = join(here, '..', '.env');

/**
 * mcp/.env, gitignored. Real environment variables win, so the same server can
 * be pointed elsewhere without editing the file.
 */
function loadEnvFile() {
  if (!existsSync(ENV_FILE)) return {};
  const out = {};
  for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

const file = loadEnvFile();
const env = (key, fallback = '') => process.env[key] ?? file[key] ?? fallback;
const list = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);

export const config = {
  // LAN fallbacks, if wanted, go in mcp/.env: this file is public.
  stockApiUrls: list(env('STOCK_API_URL', 'https://huz-stock.duckdns.org:8888')),
  stockApiToken: env('STOCK_API_WRITE_TOKEN'),
  pbUrls: list(env('PB_URL', 'https://huz-budget.duckdns.org:8888')),
  pbEmail: env('PB_EMAIL'),
  pbPassword: env('PB_PASSWORD'),
  pin: env('E2EE_PIN'),
  allowTransactionWrites: /^(1|true|yes)$/i.test(env('ALLOW_TRANSACTION_WRITES', 'false'))
};

/**
 * How the server signs in to PocketBase: a password from .env if one is set,
 * otherwise the Google session saved by scripts/login.js (mcp/.auth.json).
 */
export function hasPasswordLogin() {
  return Boolean(config.pbEmail && config.pbPassword);
}
