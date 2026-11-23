import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_OFFLINE_IMAGE_SETTINGS,
  DEFAULT_OFFLINE_SETTINGS,
  DEFAULT_OFFLINE_VIDEO_SETTINGS,
  estimateDerivativeBytes,
  imagePresetId,
  isAccountIncluded,
  isKindIncluded,
  offlineFileId,
  offlineFileUrl,
  offlineSettingsPatchSchema,
  offlineSettingsSchema,
  offlineThumbUrl,
  selectLayer3FilesWithinBudget,
  videoPresetId,
} from "@/lib/offline";
import type { OfflineIndexFile } from "@/lib/offline";
import { getOfflineSettings, saveOfflineSettings } from "@/server/offline/settings";

let sandbox = "";

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "gather-offline-settings-"));
});

beforeEach(async () => {
  process.env.GATHER_HOME = await mkdtemp(join(sandbox, "home-"));
});

afterAll(async () => {
  delete process.env.GATHER_HOME;
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
});

describe("offline settings schema & helpers", () => {
  it("provides safe defaults (disabled by default)", () => {
    const parsed = offlineSettingsSchema.parse({});
    expect(parsed).toEqual(DEFAULT_OFFLINE_SETTINGS);
    expect(parsed.enabled).toBe(false);
    expect(parsed.accounts).toBe("all");
    expect(parsed.includeImages).toBe(true);
    expect(parsed.includeVideos).toBe(true);
    expect(parsed.selection).toBe("all");
    expect(parsed.newestCount).toBe(200);
    expect(parsed.image).toEqual(DEFAULT_OFFLINE_IMAGE_SETTINGS);
    expect(parsed.video).toEqual(DEFAULT_OFFLINE_VIDEO_SETTINGS);
    expect(parsed.phoneBudgetMB).toBe(2000);
    expect(parsed.pcCacheMB).toBe(10000);
    expect(parsed.onlyWhenPluggedIn).toBe(true);
    expect(parsed.prepareInBackground).toBe(false);
  });

  it("rejects unknown or out-of-range fields in strict patch schema", () => {
    expect(offlineSettingsPatchSchema.safeParse({ enabled: true }).success).toBe(true);
    expect(offlineSettingsPatchSchema.safeParse({ image: { maxKB: 256, format: "jpeg" } }).success).toBe(true);
    expect(offlineSettingsPatchSchema.safeParse({ video: { enabled: true, maxHeight: 480, audio: "drop" } }).success).toBe(true);

    expect(offlineSettingsPatchSchema.safeParse({ enabled: true, extra: 1 }).success).toBe(false);
    expect(offlineSettingsPatchSchema.safeParse({ image: { bogus: 1 } }).success).toBe(false);
    expect(offlineSettingsPatchSchema.safeParse({ image: { maxKB: 64 } }).success).toBe(false);
    expect(offlineSettingsPatchSchema.safeParse({ image: { maxEdge: 999 } }).success).toBe(false);
    expect(offlineSettingsPatchSchema.safeParse({ video: { maxHeight: 1440 } }).success).toBe(false);
    expect(offlineSettingsPatchSchema.safeParse({ video: { bitrateKbps: 100 } }).success).toBe(false);
    expect(offlineSettingsPatchSchema.safeParse({ phoneBudgetMB: 100 }).success).toBe(false);
    expect(offlineSettingsPatchSchema.safeParse({ accounts: "none" }).success).toBe(false);
    expect(offlineSettingsPatchSchema.safeParse({ accounts: [""] }).success).toBe(false);
  });

  it("filters accounts (case-insensitive) and media kinds", () => {
    expect(isAccountIncluded({ accounts: "all" }, "alice")).toBe(true);
    expect(isAccountIncluded({ accounts: ["Alice", "bob"] }, "alice")).toBe(true);
    expect(isAccountIncluded({ accounts: ["Alice"] }, "charlie")).toBe(false);

    expect(isKindIncluded({ includeImages: true, includeVideos: false }, "image")).toBe(true);
    expect(isKindIncluded({ includeImages: true, includeVideos: false }, "video")).toBe(false);
    expect(isKindIncluded({ includeImages: false, includeVideos: true }, "image")).toBe(false);
    expect(isKindIncluded({ includeImages: false, includeVideos: true }, "video")).toBe(true);
  });

  it("changes preset IDs whenever quality settings change", () => {
    const baseImg = imagePresetId(DEFAULT_OFFLINE_IMAGE_SETTINGS);
    expect(imagePresetId({ ...DEFAULT_OFFLINE_IMAGE_SETTINGS, maxKB: 256 })).not.toBe(baseImg);
    expect(imagePresetId({ ...DEFAULT_OFFLINE_IMAGE_SETTINGS, format: "jpeg" })).not.toBe(baseImg);
    expect(imagePresetId({ ...DEFAULT_OFFLINE_IMAGE_SETTINGS, maxEdge: "original" })).not.toBe(baseImg);

    const baseVid = videoPresetId(DEFAULT_OFFLINE_VIDEO_SETTINGS);
    expect(videoPresetId({ ...DEFAULT_OFFLINE_VIDEO_SETTINGS, maxHeight: 480 })).not.toBe(baseVid);
    expect(videoPresetId({ ...DEFAULT_OFFLINE_VIDEO_SETTINGS, audio: "drop" })).not.toBe(baseVid);
    expect(videoPresetId({ ...DEFAULT_OFFLINE_VIDEO_SETTINGS, bitrateKbps: 2000 })).not.toBe(baseVid);
  });

  it("selects Layer 3 files newest-first within phoneBudgetBytes", () => {
    const mk = (num: number, bytes: number): OfflineIndexFile => ({
      id: `acct/Image/${num}_1.jpg`,
      account: "acct",
      folder: "Image",
      filename: `${num}_1.jpg`,
      kind: "image",
      size: bytes * 2,
      mtime: num * 1000,
      v: `1-${num}`,
      offline: { bytes, ready: true, preset: "p1" },
    });
    const files = [mk(10, 400), mk(30, 400), mk(20, 400)];
    const selected = selectLayer3FilesWithinBudget(files, 850);
    expect(selected.map((f) => f.filename)).toEqual(["30_1.jpg", "20_1.jpg"]);
  });

  it("estimates derivative bytes sensibly for images and videos", () => {
    const imgEst = estimateDerivativeBytes(
      { kind: "image", size: 4_000_000, width: 4000, height: 3000 },
      DEFAULT_OFFLINE_SETTINGS,
    );
    expect(imgEst).toBeGreaterThan(0);
    expect(imgEst).toBeLessThanOrEqual(DEFAULT_OFFLINE_SETTINGS.image.maxKB * 1024);

    const vidEst = estimateDerivativeBytes(
      { kind: "video", size: 50_000_000, duration: 10 },
      DEFAULT_OFFLINE_SETTINGS,
    );
    expect(vidEst).toBeGreaterThan(1_000_000);
    expect(vidEst).toBeLessThan(3_000_000);
  });

  it("builds deterministic file IDs and cache URLs for layer 2 and layer 3", () => {
    expect(offlineFileId("alice", "Image/2025", "100_1.jpg")).toBe("alice/Image/2025/100_1.jpg");
    expect(offlineFileId("alice", "", "100_1.jpg")).toBe("alice/100_1.jpg");
    expect(offlineThumbUrl("alice", "Image/2025", "100_1.jpg", "a-b")).toBe(
      "/m/api/offline/thumb?account=alice&path=Image%2F2025%2F100_1.jpg&v=a-b",
    );
    expect(offlineFileUrl("alice", "Video", "200_1.mp4", "c-d")).toBe(
      "/m/api/offline/file?account=alice&path=Video%2F200_1.mp4&v=c-d",
    );
  });
});

describe("offline settings persistence (.gather/offline.json)", () => {
  it("returns defaults when file does not exist and persists nested patches atomically", async () => {
    expect(await getOfflineSettings()).toEqual(DEFAULT_OFFLINE_SETTINGS);

    const updated = await saveOfflineSettings({
      enabled: true,
      accounts: ["alice", "ALICE", "src", "../bad", "bob"],
      includeVideos: false,
      selection: "newest",
      newestCount: 50,
      image: { maxEdge: 1280, maxKB: 256, format: "jpeg" },
      video: { enabled: true, maxHeight: 480, audio: "drop" },
      phoneBudgetMB: 1500,
      prepareInBackground: true,
    });
    expect(updated).toEqual({
      ...DEFAULT_OFFLINE_SETTINGS,
      enabled: true,
      accounts: ["alice", "bob"],
      includeImages: true,
      includeVideos: false,
      selection: "newest",
      newestCount: 50,
      image: {
        ...DEFAULT_OFFLINE_IMAGE_SETTINGS,
        maxEdge: 1280,
        maxKB: 256,
        format: "jpeg",
      },
      video: {
        ...DEFAULT_OFFLINE_VIDEO_SETTINGS,
        enabled: true,
        maxHeight: 480,
        audio: "drop",
      },
      phoneBudgetMB: 1500,
      prepareInBackground: true,
    });
    expect(await getOfflineSettings()).toEqual(updated);
  });

  it("migrates legacy Step 1 offline.json files by filling Layer 3 defaults", async () => {
    const home = process.env.GATHER_HOME!;
    await writeFile(
      join(home, "offline.json"),
      JSON.stringify({
        version: 1,
        enabled: true,
        accounts: ["alice"],
        includeImages: true,
        includeVideos: false,
      }),
    );
    const loaded = await getOfflineSettings();
    expect(loaded).toEqual({
      ...DEFAULT_OFFLINE_SETTINGS,
      enabled: true,
      accounts: ["alice"],
      includeImages: true,
      includeVideos: false,
    });
  });

  it("salvages valid top-level and nested fields if offline.json has corrupted values", async () => {
    const home = process.env.GATHER_HOME!;
    await writeFile(
      join(home, "offline.json"),
      JSON.stringify({
        version: 1,
        enabled: true,
        accounts: 12345,
        includeImages: false,
        includeVideos: true,
        image: { maxEdge: 1280, maxKB: "bad", format: "jpeg" },
        video: { enabled: true, maxHeight: 9999, bitrateKbps: 1800 },
        phoneBudgetMB: -5,
      }),
    );
    const loaded = await getOfflineSettings();
    expect(loaded).toEqual({
      ...DEFAULT_OFFLINE_SETTINGS,
      enabled: true,
      accounts: "all",
      includeImages: false,
      includeVideos: true,
      image: {
        ...DEFAULT_OFFLINE_IMAGE_SETTINGS,
        maxEdge: 1280,
        format: "jpeg",
      },
      video: {
        ...DEFAULT_OFFLINE_VIDEO_SETTINGS,
        enabled: true,
        bitrateKbps: 1800,
      },
    });
  });
});
