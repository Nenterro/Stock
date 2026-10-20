/**
 * Sign the MCP server in with Google, the same way the app does.
 *
 *   node mcp/scripts/login.js            # opens the browser
 *   node mcp/scripts/login.js --no-open  # just prints the URL
 *
 * Saves the PocketBase session to mcp/.auth.json. Run again only if the
 * server reports the session expired (unused for longer than the token
 * lifetime). Your E2EE PIN still goes in mcp/.env as E2EE_PIN.
 */
import { EventSource } from 'eventsource';
import PocketBase from 'pocketbase';
import { spawn } from 'node:child_process';
import { config } from '../lib/config.js';
import { writeSession, SESSION_FILE } from '../lib/session.js';

// The SDK receives the OAuth result over PocketBase's realtime channel.
globalThis.EventSource = EventSource;

const noOpen = process.argv.includes('--no-open');
const provider = process.argv.find((a) => a.startsWith('--provider='))?.split('=')[1] || 'google';

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', `"${url}"`]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true, windowsVerbatimArguments: true }).unref();
}

async function reachable(url) {
  try {
    return (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(5000) })).ok;
  } catch {
    return false;
  }
}

let pbUrl = null;
for (const u of config.pbUrls) if (await reachable(u)) { pbUrl = u; break; }
if (!pbUrl) {
  console.error(`No PocketBase server reachable (tried ${config.pbUrls.join(', ')}).`);
  process.exit(1);
}

const pb = new PocketBase(pbUrl);
const timer = setTimeout(() => {
  console.error('Timed out waiting for the sign-in to finish (5 minutes). Run the script again.');
  process.exit(1);
}, 5 * 60 * 1000);

try {
  const auth = await pb.collection('users').authWithOAuth2({
    provider,
    urlCallback: (url) => {
      console.log(`\nSign in with ${provider} in your browser${noOpen ? '' : ' (opening it now)'}:\n\n  ${url}\n`);
      if (!noOpen) openBrowser(url);
    }
  });
  clearTimeout(timer);
  writeSession({ token: pb.authStore.token, record: auth.record, pbUrl });
  console.log(`Signed in as ${auth.record.email}. Session saved to ${SESSION_FILE}.`);
  console.log('Restart the MCP server (in Claude Code: /mcp, then reconnect stock-tracker) to pick it up.');
  process.exit(0);
} catch (err) {
  clearTimeout(timer);
  console.error(`Sign-in failed: ${err?.message || err}`);
  process.exit(1);
}
