import type { Session } from '../types';

const DATABASE = 'axiom-conversation-cache-v1';
const STORE = 'snapshots';
const CACHE_KEY = 'sessions';
export const LEGACY_SESSION_CACHE_KEY = 'axiom-agent-sessions-v1';

const openCache = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  const request = indexedDB.open(DATABASE, 1);
  let settled = false;
  const fail = (error: unknown) => { settled = true; clearTimeout(timeout); reject(error); };
  const timeout = setTimeout(() => fail(new Error('Conversation cache timed out.')), 3000);
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
  };
  request.onsuccess = () => {
    clearTimeout(timeout);
    if (settled) { request.result.close(); return; }
    settled = true;
    resolve(request.result);
  };
  request.onerror = () => fail(request.error);
  request.onblocked = () => fail(new Error('Conversation cache is blocked.'));
});

export async function readBrowserSessions(): Promise<Session[]> {
  const database = await openCache();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readonly');
      const request = transaction.objectStore(STORE).get(CACHE_KEY);
      request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
      request.onerror = () => reject(request.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

export async function writeBrowserSessions(sessions: Session[]): Promise<void> {
  const database = await openCache();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readwrite');
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
      // IndexedDB keeps attachment bytes without JSON/Base64 writes into the
      // small, synchronous localStorage quota on every streamed delta.
      transaction.objectStore(STORE).put(sessions, CACHE_KEY);
    });
    try { window.localStorage.removeItem(LEGACY_SESSION_CACHE_KEY); } catch { /* Optional legacy cache. */ }
  } finally {
    database.close();
  }
}

export function createSessionCacheWriter(write: (sessions: Session[]) => Promise<void>, intervalMs = 1000) {
  let pending: Session[] | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<boolean> | null = null;
  let disposed = false;
  let drainRequested = false;
  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const scheduleTick = () => {
    if (!disposed && timer === null && !inFlight && pending) timer = setTimeout(() => { void commit(false); }, intervalMs);
  };
  const commit = (drain: boolean): Promise<boolean> => {
    clearTimer();
    drainRequested ||= drain;
    if (inFlight) return inFlight;
    let failed = false;
    inFlight = (async () => {
      while (pending) {
        const snapshot = pending;
        pending = null;
        try { await write(snapshot); }
        catch {
          // Keep the newest queued snapshot for the next explicit write. A full
          // cache must not fail the conversation or spin an endless retry loop.
          pending ??= snapshot;
          failed = true;
          return false;
        }
        if (!drainRequested) break;
      }
      return true;
    })().finally(() => {
      inFlight = null;
      drainRequested = false;
      if (!failed) scheduleTick();
    });
    return inFlight;
  };
  return {
    schedule(sessions: Session[]) {
      if (disposed) return;
      pending = sessions;
      scheduleTick();
    },
    flush: () => commit(true),
    dispose() { disposed = true; clearTimer(); },
  };
}

export function safelyStorePreference(storage: Pick<Storage, 'setItem'> | (() => Pick<Storage, 'setItem'>), key: string, value: string): boolean {
  try {
    (typeof storage === 'function' ? storage() : storage).setItem(key, value);
    return true;
  } catch { return false; }
}
