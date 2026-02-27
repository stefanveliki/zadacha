/**
 * Rural Run Protocol — Key Store
 *
 * Persistent storage for private key material and recovery state.
 * Primary: IndexedDB (local-first, survives app close/reopen, available in PWA).
 * Fallback: In-memory (for Node.js test environments and environments without IndexedDB).
 *
 * The private key is stored as raw bytes. The store itself is not encrypted —
 * the biometric gate (WebAuthn) is the access barrier. A future enhancement
 * could add AES-GCM wrapping here, but biometric gating is the primary protection.
 *
 * Implements the KeyStore interface from types.ts.
 */

import type { KeyStore, RecoveryState } from './types.js';

// ---------------------------------------------------------------------------
// IndexedDB-backed KeyStore (browser / PWA)
// ---------------------------------------------------------------------------

const DB_NAME = 'rrp-identity';
const DB_VERSION = 1;
const STORE_NAME = 'keystore';

const KEY_PRIVATE = 'private_key';
const KEY_PUBLIC  = 'public_key';
const KEY_RECOVERY = 'recovery_state';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function idbGet<T>(db: IDBDatabase, key: string): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve((req.result as T) ?? null);
    req.onerror   = () => reject(req.error);
  });
}

function idbSet(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).put(value, key);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

function idbDelete(db: IDBDatabase, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).delete(key);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

export class IdbKeyStore implements KeyStore {
  private dbPromise: Promise<IDBDatabase>;

  constructor() {
    this.dbPromise = openDb();
  }

  private async db(): Promise<IDBDatabase> {
    return this.dbPromise;
  }

  async getPrivateKey(): Promise<Uint8Array | null> {
    const db = await this.db();
    const raw = await idbGet<ArrayBuffer>(db, KEY_PRIVATE);
    return raw ? new Uint8Array(raw) : null;
  }

  async setPrivateKey(key: Uint8Array): Promise<void> {
    const db = await this.db();
    // Store as ArrayBuffer — IndexedDB handles structured clone of typed arrays.
    await idbSet(db, KEY_PRIVATE, key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength));
  }

  async getPublicKey(): Promise<string | null> {
    const db = await this.db();
    return idbGet<string>(db, KEY_PUBLIC);
  }

  async setPublicKey(pubkey: string): Promise<void> {
    const db = await this.db();
    await idbSet(db, KEY_PUBLIC, pubkey);
  }

  async getRecoveryState(): Promise<RecoveryState | null> {
    const db = await this.db();
    return idbGet<RecoveryState>(db, KEY_RECOVERY);
  }

  async setRecoveryState(state: RecoveryState): Promise<void> {
    const db = await this.db();
    await idbSet(db, KEY_RECOVERY, state);
  }

  async clear(): Promise<void> {
    const db = await this.db();
    await Promise.all([
      idbDelete(db, KEY_PRIVATE),
      idbDelete(db, KEY_PUBLIC),
      idbDelete(db, KEY_RECOVERY),
    ]);
  }
}

// ---------------------------------------------------------------------------
// In-memory KeyStore (Node.js tests / environments without IndexedDB)
// ---------------------------------------------------------------------------

export class MemoryKeyStore implements KeyStore {
  private data = new Map<string, unknown>();

  async getPrivateKey(): Promise<Uint8Array | null> {
    return (this.data.get(KEY_PRIVATE) as Uint8Array | undefined) ?? null;
  }

  async setPrivateKey(key: Uint8Array): Promise<void> {
    // Copy the bytes so we don't hold a reference to a buffer the caller may overwrite.
    this.data.set(KEY_PRIVATE, new Uint8Array(key));
  }

  async getPublicKey(): Promise<string | null> {
    return (this.data.get(KEY_PUBLIC) as string | undefined) ?? null;
  }

  async setPublicKey(pubkey: string): Promise<void> {
    this.data.set(KEY_PUBLIC, pubkey);
  }

  async getRecoveryState(): Promise<RecoveryState | null> {
    return (this.data.get(KEY_RECOVERY) as RecoveryState | undefined) ?? null;
  }

  async setRecoveryState(state: RecoveryState): Promise<void> {
    this.data.set(KEY_RECOVERY, state);
  }

  async clear(): Promise<void> {
    this.data.clear();
  }
}

// ---------------------------------------------------------------------------
// Factory: returns IdbKeyStore in browser, MemoryKeyStore otherwise.
// ---------------------------------------------------------------------------

export function createKeyStore(): KeyStore {
  if (typeof indexedDB !== 'undefined') {
    return new IdbKeyStore();
  }
  return new MemoryKeyStore();
}
