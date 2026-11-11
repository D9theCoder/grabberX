import type { Advanced, JobSpec, Layout, Settings, Step } from "@/lib/spec";
import { folderNameFor, siteDef } from "@/lib/sites";

/** gallery-dl 1.32.19 twitter defaults: retweets off, replies on. */
const TWITTER_RETWEETS_DEFAULT = false;
const TWITTER_REPLIES_DEFAULT = true;
/** gallery-dl's own default for -R. */
const RETRIES_DEFAULT = 4;

export function buildCommand(
  spec: JobSpec,
  settings: Pick<Settings, "mediaRoot" | "cookies">,
): Step[] {
  const steps: Step[] = [];
  if (spec.media !== "videos") {
    steps.push({ label: "images", argv: argvFor(spec, settings, "images") });
  }
  if (spec.media !== "images") {
    steps.push({ label: "videos", argv: argvFor(spec, settings, "videos") });
  }
  return steps;
}

function argvFor(
  spec: JobSpec,
  settings: Pick<Settings, "mediaRoot" | "cookies">,
  media: "images" | "videos",
): string[] {
  const site = siteDef(spec.site);
  const folder = folderNameFor(spec);
  const root = settings.mediaRoot.replace(/[\\/]+$/, "");
  const argv = [
    "-d",
    root,
    "-o",
    `directory=${JSON.stringify(directoryFor(spec.layout, folder, media))}`,
    ...site.mediaOptions(media),
    "--download-archive",
    `${root}/${folder}/archive.sqlite3`,
    ...qualityFlags(spec),
    ...dateFlags(spec),
    ...paceFlags(spec.advanced),
    ...selectionFlags(spec.advanced),
    ...outputFlags(spec.advanced),
    "--no-colors",
    ...cookieFlags(spec, settings),
  ];
  if (spec.simulate) argv.push("--simulate");
  argv.push(site.urlFor(spec.account));
  return argv;
}

function directoryFor(
  layout: Layout,
  folder: string,
  media: "images" | "videos",
): string[] {
  const typeFolder = media === "videos" ? "Video" : "Image";
  switch (layout.kind) {
    case "byType":
      return [folder, typeFolder];
    case "byTypeYear":
      return [folder, typeFolder, "{date:%Y}"];
    case "byMonth":
      return [folder, "{date:%Y-%m}"];
    case "flat":
      return [folder];
    case "custom":
      return [folder, ...layout.template];
  }
}

function qualityFlags(spec: JobSpec): string[] {
  const site = siteDef(spec.site);
  const flags: string[] = [];

  if (site.supportsSize && spec.advanced.imageSize !== "orig") {
    flags.push("-o", `twitter.size=${JSON.stringify([spec.advanced.imageSize])}`);
  }
  if (site.id === "x" && spec.advanced.retweets !== TWITTER_RETWEETS_DEFAULT) {
    flags.push("-o", `twitter.retweets=${spec.advanced.retweets}`);
  }
  if (site.id === "x" && spec.advanced.replies !== TWITTER_REPLIES_DEFAULT) {
    flags.push("-o", `twitter.replies=${spec.advanced.replies}`);
  }
  return flags;
}

function dateFlags(spec: JobSpec): string[] {
  const flags: string[] = [];
  if (spec.dateFrom) flags.push("--date-after", spec.dateFrom);
  // gallery-dl's --date-before is exclusive; the UI's "To" day is inclusive.
  if (spec.dateTo) flags.push("--date-before", nextDay(spec.dateTo));
  return flags;
}

function nextDay(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

function paceFlags(advanced: Advanced): string[] {
  const flags: string[] = [];
  if (advanced.sleepRequest) {
    flags.push("--sleep-request", String(advanced.sleepRequest));
  }
  if (advanced.sleep) flags.push("--sleep", String(advanced.sleep));
  if (advanced.sleep429) flags.push("--sleep-429", String(advanced.sleep429));
  if (advanced.retries !== undefined && advanced.retries !== RETRIES_DEFAULT) {
    flags.push("-R", String(advanced.retries));
  }
  return flags;
}

function selectionFlags(advanced: Advanced): string[] {
  const flags: string[] = [];
  if (advanced.limitRate) flags.push("--limit-rate", advanced.limitRate);
  if (advanced.filesizeMin) flags.push("--filesize-min", advanced.filesizeMin);
  if (advanced.filesizeMax) flags.push("--filesize-max", advanced.filesizeMax);
  if (advanced.abortAfterSkipped !== undefined) {
    flags.push("-A", String(advanced.abortAfterSkipped));
  }
  if (advanced.range !== undefined) {
    flags.push("--range", `1-${advanced.range}`);
  }
  return flags;
}

function outputFlags(advanced: Advanced): string[] {
  const flags: string[] = [];
  if (advanced.writeMetadata) flags.push("--write-metadata");
  if (advanced.noSkip) flags.push("--no-skip");
  if (advanced.proxy) flags.push("--proxy", advanced.proxy);
  return flags;
}

function cookieFlags(
  spec: JobSpec,
  settings: Pick<Settings, "cookies">,
): string[] {
  const cookies = spec.advanced.cookies ?? settings.cookies;
  if (!cookies || cookies.browser === "none") return [];
  const profile = cookies.profile?.trim();
  return [
    "--cookies-from-browser",
    profile ? `${cookies.browser}:${profile}` : cookies.browser,
  ];
}

/** PowerShell text for the command block: one flag per line, `\`` continuations. */
export function formatCommand(argv: string[], exe = "gallery-dl"): string {
  const lines = [exe, ...flagLines(argv).map((line) => `  ${line}`)];
  return lines
    .map((line, index) =>
      index === lines.length - 1 ? line : `${line} \``,
    )
    .join("\n");
}

function flagLines(argv: string[]): string[] {
  const lines: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith("-")) {
      lines.push(quoteArg(token));
      continue;
    }
    const value = argv[index + 1];
    if (value !== undefined && !value.startsWith("-")) {
      lines.push(`${token} ${quoteArg(value)}`);
      index++;
    } else {
      lines.push(token);
    }
  }
  return lines;
}

const BARE = /^[A-Za-z0-9_./:\\=,-]+$/;
const DOUBLE_UNSAFE = /["$`]/;

function quoteArg(value: string): string {
  const isUrl = /^https?:\/\//i.test(value);
  const needsEscaping = DOUBLE_UNSAFE.test(value);

  if (!isUrl && BARE.test(value)) return value;
  if (value.includes("'")) {
    return needsEscaping ? singleQuote(value) : `"${value}"`;
  }
  if (isUrl && !needsEscaping) return `"${value}"`;
  return singleQuote(value);
}

function singleQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
