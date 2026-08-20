#!/usr/bin/env node
'use strict';

/**
 * One-time helper to mint a Gmail refresh token for the KTrade importer.
 *
 * Run it on a machine with a browser:
 *
 *   node scripts/gmail_auth.cjs <CLIENT_ID> <CLIENT_SECRET>
 *
 * It starts a throwaway listener on http://localhost:53682, prints a consent
 * URL, and exchanges the returned code for a refresh token which you then put
 * in the server's environment. The token is printed once and never written to
 * disk by this script - copy it straight into your env file.
 *
 * Scope is gmail.readonly: enough to find confirmations and read attachments,
 * and nothing that can send or delete mail.
 */

const http = require('http');
const https = require('https');
const { URL, URLSearchParams } = require('url');

const PORT = 53682;
const REDIRECT = `http://localhost:${PORT}`;
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

const [clientId, clientSecret] = process.argv.slice(2);

if (!clientId || !clientSecret) {
  console.error('Usage: node scripts/gmail_auth.cjs <CLIENT_ID> <CLIENT_SECRET>');
  console.error('');
  console.error('Create the credentials first:');
  console.error('  1. https://console.cloud.google.com/  -> create (or pick) a project');
  console.error('  2. APIs & Services -> Library -> enable "Gmail API"');
  console.error('  3. APIs & Services -> OAuth consent screen -> External -> add yourself');
  console.error('     as a Test user (no verification needed for personal use)');
  console.error('  4. Credentials -> Create credentials -> OAuth client ID');
  console.error('     Application type: Web application');
  console.error(`     Authorised redirect URI: ${REDIRECT}`);
  process.exit(1);
}

function postForm(targetUrl, form) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(form).toString();
    const req = https.request(
      targetUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body)
        }
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { reject(new Error(data.slice(0, 300))); }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const consentUrl =
  'https://accounts.google.com/o/oauth2/v2/auth?' +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    // Without this Google omits the refresh token on repeat authorisations.
    prompt: 'consent'
  }).toString();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end(`Authorisation failed: ${error}`);
    console.error(`\nAuthorisation failed: ${error}`);
    server.close();
    return;
  }

  if (!code) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Waiting for the OAuth redirect...');
    return;
  }

  try {
    const token = await postForm('https://oauth2.googleapis.com/token', {
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT,
      grant_type: 'authorization_code'
    });

    if (!token.refresh_token) {
      throw new Error(
        `no refresh_token returned (${token.error_description || token.error || 'unknown'}). ` +
          'Revoke prior access at https://myaccount.google.com/permissions and retry.'
      );
    }

    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Refresh token issued. You can close this tab and return to the terminal.');

    console.log('\n=== Add these to the stock-api environment ===\n');
    console.log(`GMAIL_CLIENT_ID=${clientId}`);
    console.log(`GMAIL_CLIENT_SECRET=${clientSecret}`);
    console.log(`GMAIL_REFRESH_TOKEN=${token.refresh_token}`);
    console.log('\nKeep these secret: together they grant read access to the mailbox.');
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`Token exchange failed: ${err.message}`);
    console.error(`\nToken exchange failed: ${err.message}`);
  } finally {
    server.close();
  }
});

server.listen(PORT, () => {
  console.log('Open this URL in a browser and grant access:\n');
  console.log(consentUrl);
  console.log(`\nListening on ${REDIRECT} for the redirect...`);
});
