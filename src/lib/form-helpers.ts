import { DEFAULT_ADVANCED } from "@/lib/spec";
import type { Advanced, DetectedLayout, Layout, Media } from "@/lib/spec";

export type DatePreset = "all" | "30d" | "year" | "custom";

export function toIsoDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function datePresetRange(
  preset: DatePreset,
  today: Date,
): { dateFrom?: string; dateTo?: string } {
  if (preset === "30d") {
    const from = new Date(today);
    from.setDate(from.getDate() - 30);
    return { dateFrom: toIsoDate(from) };
  }
  if (preset === "year") return { dateFrom: `${today.getFullYear()}-01-01` };
  return {};
}

export type LayoutKind = Layout["kind"];

export const LAYOUT_LABELS: Record<LayoutKind, string> = {
  byType: "By type",
  byTypeYear: "By type + year",
  byMonth: "Year / month",
  flat: "Flat",
  custom: "Custom",
};

export const MEDIA_LABELS: Record<Media, string> = {
  images: "Images",
  videos: "Videos",
  all: "All",
};

const SAMPLE = { tweetId: "1834220145", year: "2025", month: "03", day: "14" };

function renderToken(token: string, folder: string): string {
  switch (token) {
    case "date:%Y":
      return SAMPLE.year;
    case "date:%Y-%m":
      return `${SAMPLE.year}-${SAMPLE.month}`;
    case "date:%Y-%m-%d":
      return `${SAMPLE.year}-${SAMPLE.month}-${SAMPLE.day}`;
    case "date:%m":
      return SAMPLE.month;
    case "tweet_id":
      return SAMPLE.tweetId;
    case "num":
      return "1";
    case "extension":
      return "jpg";
    case "author[name]":
    case "user[name]":
      return folder;
    default:
      return `{${token}}`;
  }
}

export function renderTemplateSample(segments: string[], folder: string): string[] {
  return segments.map((segment) => segment.replace(/\{([^}]+)\}/g, (_, token) => renderToken(token, folder)));
}

/** Where a sample file lands for a layout, e.g. "username/Image/2025/1834220145_1.jpg". */
export function layoutPathPreview(layout: Layout, folder: string, kind: "image" | "video"): string {
  const name = kind === "image" ? `${SAMPLE.tweetId}_1.jpg` : `${SAMPLE.tweetId}_1.mp4`;
  const typeDir = kind === "image" ? "Image" : "Video";
  switch (layout.kind) {
    case "byType":
      return [folder, typeDir, name].join("/");
    case "byTypeYear":
      return [folder, typeDir, ...(kind === "image" ? [SAMPLE.year] : []), name].join("/");
    case "byMonth":
      return [folder, `${SAMPLE.year}-${SAMPLE.month}`, name].join("/");
    case "flat":
      return [folder, name].join("/");
    case "custom":
      return [folder, ...renderTemplateSample(layout.template, folder), name].join("/");
  }
}

/** The path shown on a folder-layout row, with both media types where they differ. */
export function layoutSummary(layout: Layout, folder: string): string {
  switch (layout.kind) {
    case "byType":
      return `${folder}/Image/ · ${folder}/Video/`;
    case "byTypeYear":
      return `${folder}/Image/2025/ · ${folder}/Video/`;
    case "byMonth":
      return `${folder}/2025-03/`;
    case "flat":
      return `${folder}/`;
    case "custom": {
      const sample = layoutPathPreview(layout, folder, "image").split("/");
      return `${sample.slice(0, -1).join("/")}/`;
    }
  }
}

/** The on-disk layout a chosen Layout would produce, for comparing with what a folder already holds. */
export function detectedLayoutOf(layout: Layout): DetectedLayout {
  switch (layout.kind) {
    case "byType":
    case "byTypeYear":
    case "flat":
      return layout.kind;
    case "byMonth":
    case "custom":
      return "unknown";
  }
}

export function templateToSegments(text: string): string[] {
  return text
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

type AdvancedKey = keyof Advanced;

const ADVANCED_KEYS = Object.keys(DEFAULT_ADVANCED) as AdvancedKey[];

/** Advanced keys whose value differs from the default, in a stable order. */
export function changedAdvancedKeys(advanced: Advanced, cookiesDefault: Advanced["cookies"]): AdvancedKey[] {
  const keys = new Set<AdvancedKey>(ADVANCED_KEYS);
  for (const key of Object.keys(advanced) as AdvancedKey[]) keys.add(key);

  return [...keys].filter((key) => {
    const baseline = key === "cookies" ? cookiesDefault : DEFAULT_ADVANCED[key];
    return JSON.stringify(advanced[key] ?? null) !== JSON.stringify(baseline ?? null);
  });
}
