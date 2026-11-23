import "server-only";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_OFFLINE_IMAGE_SETTINGS,
  DEFAULT_OFFLINE_SETTINGS,
  DEFAULT_OFFLINE_VIDEO_SETTINGS,
  offlineImageSettingsSchema,
  offlineSettingsFileSchema,
  offlineSettingsPatchSchema,
  offlineSettingsSchema,
  offlineVideoSettingsSchema,
} from "@/lib/offline";
import type {
  OfflineImageSettings,
  OfflineSettings,
  OfflineSettingsPatch,
  OfflineVideoSettings,
} from "@/lib/offline";
import { isReserved, isValidFolderName } from "@/server/paths";
import { gatherHome, writeAtomic } from "@/server/store";

function offlineFile(): string {
  return join(gatherHome(), "offline.json");
}

function normalizeAccounts(accounts: OfflineSettings["accounts"]): OfflineSettings["accounts"] {
  if (accounts === "all") return "all";
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const raw of accounts) {
    const folder = raw.trim();
    if (!isValidFolderName(folder) || isReserved(folder)) continue;
    const key = folder.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(folder);
  }
  return kept;
}

function salvageObject<T extends Record<string, unknown>>(
  raw: unknown,
  shape: Record<string, { safeParse: (v: unknown) => { success: boolean; data?: unknown } }>,
): Partial<T> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  const valid: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(shape)) {
    if (record[key] === undefined) continue;
    const result = schema.safeParse(record[key]);
    if (result.success) valid[key] = result.data;
  }
  return valid as Partial<T>;
}

function salvageOfflineSettings(json: unknown): Partial<OfflineSettings> {
  if (typeof json !== "object" || json === null || Array.isArray(json)) return {};
  const record = json as Record<string, unknown>;
  const valid: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(offlineSettingsSchema.shape)) {
    if (key === "image") {
      const salvaged = salvageObject<OfflineImageSettings>(record.image, offlineImageSettingsSchema.shape);
      if (Object.keys(salvaged).length > 0) valid.image = salvaged;
      continue;
    }
    if (key === "video") {
      const salvaged = salvageObject<OfflineVideoSettings>(record.video, offlineVideoSettingsSchema.shape);
      if (Object.keys(salvaged).length > 0) valid.video = salvaged;
      continue;
    }
    if (record[key] === undefined) continue;
    const result = schema.safeParse(record[key]);
    if (result.success) valid[key] = result.data;
  }
  return offlineSettingsFileSchema.parse(valid) as Partial<OfflineSettings>;
}

function mergeSettings(
  base: OfflineSettings,
  patch: Partial<{
    enabled: boolean;
    accounts: OfflineSettings["accounts"];
    includeImages: boolean;
    includeVideos: boolean;
    selection: OfflineSettings["selection"];
    newestCount: number;
    image: Partial<OfflineImageSettings>;
    video: Partial<OfflineVideoSettings>;
    phoneBudgetMB: number;
    pcCacheMB: number;
    onlyWhenPluggedIn: boolean;
    prepareInBackground: boolean;
  }>,
): OfflineSettings {
  return {
    version: 1,
    enabled: patch.enabled ?? base.enabled,
    accounts: patch.accounts !== undefined ? normalizeAccounts(patch.accounts) : base.accounts,
    includeImages: patch.includeImages ?? base.includeImages,
    includeVideos: patch.includeVideos ?? base.includeVideos,
    selection: patch.selection ?? base.selection,
    newestCount: patch.newestCount ?? base.newestCount,
    image: {
      ...base.image,
      ...(patch.image ?? {}),
    },
    video: {
      ...base.video,
      ...(patch.video ?? {}),
    },
    phoneBudgetMB: patch.phoneBudgetMB ?? base.phoneBudgetMB,
    pcCacheMB: patch.pcCacheMB ?? base.pcCacheMB,
    onlyWhenPluggedIn: patch.onlyWhenPluggedIn ?? base.onlyWhenPluggedIn,
    prepareInBackground: patch.prepareInBackground ?? base.prepareInBackground,
  };
}

export async function getOfflineSettings(): Promise<OfflineSettings> {
  const defaults: OfflineSettings = {
    ...DEFAULT_OFFLINE_SETTINGS,
    image: { ...DEFAULT_OFFLINE_IMAGE_SETTINGS },
    video: { ...DEFAULT_OFFLINE_VIDEO_SETTINGS },
  };
  let raw: string;
  try {
    raw = await readFile(offlineFile(), "utf8");
  } catch {
    return defaults;
  }
  try {
    const json: unknown = JSON.parse(raw);
    const parsed = offlineSettingsFileSchema.safeParse(json);
    const saved = parsed.success ? parsed.data : salvageOfflineSettings(json);
    return mergeSettings(defaults, saved);
  } catch {
    return defaults;
  }
}

export async function saveOfflineSettings(patch: OfflineSettingsPatch): Promise<OfflineSettings> {
  const parsed = offlineSettingsPatchSchema.safeParse(patch);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "That offline setting isn't valid.");
  }
  const current = await getOfflineSettings();
  const next = mergeSettings(current, parsed.data);
  await mkdir(gatherHome(), { recursive: true });
  await writeAtomic(offlineFile(), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}
