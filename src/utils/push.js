// Web Push for this app, through the home server's push hub (companion-api).
//
// The hub ties each device's subscription to the signed-in user, so one
// person's notifications never reach another's phone. On iOS, push only works
// once the app has been added to the Home Screen.

import { pb } from '../store/sync';

const APP = 'stocks';
const DEFAULT_HUB = 'https://companion-api.huzaifa.page';
const hub = () => (localStorage.getItem('COMPANION_URL') || DEFAULT_HUB).replace(/\/+$/, '');

async function call(path, { method = 'GET', body, endpoint } = {}) {
  const q = new URLSearchParams({ app: APP });
  if (endpoint && method === 'GET') q.set('endpoint', endpoint);
  const res = await fetch(`${hub()}${path}?${q}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pb.authStore.token}` },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000)
  }).catch(() => {
    throw new Error("Can't reach the notification server. Try again in a moment.");
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Notification server answered ${res.status}`);
  return data;
}

/** What this browser can do, before anything is asked of the user. */
export function pushSupport() {
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return {
    supported,
    // iOS exposes push only to the Home Screen app, not to a Safari tab.
    needsInstall: ios && !standalone,
    permission: supported ? Notification.permission : 'unsupported',
    signedIn: pb.authStore.isValid
  };
}

async function subscription() {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

function keyBytes(base64url) {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(base64url.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

/** Types, their switches and the thresholds, as the hub holds them. */
export async function pushStatus() {
  const sub = await subscription().catch(() => null);
  return call('/push/prefs', { endpoint: sub?.endpoint });
}

/** Must be called straight from a tap: iOS only shows the prompt then. */
export async function enablePush() {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications are blocked for this app. Allow them in Settings.');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const { vapidPublicKey } = await call('/push/prefs');
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(vapidPublicKey) });
  }
  return call('/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
}

export async function disablePush() {
  const sub = await subscription();
  if (!sub) return;
  await call('/push/subscribe', { method: 'DELETE', body: { endpoint: sub.endpoint } }).catch(() => {});
  await sub.unsubscribe();
}

export async function savePushPrefs(patch) {
  const sub = await subscription();
  return call('/push/prefs', { method: 'PUT', body: { endpoint: sub?.endpoint, ...patch } });
}

export async function sendTestPush() {
  const sub = await subscription();
  if (!sub) throw new Error('Turn notifications on first.');
  return call('/push/test', { method: 'POST', body: { endpoint: sub.endpoint } });
}

/** The icon badge counts unread notifications; opening the app reads them. */
export function clearBadgeWhenOpen() {
  const clear = () => {
    if (document.visibilityState === 'visible') navigator.clearAppBadge?.().catch(() => {});
  };
  document.addEventListener('visibilitychange', clear);
  clear();
}
