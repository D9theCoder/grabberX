import { z } from "zod";
import { DEFAULT_ADVANCED } from "@/lib/spec";
import type { ActionResult, JobSpec } from "@/lib/spec";
import { FOLDER_PATTERN, validateAccount } from "@/lib/sites";

const SITE_IDS = ["x", "instagram", "bluesky", "pixiv", "reddit", "url"] as const;

/** A placeholder: {token}, {token[sub]} or {token:%fmt}. */
const TOKEN = /\{([A-Za-z0-9_]+)(?:\[[A-Za-z0-9_]+\])?(?::[A-Za-z0-9_%.:-]+)?\}/g;
const SEGMENT_SHAPE = /^(?:[A-Za-z0-9_ .-]|\{[A-Za-z0-9_]+(?:\[[A-Za-z0-9_]+\])?(?::[A-Za-z0-9_%.:-]+)?\})*$/;

/** gallery-dl keywords for X (`gallery-dl -K`) plus the generic ones every site has. */
const ALLOWED_TOKENS = new Set([
  "author",
  "category",
  "content",
  "count",
  "date",
  "date_original",
  "description",
  "duration",
  "extension",
  "filename",
  "id",
  "lang",
  "media_id",
  "name",
  "num",
  "post_id",
  "quote_by",
  "quote_id",
  "quoted_id",
  "reply_id",
  "reply_to",
  "retweet_id",
  "source",
  "source_id",
  "subcategory",
  "tags",
  "title",
  "tweet_id",
  "type",
  "user",
  "view_count",
  "width",
  "height",
]);

const siteInput = z.enum(SITE_IDS, "Pick a site.");

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use dates like 2025-10-31.")
  .refine(isRealDate, "That date doesn't exist.");

const folderName = z
  .string()
  .refine(
    (value) => FOLDER_PATTERN.test(value),
    "Use 1–64 letters, numbers, dots, dashes or _ for the folder name.",
  )
  .refine(
    (value) => !value.endsWith("."),
    "Folder names can't end with a dot.",
  );

const seconds = z
  .number()
  .refine(
    (value) => Number.isFinite(value) && value >= 0 && value <= 600,
    "Use 0 to 600 seconds.",
  );

function whole(min: number, max: number, message: string) {
  return z
    .number()
    .refine(
      (value) => Number.isInteger(value) && value >= min && value <= max,
      message,
    );
}

const sizeValue = z
  .string()
  .refine(
    (value) => /^\d+(\.\d+)?[kKmMgG]?$/.test(value),
    "Use a size like 200k or 5M.",
  );

const proxy = z
  .string()
  .refine(
    (value) => /^(https?|socks5h?|socks4a?):\/\/\S+$/i.test(value),
    "Use a proxy URL like http://127.0.0.1:8080.",
  );

const segment = z.string().superRefine((value, ctx) => {
  if (value.length === 0) {
    ctx.addIssue({ code: "custom", message: "A folder segment can't be empty." });
    return;
  }
  if (value.length > 120) {
    ctx.addIssue({
      code: "custom",
      message: "Folder segments can be at most 120 characters.",
    });
    return;
  }
  if (!SEGMENT_SHAPE.test(value)) {
    ctx.addIssue({
      code: "custom",
      message:
        "Use letters, numbers, spaces, . - _ and {tokens} in folder segments, and no / or \\.",
    });
    return;
  }
  if (value.includes("..")) {
    ctx.addIssue({ code: "custom", message: "A folder segment can't contain .." });
    return;
  }
  for (const match of value.matchAll(TOKEN)) {
    if (!ALLOWED_TOKENS.has(match[1])) {
      ctx.addIssue({
        code: "custom",
        message: `{${match[1]}} can't be used in a folder segment.`,
      });
      return;
    }
  }
});

const layout = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("byType") }),
  z.strictObject({ kind: z.literal("byTypeYear") }),
  z.strictObject({ kind: z.literal("byMonth") }),
  z.strictObject({ kind: z.literal("flat") }),
  z.strictObject({
    kind: z.literal("custom"),
    template: z
      .array(segment)
      .refine(
        (segments) => segments.length >= 1 && segments.length <= 6,
        "Use 1 to 6 folder segments.",
      ),
  }),
], "Pick a folder layout.");

const advanced = z.strictObject({
  imageSize: z.enum(["orig", "large", "medium"], "Pick an image size.").default("orig"),
  sleepRequest: seconds.optional(),
  sleep: seconds.optional(),
  sleep429: seconds.optional(),
  retries: whole(0, 20, "Use 0 to 20 retries.").optional(),
  limitRate: sizeValue.optional(),
  filesizeMin: sizeValue.optional(),
  filesizeMax: sizeValue.optional(),
  abortAfterSkipped: whole(1, 1000, "Use 1 to 1000 files.").optional(),
  range: whole(1, 100_000, "Use 1 to 100000 files.").optional(),
  retweets: z.boolean().default(DEFAULT_ADVANCED.retweets),
  replies: z.boolean().default(DEFAULT_ADVANCED.replies),
  writeMetadata: z.boolean().default(false),
  noSkip: z.boolean().default(false),
  cookies: z
    .strictObject({
      browser: z.enum(["firefox", "chrome", "edge", "none"], "Pick a browser."),
      profile: z
        .string()
        .refine(
          (value) => value.length <= 64 && /^[A-Za-z0-9 ._-]*$/.test(value),
          "Profile names use letters, numbers, spaces, dots, - or _.",
        )
        .optional(),
    })
    .default({ browser: "firefox" }),
  proxy: proxy.optional(),
});

const jobSpecInput = z.strictObject({
  site: siteInput,
  account: z.string().refine(
    (value) => value.length <= 2048,
    "That account is too long.",
  ),
  folder: folderName.optional(),
  media: z.enum(["images", "videos", "all"], "Pick images, videos or both."),
  dateFrom: isoDate.optional(),
  dateTo: isoDate.optional(),
  layout,
  simulate: z.boolean(),
  advanced,
});

/** Validates untrusted input (a Server Action argument) into a JobSpec. */
export function parseJobSpec(input: unknown): ActionResult<JobSpec> {
  const parsed = jobSpecInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: firstMessage(parsed.error.issues) };
  }

  const { site, account, dateFrom, dateTo } = parsed.data;
  const normalized = validateAccount(site, account);
  if (!normalized.ok) return { ok: false, error: normalized.message };

  if (dateFrom && dateTo && dateFrom > dateTo) {
    return { ok: false, error: "Start date is after end date." };
  }

  return { ok: true, data: { ...parsed.data, account: normalized.account } };
}

function isRealDate(value: string): boolean {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function firstMessage(
  issues: readonly { code?: string; message: string }[],
): string {
  const issue = issues[0];
  if (!issue) return "That run doesn't look right.";
  switch (issue.code) {
    case "unrecognized_keys":
      return "Unknown setting.";
    case "invalid_type":
      return "Some settings are missing or invalid.";
    case "invalid_union":
      return "Pick a folder layout.";
    default:
      return issue.message;
  }
}
