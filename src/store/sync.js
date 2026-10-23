import PocketBase from 'pocketbase';
import * as db from './db';
import { encryptPayload, decryptPayload, isUnlocked } from '../utils/crypto';

export const PB_URLS = [
  'https://huz-budget.duckdns.org:8888',
  'https://huz-budget.duckdns.org',
  'http://192.168.18.49:8090'
];

export const pb = new PocketBase('https://huz-budget.duckdns.org:8888');

export async function checkUrl(url) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${url}/api/health`, { method: 'GET', signal: controller.signal });
    clearTimeout(timeoutId);
    return res.ok;
  } catch (e) {
    return false;
  }
}

export async function connectPocketBase() {
  const savedUrl = localStorage.getItem('PB_URL');
  
  // Try saved URL first if it exists
  if (savedUrl && await checkUrl(savedUrl)) {
    pb.baseUrl = savedUrl;
    return savedUrl;
  }

  // Fallback to iterating through our list
  for (const url of PB_URLS) {
    if (url === savedUrl) continue;
    if (await checkUrl(url)) {
      localStorage.setItem('PB_URL', url);
      pb.baseUrl = url;
      return url;
    }
  }

  // Nothing answered. Leave a sane default on the client for later retries,
  // but report the failure rather than returning a URL that does not work -
  // callers were treating any return value as "connected".
  pb.baseUrl = 'https://huz-budget.duckdns.org:8888';
  return null;
}

// ─── Settings ID Mapping ───
// Local settings use a fixed key 'stocksettings123' (16 chars).
// PocketBase auto-generates 15-char IDs. We store the mapping so
// we can update the correct remote record instead of creating duplicates.

// V2: ids saved under the old key point at records in the budget app's
// `settings` collection and must never be updated from here again.
const SETTINGS_PB_ID_KEY = 'STOCK_SETTINGS_PB_ID_V2';

function getSettingsPbId() {
  return localStorage.getItem(SETTINGS_PB_ID_KEY) || null;
}

function setSettingsPbId(pbId) {
  localStorage.setItem(SETTINGS_PB_ID_KEY, pbId);
}

// ─── Helper: get current user ID safely ───
function getCurrentUserId() {
  return (pb.authStore.isValid && pb.authStore.model) ? pb.authStore.model.id : null;
}

/**
 * The budget app's transactions, decrypted. Same server, account and PIN-derived
 * key as this app, so they read like our own records. Read-only: nothing here
 * ever writes to the budget app's collections.
 */
export async function fetchBudgetTransactions() {
  await connectPocketBase();
  const usersId = getCurrentUserId();
  if (!usersId) throw new Error('Sign in to read the budget app.');
  if (!isUnlocked()) throw new Error('Unlock the app with your PIN first.');

  const records = await pb.collection('transactions').getFullList({ filter: `users = "${usersId}"`, sort: '-created' });
  const out = [];
  for (const r of records) {
    if (!r.encrypted_payload) {
      out.push(r);
      continue;
    }
    try {
      out.push({ ...(await decryptPayload(r.encrypted_payload)), id: r.id });
    } catch (err) {
      console.warn('Could not decrypt budget transaction', r.id, err);
    }
  }
  return out;
}

// ─── Helper: check E2EE state from localforage ───
async function getE2eeState() {
  const record = await db.settingsStore.getItem('stocksettings123');
  return record?.config?.security?.e2eeEnabled || false;
}

// ─── Sync a single settings record (special handling for ID mismatch) ───
async function syncSettingsStore() {
  const store = db.settingsStore;
  // `settings` is the budget app's collection on the same PocketBase. This
  // store used to read and write it, so stock settings and budget settings
  // overwrote each other's records. `stock_settings` is the collection the
  // realtime subscription already listened to.
  const collectionName = 'stock_settings';
  const e2eeEnabled = await getE2eeState();
  const usersId = getCurrentUserId();

  if (e2eeEnabled && !isUnlocked()) return;

  try {
    // ── PHASE 1: Pull remote settings first ──
    const fetchOptions = { sort: '-created' };
    if (usersId) {
      fetchOptions.filter = `users = "${usersId}"`;
    }

    let remoteSettings;
    try {
      remoteSettings = await pb.collection(collectionName).getFullList(fetchOptions);
    } catch (e) {
      console.warn('Failed to fetch remote settings:', e);
      remoteSettings = [];
    }

    if (remoteSettings.length > 0) {
      const remote = remoteSettings[0];
      // Save the PocketBase ID mapping
      setSettingsPbId(remote.id);

      let finalRemote = null;

      if (remote.encrypted_payload && e2eeEnabled && isUnlocked()) {
        try {
          const decrypted = await decryptPayload(remote.encrypted_payload);
          decrypted.id = 'stocksettings123';
          finalRemote = decrypted;
        } catch (err) {
          console.error('Failed to decrypt remote settings:', err);
        }
      } else if (!remote.encrypted_payload) {
        finalRemote = { ...remote, id: 'stocksettings123' };
      } else if (remote.encrypted_payload && !e2eeEnabled) {
        // Remote is encrypted but local says E2EE is off — trust the remote: E2EE is on
        // We can't decrypt yet, but we mark it so the caller knows to prompt PIN
        finalRemote = { ...remote, id: 'stocksettings123' };
      }

      if (finalRemote) {
        const local = await store.getItem('stocksettings123');
        if (!local || new Date(remote.updated) > new Date(local.updatedAt || 0)) {
          const merged = { ...local, ...finalRemote, id: 'stocksettings123', pendingSync: false, updatedAt: remote.updated };
          await store.setItem('stocksettings123', merged);
        }
      }
    }

    // ── PHASE 2: Push local pending settings ──
    const localSettings = await store.getItem('stocksettings123');
    // Nothing in stock_settings yet (first run after moving off the budget
    // app's collection): seed it from this device.
    const seedRemote = remoteSettings.length === 0 && !getSettingsPbId();
    if (localSettings && (localSettings.pendingSync || seedRemote)) {
      const payload = { ...localSettings };
      delete payload.pendingSync;
      delete payload.updatedAt;

      let syncPayload;
      if (e2eeEnabled && isUnlocked()) {
        const encrypted = await encryptPayload(payload);
        syncPayload = { encrypted_payload: encrypted };
        // Clear plaintext fields
        for (const key of Object.keys(payload)) {
          if (!['id', 'collectionId', 'collectionName', 'created', 'updated', 'users', 'expand', 'encrypted_payload'].includes(key)) {
            const val = payload[key];
            if (typeof val === 'number') syncPayload[key] = 0;
            else if (typeof val === 'boolean') syncPayload[key] = false;
            else syncPayload[key] = "";
          }
        }
      } else {
        syncPayload = { ...payload, encrypted_payload: "" };
      }

      if (usersId) syncPayload.users = usersId;
      // Remove the local-only ID from the payload sent to PocketBase
      delete syncPayload.id;

      try {
        const pbId = getSettingsPbId();
        if (pbId) {
          // Update existing remote record
          await pb.collection(collectionName).update(pbId, syncPayload);
        } else {
          // Create new remote record
          const created = await pb.collection(collectionName).create(syncPayload);
          setSettingsPbId(created.id);
        }
        localSettings.pendingSync = false;
        await store.setItem('stocksettings123', localSettings);
      } catch (err) {
        console.error('PB Settings Push Error:', err);
      }
    }
  } catch (error) {
    console.error('Settings Sync Error:', error);
  }
}

// ─── Sync a regular data store (transactions, accounts, etc.) ───
async function syncDataStore(store, collectionName) {
  const e2eeEnabled = await getE2eeState();
  const usersId = getCurrentUserId();

  if (e2eeEnabled && !isUnlocked()) return;

  try {
    // ── PHASE 1: Pull remote records first ──
    const fetchOptions = { sort: '-created' };
    if (usersId) {
      fetchOptions.filter = `users = "${usersId}"`;
    }

    let remoteItems;
    try {
      remoteItems = await pb.collection(collectionName).getFullList(fetchOptions);
    } catch (e) {
      console.warn(`Failed to fetch remote ${collectionName}:`, e);
      remoteItems = [];
    }

    for (const remote of remoteItems) {
      let finalRemote = null;

      if (remote.encrypted_payload) {
        if (!e2eeEnabled || !isUnlocked()) continue;
        try {
          const decrypted = await decryptPayload(remote.encrypted_payload);
          decrypted.id = remote.id;
          finalRemote = decrypted;
        } catch (err) {
          console.error(`Failed to decrypt remote ${collectionName} item`, remote.id, err);
          continue;
        }
      } else {
        finalRemote = remote;
      }

      if (!finalRemote) continue;

      const local = await store.getItem(remote.id);
      if (!local || new Date(remote.updated) > new Date(local.updatedAt || 0)) {
        // Only overwrite if remote is newer or local doesn't exist
        if (local && local.pendingSync) {
          // Local has unsaved changes — skip overwriting, we'll push these next
          continue;
        }
        const merged = { ...finalRemote, pendingSync: false, updatedAt: remote.updated };
        await store.setItem(remote.id, merged);
      }
    }

    // ── PHASE 2: Push local pending items ──
    // Anything written here is newer than the PHASE 1 snapshot, so PHASE 3
    // must not judge it against that snapshot.
    const justSynced = new Set();
    const localItems = [];
    await store.iterate((value) => {
      if (value && value.pendingSync) localItems.push(value);
    });

    for (const item of localItems) {
      if (item.deleted) {
        try {
          if (item.id && item.id.length === 15) {
            await pb.collection(collectionName).delete(item.id);
          }
        } catch (err) {
          console.warn(`PB Delete Error [${collectionName}]:`, err);
        }
        await store.removeItem(item.id);
        continue;
      }

      const payload = { ...item };
      delete payload.pendingSync;
      delete payload.updatedAt;

      let syncPayload;
      if (e2eeEnabled && isUnlocked()) {
        const encrypted = await encryptPayload(payload);
        syncPayload = { encrypted_payload: encrypted };
        // Clear plaintext fields
        for (const key of Object.keys(payload)) {
          if (!['id', 'collectionId', 'collectionName', 'created', 'updated', 'users', 'expand', 'encrypted_payload'].includes(key)) {
            const val = payload[key];
            if (typeof val === 'number') syncPayload[key] = 0;
            else if (typeof val === 'boolean') syncPayload[key] = false;
            else syncPayload[key] = "";
          }
        }
      } else {
        syncPayload = { ...payload, encrypted_payload: "" };
      }

      if (usersId) syncPayload.users = usersId;

      try {
        try {
          if (item.id && item.id.length === 15) {
            await pb.collection(collectionName).getOne(item.id);
            await pb.collection(collectionName).update(item.id, syncPayload);
          } else {
            throw new Error("Invalid PocketBase ID length");
          }
        } catch (e) {
          if (item.id && item.id.length === 15) {
            syncPayload.id = item.id;
          }
          const created = await pb.collection(collectionName).create(syncPayload);

          if (created.id !== item.id) {
            const oldId = item.id;
            await store.removeItem(oldId);
            item.id = created.id;

            if (collectionName === 'stock_transactions') {
              await store.iterate((value, key) => {
                // Stock tracker doesn't need to recursively update parent/child IDs like the budget app
              });
            }
          }
        }
        item.pendingSync = false;
        await store.setItem(item.id, item);
        justSynced.add(item.id);
      } catch (err) {
        console.error(`PB Push Error [${collectionName}]:`, err);
      }
    }

    // ── PHASE 3: Clean up local records deleted remotely ──
    //
    // `remoteIds` is the PHASE 1 snapshot, taken before anything was pushed.
    // Records created during PHASE 2 carry a fresh PocketBase id and are no
    // longer pendingSync, so without excluding them this step deleted the very
    // transaction that had just been saved - which is why a new transaction
    // vanished until the next refresh pulled it back down.
    const remoteIds = new Set(remoteItems.map(r => r.id));
    const staleKeys = [];
    await store.iterate((value, key) => {
      if (!key || key.length !== 15) return;
      if (value && value.pendingSync) return;
      if (justSynced.has(key)) return;
      if (remoteIds.has(key)) return;
      staleKeys.push(key);
    });
    // Removals are awaited rather than fired off inside iterate, so the store
    // is settled before callers reload from it.
    for (const key of staleKeys) {
      await store.removeItem(key);
    }
  } catch (error) {
    console.error(`Sync Error [${collectionName}]:`, error);
  }
}

// ─── Public API ───

// Sync only settings (used during startup before full sync)
export async function syncSettings() {
  if (!pb.baseUrl) {
    const connected = await connectPocketBase();
    if (!connected) return;
  }
  if (!pb.authStore.isValid) return;

  await syncSettingsStore();
}

// Full sync of all stores
export async function syncAll() {
  if (!pb.baseUrl) {
    const connected = await connectPocketBase();
    if (!connected) return;
  }
  if (!pb.authStore.isValid) return;

  // Settings first, then data stores in parallel
  await syncSettingsStore();
  await Promise.all([
    syncDataStore(db.transactionsStore, 'stock_transactions'),
    syncDataStore(db.portfoliosStore, 'stock_portfolios'),
    syncDataStore(db.insightsStore, 'stock_insights'),
    syncDataStore(db.researchStore, 'stock_research')
  ]);
}

// Subscribe to real-time events
export function setupRealtimeSync(onUpdate) {
  const collections = ['stock_transactions', 'stock_portfolios', 'stock_settings', 'stock_insights', 'stock_research'];
  const stores = {
    stock_transactions: db.transactionsStore,
    stock_portfolios: db.portfoliosStore,
    stock_settings: db.settingsStore,
    stock_insights: db.insightsStore,
    stock_research: db.researchStore
  };

  collections.forEach(coll => {
    pb.collection(coll).subscribe('*', async function (e) {
      const store = stores[coll];
      
      const currentUserId = getCurrentUserId();
      if (currentUserId && e.record.users && e.record.users !== currentUserId) {
        return; // Ignore records that belong to another user
      }

      const e2eeEnabled = await getE2eeState();

      if (e.action === 'delete') {
        if (coll === 'stock_settings') {
          // Don't delete local settings on remote delete events
          return;
        }
        await store.removeItem(e.record.id);
      } else {
        let finalRecord = e.record;

        if (e.record.encrypted_payload) {
          if (!e2eeEnabled || !isUnlocked()) return;
          try {
            const decrypted = await decryptPayload(e.record.encrypted_payload);
            decrypted.id = e.record.id;
            finalRecord = decrypted;
          } catch (err) {
            console.error("Failed to decrypt realtime item", err);
            return;
          }
        }

        if (coll === 'stock_settings') {
          // Map remote settings to local fixed key
          setSettingsPbId(e.record.id);
          const localKey = 'stocksettings123';
          const localItem = await store.getItem(localKey);
          const merged = { ...localItem, ...finalRecord, id: localKey, pendingSync: false, updatedAt: e.record.updated };
          await store.setItem(localKey, merged);
        } else {
          const localItem = await store.getItem(e.record.id);
          const merged = { ...localItem, ...finalRecord, pendingSync: false, updatedAt: e.record.updated };
          await store.setItem(merged.id, merged);
        }
      }
      if (onUpdate) onUpdate(coll);
    }).catch(err => console.warn(`Subscribe error ${coll}:`, err));
  });

  return () => {
    collections.forEach(coll => pb.collection(coll).unsubscribe('*'));
  };
}
