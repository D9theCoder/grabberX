import { describe, expect, it } from "vitest";
import type { OfflineIndexFile, OfflineIndexResponse } from "@/lib/offline";
import { OfflineDb, reconcileOfflineFiles } from "@/lib/offline-db";

/** Minimal in-memory IDBFactory shim to test the native IndexedDB wrapper in Node. */
function createFakeIdbFactory(): IDBFactory {
  const databases = new Map<string, Map<string, { keyPath: string; rows: Map<string, unknown>; indexes: Map<string, string | string[]> }>>();

  function fireSuccess<T>(req: Record<string, unknown>, result: T): void {
    req.result = result;
    queueMicrotask(() => {
      (req.onsuccess as ((ev: Event) => void) | null)?.({ target: req } as unknown as Event);
    });
  }

  function keyOf(record: Record<string, unknown>, keyPath: string | string[]): string {
    if (Array.isArray(keyPath)) return JSON.stringify(keyPath.map((k) => record[k]));
    return String(record[keyPath]);
  }

  return {
    open(name: string) {
      const req: Record<string, unknown> = {
        result: null,
        error: null,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
      };
      const isNew = !databases.has(name);
      const stores = databases.get(name) ?? new Map();
      databases.set(name, stores);

      const db = {
        objectStoreNames: {
          contains: (storeName: string) => stores.has(storeName),
        },
        createObjectStore(storeName: string, opts: { keyPath: string }) {
          const def = { keyPath: opts.keyPath, rows: new Map<string, unknown>(), indexes: new Map<string, string | string[]>() };
          stores.set(storeName, def);
          return {
            createIndex(indexName: string, kp: string | string[]) {
              def.indexes.set(indexName, kp);
            },
          };
        },
        transaction(storeNames: string | string[]) {
          const names = Array.isArray(storeNames) ? storeNames : [storeNames];
          const tx: Record<string, unknown> = {
            oncomplete: null,
            onerror: null,
            onabort: null,
            objectStore(storeName: string) {
              if (!names.includes(storeName)) throw new Error(`Store ${storeName} not in tx`);
              const def = stores.get(storeName)!;
              return {
                get(key: string) {
                  const r: Record<string, unknown> = {};
                  fireSuccess(r, def.rows.get(String(key)));
                  return r;
                },
                getAll() {
                  const r: Record<string, unknown> = {};
                  fireSuccess(r, [...def.rows.values()]);
                  return r;
                },
                put(value: Record<string, unknown>) {
                  def.rows.set(keyOf(value, def.keyPath), structuredClone(value));
                },
                delete(key: string) {
                  def.rows.delete(String(key));
                },
                clear() {
                  def.rows.clear();
                },
                index(indexName: string) {
                  const kp = def.indexes.get(indexName)!;
                  return {
                    getAll(query: unknown) {
                      const expected = Array.isArray(kp) ? JSON.stringify(query) : String(query);
                      const matches = [...def.rows.values()].filter(
                        (row) => keyOf(row as Record<string, unknown>, kp) === expected,
                      );
                      const r: Record<string, unknown> = {};
                      fireSuccess(r, matches);
                      return r;
                    },
                  };
                },
              };
            },
          };
          queueMicrotask(() => {
            queueMicrotask(() => {
              (tx.oncomplete as (() => void) | null)?.();
            });
          });
          return tx;
        },
        close() {},
      };

      queueMicrotask(() => {
        req.result = db;
        if (isNew) {
          (req.onupgradeneeded as (() => void) | null)?.();
        }
        (req.onsuccess as (() => void) | null)?.();
      });
      return req as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;
}

const sampleFile = (overrides: Partial<OfflineIndexFile> = {}): OfflineIndexFile => ({
  id: "alice/Image/1_1.jpg",
  account: "alice",
  folder: "Image",
  filename: "1_1.jpg",
  kind: "image",
  size: 1000,
  mtime: 1000,
  v: "3e8-3e8",
  ...overrides,
});

describe("reconcileOfflineFiles", () => {
  it("replaces everything on a full sync and applies add/update/remove on incremental sync", () => {
    const f1 = sampleFile();
    const f2 = sampleFile({ id: "alice/Image/2_1.jpg", filename: "2_1.jpg" });
    const full = reconcileOfflineFiles([f1], { incremental: false, files: [f2] });
    expect(full.map((f) => f.id)).toEqual(["alice/Image/2_1.jpg"]);

    const f2Updated = sampleFile({ id: "alice/Image/2_1.jpg", filename: "2_1.jpg", size: 2000, v: "7d0-3e8" });
    const f3 = sampleFile({ id: "bob/Video/3_1.mp4", account: "bob", folder: "Video", filename: "3_1.mp4", kind: "video" });
    const inc = reconcileOfflineFiles([f1, f2], {
      incremental: true,
      files: [f2Updated, f3],
      removed: ["alice/Image/1_1.jpg"],
    });
    expect(inc).toEqual([f2Updated, f3]);
  });
});

describe("OfflineDb", () => {
  it("stores full syncs, queries by account and folder, applies incremental deltas, and clears cleanly", async () => {
    const db = new OfflineDb(createFakeIdbFactory(), "test-offline-db");
    expect(await db.getMeta()).toBeNull();

    const fullResponse: OfflineIndexResponse = {
      ok: true,
      enabled: true,
      version: "v1",
      generatedAt: "2026-11-23T00:00:00.000Z",
      incremental: false,
      accounts: [
        { folder: "bob", layout: "byType", imageCount: 0, videoCount: 1, totalBytes: 500 },
        { folder: "alice", layout: "byType", imageCount: 2, videoCount: 0, totalBytes: 2000 },
      ],
      files: [
        sampleFile({ id: "alice/Image/1_1.jpg", filename: "1_1.jpg" }),
        sampleFile({ id: "alice/Image/2025/2_1.jpg", folder: "Image/2025", filename: "2_1.jpg" }),
        sampleFile({ id: "bob/Video/3_1.mp4", account: "bob", folder: "Video", filename: "3_1.mp4", kind: "video" }),
      ],
      totalFiles: 3,
      phoneBudgetBytes: 2000 * 1024 * 1024,
      imagePreset: "img-webp-2048-512k-q80",
    };

    const meta1 = await db.applySyncResponse(fullResponse, 1700000000000, 2);
    expect(meta1).toMatchObject({
      indexVersion: "v1",
      totalFiles: 3,
      thumbCount: 2,
      enabled: true,
      phoneBudgetBytes: 2000 * 1024 * 1024,
      imagePreset: "img-webp-2048-512k-q80",
    });

    const accounts = await db.listAccounts();
    expect(accounts.map((a) => a.folder)).toEqual(["alice", "bob"]);
    expect((await db.listFiles("alice")).map((f) => f.id)).toEqual([
      "alice/Image/1_1.jpg",
      "alice/Image/2025/2_1.jpg",
    ]);
    expect((await db.listFiles("alice", "Image/2025")).map((f) => f.id)).toEqual(["alice/Image/2025/2_1.jpg"]);

    // Incremental update removes 1_1.jpg and adds 4_1.jpg.
    await db.applySyncResponse(
      {
        ok: true,
        enabled: true,
        version: "v2",
        generatedAt: "2026-11-23T00:05:00.000Z",
        incremental: true,
        accounts: fullResponse.accounts,
        files: [sampleFile({ id: "alice/Image/4_1.jpg", filename: "4_1.jpg" })],
        removed: ["alice/Image/1_1.jpg"],
        totalFiles: 3,
        phoneBudgetBytes: 2000 * 1024 * 1024,
      },
      1700000300000,
      3,
    );

    expect((await db.getMeta())?.indexVersion).toBe("v2");
    expect((await db.listFiles("alice")).map((f) => f.id).sort()).toEqual([
      "alice/Image/2025/2_1.jpg",
      "alice/Image/4_1.jpg",
    ]);

    await db.clear();
    expect(await db.getMeta()).toBeNull();
    expect(await db.listAccounts()).toEqual([]);
    expect(await db.listFiles()).toEqual([]);
  });
});
