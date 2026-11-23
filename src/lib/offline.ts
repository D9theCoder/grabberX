import { z } from "zod";
import type { DetectedLayout } from "@/lib/spec";
import type { MediaKind } from "@/components/gallery/types";

export const OFFLINE_SHELL_CACHE = "gather-m-shell-v2";
export const OFFLINE_THUMBS_CACHE = "gather-m-offline-thumbs-v1";
/** Cache Storage bucket for Layer 3 reduced-quality full-size / transcoded offline media copies. */
export const OFFLINE_FILES_CACHE = "gather-m-offline-files-v1";

export const OFFLINE_DB_NAME = "gather-m-offline";
export const OFFLINE_DB_VERSION = 1;

export const OFFLINE_THUMB_SIZE = 320;

export const offlineAccountListSchema = z.union([
  z.literal("all"),
  z.array(z.string().trim().min(1, "Choose an account.").max(64, "That folder name is too long.")).max(1000),
]);

export const offlineSelectionSchema = z.enum(["all", "newest"]);

export const offlineImageMaxEdgeSchema = z.union([
  z.literal(1280),
  z.literal(2048),
  z.literal(2560),
  z.literal("original"),
]);

export const offlineImageFormatSchema = z.enum(["webp", "jpeg"]);

export const offlineImageSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  maxEdge: offlineImageMaxEdgeSchema.default(2048),
  maxKB: z.number().int().min(128, "Use at least 128 KB.").max(2048, "Use 2048 KB or less.").default(512),
  format: offlineImageFormatSchema.default("webp"),
  quality: z.number().int().min(40, "Use quality 40 or higher.").max(95, "Use quality 95 or lower.").default(80),
});

export const offlineVideoMaxHeightSchema = z.union([
  z.literal(360),
  z.literal(480),
  z.literal(720),
  z.literal(1080),
]);

export const offlineVideoAudioSchema = z.enum(["keep", "drop"]);
export const offlineVideoAudioKbpsSchema = z.union([z.literal(64), z.literal(96), z.literal(128)]);
export const offlineVideoEncoderSchema = z.enum(["auto", "gpu", "cpu"]);

export const offlineVideoSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  maxHeight: offlineVideoMaxHeightSchema.default(720),
  bitrateKbps: z.number().int().min(400, "Use at least 400 kbps.").max(4000, "Use 4000 kbps or less.").default(1200),
  audio: offlineVideoAudioSchema.default("keep"),
  audioKbps: offlineVideoAudioKbpsSchema.default(96),
  encoder: offlineVideoEncoderSchema.default("auto"),
  cpuThreads: z.number().int().min(1, "Use at least 1 thread.").max(16, "Use 16 threads or fewer.").default(4),
});

export type OfflineSelection = z.infer<typeof offlineSelectionSchema>;
export type OfflineImageMaxEdge = z.infer<typeof offlineImageMaxEdgeSchema>;
export type OfflineImageFormat = z.infer<typeof offlineImageFormatSchema>;
export type OfflineImageSettings = z.infer<typeof offlineImageSettingsSchema>;
export type OfflineVideoMaxHeight = z.infer<typeof offlineVideoMaxHeightSchema>;
export type OfflineVideoAudio = z.infer<typeof offlineVideoAudioSchema>;
export type OfflineVideoAudioKbps = z.infer<typeof offlineVideoAudioKbpsSchema>;
export type OfflineVideoEncoder = z.infer<typeof offlineVideoEncoderSchema>;
export type OfflineVideoSettings = z.infer<typeof offlineVideoSettingsSchema>;

export const DEFAULT_OFFLINE_IMAGE_SETTINGS: OfflineImageSettings = {
  enabled: true,
  maxEdge: 2048,
  maxKB: 512,
  format: "webp",
  quality: 80,
};

export const DEFAULT_OFFLINE_VIDEO_SETTINGS: OfflineVideoSettings = {
  enabled: false,
  maxHeight: 720,
  bitrateKbps: 1200,
  audio: "keep",
  audioKbps: 96,
  encoder: "auto",
  cpuThreads: 4,
};

/**
 * Schema for `.gather/offline.json`.
 * Old Step 1 files (without selection/image/video/limits/behaviour fields) load cleanly with defaults.
 */
export const offlineSettingsSchema = z.object({
  version: z.literal(1).default(1),
  enabled: z.boolean().default(false),
  accounts: offlineAccountListSchema.default("all"),
  includeImages: z.boolean().default(true),
  includeVideos: z.boolean().default(true),
  selection: offlineSelectionSchema.default("all"),
  newestCount: z.number().int().min(1, "Use at least 1 file.").max(10000, "Use 10,000 or fewer.").default(200),
  image: offlineImageSettingsSchema.default(DEFAULT_OFFLINE_IMAGE_SETTINGS),
  video: offlineVideoSettingsSchema.default(DEFAULT_OFFLINE_VIDEO_SETTINGS),
  phoneBudgetMB: z.number().int().min(500, "Use at least 500 MB.").max(20000, "Use 20,000 MB or less.").default(2000),
  pcCacheMB: z.number().int().min(256, "Use at least 256 MB.").max(100000, "Use 100,000 MB or less.").default(10000),
  onlyWhenPluggedIn: z.boolean().default(true),
  prepareInBackground: z.boolean().default(false),
});

export const offlineSettingsPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    accounts: offlineAccountListSchema.optional(),
    includeImages: z.boolean().optional(),
    includeVideos: z.boolean().optional(),
    selection: offlineSelectionSchema.optional(),
    newestCount: z.number().int().min(1, "Use at least 1 file.").max(10000, "Use 10,000 or fewer.").optional(),
    image: offlineImageSettingsSchema.partial().strict().optional(),
    video: offlineVideoSettingsSchema.partial().strict().optional(),
    phoneBudgetMB: z.number().int().min(500, "Use at least 500 MB.").max(20000, "Use 20,000 MB or less.").optional(),
    pcCacheMB: z.number().int().min(256, "Use at least 256 MB.").max(100000, "Use 100,000 MB or less.").optional(),
    onlyWhenPluggedIn: z.boolean().optional(),
    prepareInBackground: z.boolean().optional(),
  })
  .strict();

export const offlineSettingsFileSchema = z.object({
  version: z.literal(1).optional(),
  enabled: z.boolean().optional(),
  accounts: offlineAccountListSchema.optional(),
  includeImages: z.boolean().optional(),
  includeVideos: z.boolean().optional(),
  selection: offlineSelectionSchema.optional(),
  newestCount: z.number().int().min(1).max(10000).optional(),
  image: offlineImageSettingsSchema.partial().optional(),
  video: offlineVideoSettingsSchema.partial().optional(),
  phoneBudgetMB: z.number().int().min(500).max(20000).optional(),
  pcCacheMB: z.number().int().min(256).max(100000).optional(),
  onlyWhenPluggedIn: z.boolean().optional(),
  prepareInBackground: z.boolean().optional(),
});

export type OfflineSettings = z.infer<typeof offlineSettingsSchema>;
export type OfflineSettingsPatch = z.infer<typeof offlineSettingsPatchSchema>;

export const DEFAULT_OFFLINE_SETTINGS: OfflineSettings = {
  version: 1,
  enabled: false,
  accounts: "all",
  includeImages: true,
  includeVideos: true,
  selection: "all",
  newestCount: 200,
  image: { ...DEFAULT_OFFLINE_IMAGE_SETTINGS },
  video: { ...DEFAULT_OFFLINE_VIDEO_SETTINGS },
  phoneBudgetMB: 2000,
  pcCacheMB: 10000,
  onlyWhenPluggedIn: true,
  prepareInBackground: false,
};

export interface OfflineFileCopyInfo {
  /** Prepared byte size when ready=true, or server-estimated byte size when ready=false. */
  bytes: number;
  /** True when the PC already has this Layer 3 derivative cached on disk. */
  ready: boolean;
  /** Preset identifier; changes whenever quality settings change so old copies regenerate. */
  preset: string;
}

export interface OfflineIndexAccount {
  folder: string;
  layout: DetectedLayout;
  lastRunAt?: string;
  imageCount: number;
  videoCount: number;
  totalBytes: number;
}

export interface OfflineIndexFile {
  /** Stable key: `${account}/${relPath}` */
  id: string;
  account: string;
  /** Relative subfolder inside account, e.g. "Image", "Image/2025", "Video", or "" for flat. */
  folder: string;
  filename: string;
  kind: MediaKind;
  size: number;
  /** Integer ms timestamp (Math.floor(mtimeMs)). */
  mtime: number;
  /** File version tag matching etagOf: `${size.toString(16)}-${mtime.toString(16)}`. */
  v: string;
  width?: number;
  height?: number;
  duration?: number;
  /** Present when this file is eligible for a Layer 3 offline copy. */
  offline?: OfflineFileCopyInfo;
}

export interface OfflineIndexResponse {
  ok: true;
  enabled: boolean;
  version: string;
  generatedAt: string;
  incremental: boolean;
  accounts: OfflineIndexAccount[];
  files: OfflineIndexFile[];
  removed?: string[];
  totalFiles: number;
  /** Layer 3 phone storage cap in bytes. */
  phoneBudgetBytes: number;
  /** Active Layer 3 preset IDs, omitted when that media kind's Layer 3 copies are turned off. */
  imagePreset?: string;
  videoPreset?: string;
}

export interface OfflineEstimate {
  imageCount: number;
  videoCount: number;
  thumbCount: number;
  estimatedBytes: number;
  cachedCount: number;
  cachedBytes: number;
  overPhoneBudget: boolean;
}

export type VideoCodecName = "h264_nvenc" | "h264_qsv" | "h264_amf" | "libx264";

export interface OfflineEncoderStatus {
  ffmpegAvailable: boolean;
  codec: VideoCodecName | null;
  bestGpu: Exclude<VideoCodecName, "libx264"> | null;
  fallback: boolean;
  label: string;
}

export function isAccountIncluded(settings: Pick<OfflineSettings, "accounts">, folder: string): boolean {
  if (settings.accounts === "all") return true;
  const target = folder.toLowerCase();
  return settings.accounts.some((name) => name.toLowerCase() === target);
}

export function isKindIncluded(
  settings: Pick<OfflineSettings, "includeImages" | "includeVideos">,
  kind: MediaKind,
): boolean {
  return kind === "image" ? settings.includeImages : settings.includeVideos;
}

export function isCopyEnabledForKind(
  settings: Pick<OfflineSettings, "includeImages" | "includeVideos" | "image" | "video">,
  kind: MediaKind,
): boolean {
  return kind === "image"
    ? settings.includeImages && settings.image.enabled
    : settings.includeVideos && settings.video.enabled;
}

export function imagePresetId(image: OfflineImageSettings): string {
  return `img-${image.format}-${image.maxEdge}-${image.maxKB}k-q${image.quality}`;
}

export function videoPresetId(video: OfflineVideoSettings): string {
  const audioPart = video.audio === "keep" ? `a${video.audioKbps}` : "noaudio";
  return `vid-${video.maxHeight}p-${video.bitrateKbps}k-${audioPart}-${video.encoder}`;
}

export function presetIdForKind(
  kind: MediaKind,
  settings: Pick<OfflineSettings, "image" | "video">,
): string {
  return kind === "image" ? imagePresetId(settings.image) : videoPresetId(settings.video);
}

export function offlineRelPath(folder: string, filename: string): string {
  return folder ? `${folder}/${filename}` : filename;
}

export function offlineFileId(account: string, folder: string, filename: string): string {
  return `${account}/${offlineRelPath(folder, filename)}`;
}

/** Deterministic newest-first ordering across files (tweet_id filename descending, then mtime, then id). */
export function compareOfflineNewestFirst(
  a: Pick<OfflineIndexFile, "filename" | "mtime" | "id">,
  b: Pick<OfflineIndexFile, "filename" | "mtime" | "id">,
): number {
  const byName = b.filename.localeCompare(a.filename, undefined, { numeric: true });
  if (byName !== 0) return byName;
  if (b.mtime !== a.mtime) return b.mtime - a.mtime;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Rough server-side byte estimate for a Layer 3 derivative before it has been generated. */
export function estimateDerivativeBytes(
  file: Pick<OfflineIndexFile, "kind" | "size" | "width" | "height" | "duration">,
  settings: Pick<OfflineSettings, "image" | "video">,
): number {
  if (file.size <= 0) return 0;
  if (file.kind === "image") {
    const maxBytes = settings.image.maxKB * 1024;
    let scaleFactor = 1;
    if (settings.image.maxEdge !== "original" && file.width && file.height) {
      const longest = Math.max(file.width, file.height);
      if (longest > settings.image.maxEdge) {
        const ratio = settings.image.maxEdge / longest;
        scaleFactor = ratio * ratio;
      }
    }
    const formatFactor = settings.image.format === "webp" ? 0.55 : 0.72;
    const qualityFactor = settings.image.quality / 80;
    const rough = Math.round(file.size * scaleFactor * formatFactor * qualityFactor);
    return Math.max(1, Math.min(file.size, maxBytes, Math.max(rough, Math.min(file.size, 24 * 1024))));
  }
  const totalKbps = settings.video.bitrateKbps + (settings.video.audio === "keep" ? settings.video.audioKbps : 0);
  if (file.duration !== undefined && file.duration > 0) {
    const estimated = Math.round(((totalKbps * 1000) / 8) * file.duration * 1.05);
    return Math.max(1, Math.min(file.size, estimated));
  }
  const fallback = Math.round(Math.min(file.size * 0.4, ((totalKbps * 1000) / 8) * 20));
  return Math.max(1, Math.min(file.size, fallback));
}

/** Picks Layer 3 eligible files newest-first until the phone storage budget would be exceeded. */
export function selectLayer3FilesWithinBudget(
  files: readonly OfflineIndexFile[],
  budgetBytes: number,
): OfflineIndexFile[] {
  if (budgetBytes <= 0) return [];
  const eligible = files.filter((file) => file.offline !== undefined).sort(compareOfflineNewestFirst);
  const kept: OfflineIndexFile[] = [];
  let used = 0;
  for (const file of eligible) {
    const est = Math.max(0, file.offline?.bytes ?? 0);
    if (used + est > budgetBytes) break;
    used += est;
    kept.push(file);
  }
  return kept;
}

/** Cache Storage & request URL for a Layer 2 offline 320 px thumbnail. */
export function offlineThumbUrl(account: string, folder: string, filename: string, version: string): string {
  const params = new URLSearchParams({
    account,
    path: offlineRelPath(folder, filename),
    v: version,
  });
  return `/m/api/offline/thumb?${params.toString()}`;
}

/** Cache Storage & request URL for a Layer 3 reduced-quality full-size / transcoded offline file. */
export function offlineFileUrl(account: string, folder: string, filename: string, version: string): string {
  const params = new URLSearchParams({
    account,
    path: offlineRelPath(folder, filename),
    v: version,
  });
  return `/m/api/offline/file?${params.toString()}`;
}
