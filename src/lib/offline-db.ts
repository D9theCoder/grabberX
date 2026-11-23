import {
  OFFLINE_DB_NAME,
  OFFLINE_DB_VERSION,
  OFFLINE_FILES_CACHE,
  OFFLINE_THUMBS_CACHE,
} from "@/lib/offline";
import type {
  OfflineIndexAccount,
  OfflineIndexFile,
  OfflineIndexResponse,
} from "@/lib/offline";

export const LAST_AUTOSYNC_KEY = "gather-m-last-autosync";

export interface OfflineSyncMeta {
  key: "sync";
  indexVersion: string;
  lastSyncedAt: number;
  totalFiles: number;
  thumbCount: number;
  enabled: boolean;
  phoneBudgetBytes?: number;
  imagePreset?: string;
  videoPreset?: string;
  fileTotal?: number;
  fileCount?: number;
  fileBytes?: number;
  filePending?: number;
}

function requestPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed."));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted."));
  });
}

/** Pure reconciliation of an offline file list against a full or incremental server index response. */
export function reconcileOfflineFiles(
  existing: readonly OfflineIndexFile[],
  response: Pick<OfflineIndexResponse, "incremental" | "files" | "removed">,
): OfflineIndexFile[] {
  if (!response.incremental) {
    return [...response.files];
  }
  const map = new Map<string, OfflineIndexFile>();
  for (const file of existing) map.set(file.id, file);
  for (const id of response.removed ?? []) map.delete(id);
  for (const file of response.files) map.set(file.id, file);
  return [...map.values()];
}

export class OfflineDb {
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(
    private readonly factory?: IDBFactory,
    private readonly dbName: string = OFFLINE_DB_NAME,
  ) {}

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    const idb = this.factory ?? (typeof globalThis !== "undefined" ? globalThis.indexedDB : undefined);
    if (!idb) {
      return Promise.reject(new Error("IndexedDB is not available in this browser."));
    }
    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = idb.open(this.dbName, OFFLINE_DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("meta")) {
          db.createObjectStore("meta", { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains("accounts")) {
          db.createObjectStore("accounts", { keyPath: "folder" });
        }
        if (!db.objectStoreNames.contains("files")) {
          const filesStore = db.createObjectStore("files", { keyPath: "id" });
          filesStore.createIndex("by_account", "account", { unique: false });
          filesStore.createIndex("by_account_folder", ["account", "folder"], { unique: false });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          db.close();
          this.dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => {
        this.dbPromise = null;
        reject(req.error ?? new Error("Could not open offline database."));
      };
    });
    return this.dbPromise;
  }

  async getMeta(): Promise<OfflineSyncMeta | null> {
    const db = await this.open();
    const tx = db.transaction("meta", "readonly");
    const record = await requestPromise(tx.objectStore("meta").get("sync") as IDBRequest<OfflineSyncMeta | undefined>);
    return record ?? null;
  }

  async setMeta(meta: OfflineSyncMeta): Promise<void> {
    const db = await this.open();
    const tx = db.transaction("meta", "readwrite");
    tx.objectStore("meta").put(meta);
    await transactionDone(tx);
  }

  async listAccounts(): Promise<OfflineIndexAccount[]> {
    const db = await this.open();
    const tx = db.transaction("accounts", "readonly");
    const rows = await requestPromise(tx.objectStore("accounts").getAll() as IDBRequest<OfflineIndexAccount[]>);
    rows.sort((a, b) => (a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0));
    return rows;
  }

  async listFiles(account?: string, folder?: string): Promise<OfflineIndexFile[]> {
    const db = await this.open();
    const tx = db.transaction("files", "readonly");
    const store = tx.objectStore("files");
    if (account !== undefined && folder !== undefined) {
      const index = store.index("by_account_folder");
      return requestPromise(index.getAll([account, folder]) as IDBRequest<OfflineIndexFile[]>);
    }
    if (account !== undefined) {
      const index = store.index("by_account");
      return requestPromise(index.getAll(account) as IDBRequest<OfflineIndexFile[]>);
    }
    return requestPromise(store.getAll() as IDBRequest<OfflineIndexFile[]>);
  }

  async applySyncResponse(
    response: OfflineIndexResponse,
    syncedAt: number,
    thumbCount?: number,
  ): Promise<OfflineSyncMeta> {
    const db = await this.open();
    const previous = await this.getMeta().catch(() => null);
    const tx = db.transaction(["meta", "accounts", "files"], "readwrite");
    const accountsStore = tx.objectStore("accounts");
    const filesStore = tx.objectStore("files");
    const metaStore = tx.objectStore("meta");

    accountsStore.clear();
    for (const account of response.accounts) {
      accountsStore.put(account);
    }

    if (!response.incremental) {
      filesStore.clear();
      for (const file of response.files) {
        filesStore.put(file);
      }
    } else {
      for (const id of response.removed ?? []) {
        filesStore.delete(id);
      }
      for (const file of response.files) {
        filesStore.put(file);
      }
    }

    const meta: OfflineSyncMeta = {
      key: "sync",
      indexVersion: response.version,
      lastSyncedAt: syncedAt,
      totalFiles: response.totalFiles,
      thumbCount: thumbCount ?? previous?.thumbCount ?? 0,
      enabled: response.enabled,
      phoneBudgetBytes: response.phoneBudgetBytes,
      ...(response.imagePreset ? { imagePreset: response.imagePreset } : {}),
      ...(response.videoPreset ? { videoPreset: response.videoPreset } : {}),
      fileTotal: previous?.fileTotal ?? 0,
      fileCount: previous?.fileCount ?? 0,
      fileBytes: previous?.fileBytes ?? 0,
      filePending: previous?.filePending ?? 0,
    };
    metaStore.put(meta);
    await transactionDone(tx);
    return meta;
  }

  async clear(): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(["meta", "accounts", "files"], "readwrite");
    tx.objectStore("meta").clear();
    tx.objectStore("accounts").clear();
    tx.objectStore("files").clear();
    await transactionDone(tx);
  }

  async close(): Promise<void> {
    if (!this.dbPromise) return;
    const db = await this.dbPromise.catch(() => null);
    db?.close();
    this.dbPromise = null;
  }
}

let sharedDb: OfflineDb | null = null;

export function getOfflineDb(): OfflineDb {
  sharedDb ??= new OfflineDb();
  return sharedDb;
}

/** Clears IndexedDB and both offline media caches (thumbnails + step-2 full files). */
export async function wipeOfflineStorage(db: OfflineDb = getOfflineDb()): Promise<void> {
  await db.clear().catch(() => {});
  if (typeof caches !== "undefined") {
    await Promise.all([
      caches.delete(OFFLINE_THUMBS_CACHE).catch(() => false),
      caches.delete(OFFLINE_FILES_CACHE).catch(() => false),
    ]);
  }
  try {
    window.localStorage.removeItem(LAST_AUTOSYNC_KEY);
  } catch {
    // ignore
  }
}

/** Called when the PC revokes this phone (401) or when the user forgets this phone. */
export async function wipeAllOnRevoke(db: OfflineDb = getOfflineDb()): Promise<void> {
  await wipeOfflineStorage(db);
  if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
    navigator.serviceWorker.controller?.postMessage({ type: "CLEAR_CACHE" });
  }
}
