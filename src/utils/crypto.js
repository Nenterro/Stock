import * as db from '../store/db';
import { pb } from '../store/sync';

// AES-GCM 256 Encryption using Web Crypto API

// We use a constant salt so the same 4-digit PIN derives the same key across different devices.
const SALT = new TextEncoder().encode("BUDGET_APP_E2EE_SALT_V1");

let cryptoKey = null; // Stored in memory

// Derive AES-GCM key from PIN
export async function deriveKey(pin) {
  const enc = new TextEncoder();
  const keyMaterial = await window.crypto.subtle.importKey(
    "raw",
    enc.encode(pin),
    { name: "PBKDF2" },
    false,
    ["deriveBits", "deriveKey"]
  );
  
  cryptoKey = await window.crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: SALT,
      iterations: 100000,
      hash: "SHA-256"
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
  
  localStorage.setItem('BUDGET_E2EE_PIN', pin);
  sessionStorage.setItem('BUDGET_E2EE_PIN', pin);
}

export function isUnlocked() {
  return cryptoKey !== null;
}

// Check if a PIN is cached on this device (without deriving or verifying)
export function hasCachedPin() {
  return !!(localStorage.getItem('BUDGET_E2EE_PIN') || sessionStorage.getItem('BUDGET_E2EE_PIN'));
}

// Restore session from cached PIN — just derives the key, no verification.
// Verification happens naturally when syncAll tries to decrypt records.
export async function tryRestoreSession() {
  const pin = localStorage.getItem('BUDGET_E2EE_PIN') || sessionStorage.getItem('BUDGET_E2EE_PIN');
  if (pin && !cryptoKey) {
    await deriveKey(pin);
    return true;
  }
  return cryptoKey !== null;
}

export function lockSession() {
  cryptoKey = null;
  localStorage.removeItem('BUDGET_E2EE_PIN');
  sessionStorage.removeItem('BUDGET_E2EE_PIN');
}

export async function encryptPayload(payload) {
  if (!cryptoKey) throw new Error("Database is locked");
  
  const jsonStr = JSON.stringify(payload);
  const enc = new TextEncoder();
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  
  const cipherBuffer = await window.crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv },
    cryptoKey,
    enc.encode(jsonStr)
  );
  
  const cipherBytes = new Uint8Array(cipherBuffer);
  const combined = new Uint8Array(iv.length + cipherBytes.length);
  combined.set(iv);
  combined.set(cipherBytes, iv.length);
  
  let binary = '';
  const len = combined.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(combined[i]);
  }
  
  return btoa(binary);
}

export async function decryptPayload(encryptedStr) {
  if (!cryptoKey) throw new Error("Database is locked");
  
  try {
    const binary = atob(encryptedStr);
    const combined = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      combined[i] = binary.charCodeAt(i);
    }
    
    const iv = combined.slice(0, 12);
    const cipherBytes = combined.slice(12);
    
    const decryptedBuffer = await window.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv },
      cryptoKey,
      cipherBytes
    );
    
    const dec = new TextDecoder();
    return JSON.parse(dec.decode(decryptedBuffer));
  } catch (e) {
    console.error("Failed to decrypt payload:", e);
    throw new Error("Decryption failed. Incorrect PIN or corrupted data.");
  }
}

// Verify a PIN by attempting to decrypt real encrypted data.
// Derives the key from the given PIN, then tries to decrypt any
// encrypted record found locally or remotely.
export async function verifyPinWithData(pin) {
  await deriveKey(pin);
  
  // Try local stores first
  const stores = [
    db.settingsStore,
    db.transactionsStore,
    db.portfoliosStore
  ].filter(Boolean);
  
  for (const store of stores) {
    let testItem = null;
    await store.iterate((value) => {
      if (value && value.encrypted_payload) {
        testItem = value;
        return value; // stop iteration
      }
    });

    if (testItem && testItem.encrypted_payload) {
      try {
        await decryptPayload(testItem.encrypted_payload);
        return true;
      } catch (e) {
        lockSession();
        return false;
      }
    }
  }

  // Fallback: try remote PocketBase records
  if (pb.baseUrl && pb.authStore.isValid) {
    const collections = ['stock_settings', 'stock_transactions', 'stock_portfolios'];
    const usersId = pb.authStore.model?.id;
    for (const coll of collections) {
      try {
        const remoteItems = await pb.collection(coll).getFullList({ 
          filter: usersId ? `users = "${usersId}"` : '',
          sort: '-created'
        });
        for (const remote of remoteItems) {
          if (remote.encrypted_payload) {
            try {
              await decryptPayload(remote.encrypted_payload);
              return true;
            } catch (e) {
              lockSession();
              return false;
            }
          }
        }
      } catch (e) {
        // Skip network errors
      }
    }
  }

  // No encrypted data found anywhere — PIN is accepted (first-time setup)
  return true;
}
