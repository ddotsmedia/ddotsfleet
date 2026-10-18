// Offline outbox: queued writes persist in IndexedDB until the server accepts them.
// Each item's id doubles as the request's clientRef, so a replay after a lost response is a no-op on the server.

export type OutboxStatus = "pending" | "failed";

export interface OutboxItem {
  id: string;
  tenantId: string;
  label: string;
  path: string;
  body: Record<string, unknown> & { clientRef: string };
  status: OutboxStatus;
  attempts: number;
  lastError: string | null;
  createdAt: string;
}

const DB_NAME = "fleetos-outbox";
const STORE = "items";
let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        dbPromise = null;
        reject(req.error);
      };
    });
  }
  return dbPromise;
}

async function run<T>(
  mode: IDBTransactionMode,
  op: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const conn = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = conn.transaction(STORE, mode);
    const req = op(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function putItem(item: OutboxItem): Promise<void> {
  await run("readwrite", (store) => store.put(item));
}

export async function listItems(): Promise<OutboxItem[]> {
  const items = await run<OutboxItem[]>("readonly", (store) => store.getAll());
  return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function patchItem(id: string, patch: Partial<OutboxItem>): Promise<void> {
  const current = await run<OutboxItem | undefined>("readonly", (store) => store.get(id));
  if (current) await putItem({ ...current, ...patch });
}

export async function removeItem(id: string): Promise<void> {
  await run("readwrite", (store) => store.delete(id));
}
