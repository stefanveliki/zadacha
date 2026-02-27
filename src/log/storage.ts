import type { EventEnvelope } from '../shared/types.js';

const STORE_NAME = 'events';
const DB_VERSION = 1;

export interface StorageHandle {
  /** Persist an event. No-op if id already exists. */
  put(envelope: EventEnvelope): Promise<void>;
  /** Load all persisted events ordered by created_at ascending. */
  getAll(): Promise<EventEnvelope[]>;
  /** Close the underlying database connection. */
  close(): void;
}

function openDB(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('created_at', 'created_at', { unique: false });
        store.createIndex('kind', 'kind', { unique: false });
        store.createIndex('pubkey', 'pubkey', { unique: false });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function openStorage(dbName: string): Promise<StorageHandle> {
  const db = await openDB(dbName);

  return {
    put(envelope: EventEnvelope): Promise<void> {
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        // put is idempotent on keyPath — overwrites with same data
        store.put({
          id: envelope.id,
          kind: envelope.kind,
          pubkey: envelope.pubkey,
          created_at: envelope.created_at,
          content: envelope.content,
          sig: envelope.sig,
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },

    getAll(): Promise<EventEnvelope[]> {
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const index = tx.objectStore(STORE_NAME).index('created_at');
        const req = index.getAll();
        req.onsuccess = () => resolve(req.result as EventEnvelope[]);
        req.onerror = () => reject(req.error);
      });
    },

    close() {
      db.close();
    },
  };
}
