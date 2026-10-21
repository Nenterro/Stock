/**
 * stock-api client for the headless servers (statements, news). They use
 * only the write token, no PocketBase login, so they can run unattended.
 */
import { config } from './config.js';

export async function call(path, body) {
  if (!config.stockApiToken) throw new Error('STOCK_API_WRITE_TOKEN is not set (mcp/.env or environment).');
  let last;
  for (const base of config.stockApiUrls) {
    try {
      const res = await fetch(`${base}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${config.stockApiToken}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(180000)
      });
      return { base, res };
    } catch (err) {
      last = err;
    }
  }
  throw new Error(`stock-api unreachable: ${last?.message}`);
}

export async function json(path, body) {
  const { res } = await call(path, body);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status} from ${path}`);
  return data;
}

export const ok = (data) => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 1) }] });
export const fail = (m) => ({ content: [{ type: 'text', text: `Error: ${m}` }], isError: true });

/** registerTool with errors returned to the model instead of thrown. */
export const toolOn = (server) => (name, def, fn) =>
  server.registerTool(name, def, async (a) => {
    try {
      return await fn(a || {});
    } catch (err) {
      return fail(err.message);
    }
  });
