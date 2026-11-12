import type { Advanced, JobSpec, Layout, Settings, Step } from "@/lib/spec";
import { folderNameFor, siteDef, siteForUrl } from "@/lib/sites";

/** gallery-dl 1.32.19 twitter defaults: retweets off, replies on. */
const TWITTER_RETWEETS_DEFAULT = false;
const TWITTER_REPLIES_DEFAULT = true;
/** gallery-dl's own default for -R. */
const RETRIES_DEFAULT = 4;

export const MAX_PARALLEL = 4;
/** Each worker's unfinished files go here, inside the account folder (same drive, so the final move is a rename). */
export const WORKER_PARTS_DIR = ".gather-parts";

/**
 * Why this run cannot use parallel downloads, or null when it can. Every worker lists the whole profile, so the
 * site must not rate-limit its listing; and a layout that creates folders mid-run (by year or month) would have
 * two workers race to create the same folder, which gallery-dl does not tolerate.
 */
export function parallelBlock(spec: Pick<JobSpec, "site" | "layout" | "account">): string | null {
  const site = (spec.site === "url" ? siteForUrl(spec.account) : null) ?? siteDef(spec.site);
  if (!site.parallel) return `${site.label} limits requests, so it downloads one file at a time.`;
  if (spec.layout.kind !== "byType" && spec.layout.kind !== "flat") {
    return "Parallel downloads need the By type or Flat layout.";
  }
  return null;
}

/** How many gallery-dl processes each step uses: 1 unless the spec asks for more and is allowed to. */
export function workerCount(spec: JobSpec): number {
  const asked = spec.advanced.parallel ?? 1;
  if (asked < 2 || parallelBlock(spec) !== null) return 1;
  return Math.min(MAX_PARALLEL, Math.floor(asked));
}

export function buildCommand(
  spec: JobSpec,
  settings: Pick<Settings, "mediaRoot" | "cookies">,
): Step[] {
  const steps: Step[] = [];
  if (spec.media !== "videos") {
    steps.push(withWorkers(spec, settings, { label: "images", argv: argvFor(spec, settings, "images") }));
  }
  if (spec.media !== "images") {
    steps.push(withWorkers(spec, settings, { label: "videos", argv: argvFor(spec, settings, "videos") }));
  }
  return steps;
}

function withWorkers(spec: JobSpec, settings: Pick<Settings, "mediaRoot">, step: Step): Step {
  const count = workerCount(spec);
  if (count < 2) return step;
  const partsRoot = `${rootPrefixOf(settings.mediaRoot)}${folderNameFor(spec)}/${WORKER_PARTS_DIR}`;
  const workers = Array.from({ length: count }, (_, index) =>
    workerArgv(step.argv, index + 1, count, `${partsRoot}/w${index + 1}`),
  );
  return { ...step, workers };
}

/**
 * The folder a step writes to, for creating it before the workers start: gallery-dl creates a missing folder
 * without allowing for another process creating it at the same moment. Only fixed layouts run in parallel, so
 * the path has no date fields.
 */
export function stepTargetDir(spec: JobSpec, settings: Pick<Settings, "mediaRoot">, label: Step["label"]): string {
  const media = label === "videos" ? "videos" : "images";
  return `${rootPrefixOf(settings.mediaRoot)}${directoryFor(spec.layout, folderNameFor(spec), media).join("/")}`;
}

/**
 * One worker's argv: the step's argv with its file slice (`--range i::N`, or `first+i-1:last+1:N` inside a
 * `--range first-last`) and its own folder for `.part` files, so two workers can never write the same unfinished file.
 */
export function workerArgv(argv: string[], index: number, count: number, partDir: string): string[] {
  const out: string[] = [];
  let first = 1;
  let last: number | undefined;
  for (let at = 0; at < argv.length; at++) {
    if (argv[at] === "--range") {
      const value = argv[at + 1] ?? "";
      const match = /^(\d*)-(\d*)$/.exec(value);
      // Dropping a range this cannot split would silently download the whole profile.
      if (!match) throw new Error(`Parallel downloads cannot split --range ${value}.`);
      first = Number(match[1]) || 1;
      last = match[2] ? Number(match[2]) : undefined;
      at++;
      continue;
    }
    out.push(argv[at]!);
  }
  // A step without a filter would let gallery-dl count with the extractor's own skip shortcut, and the
  // workers' slices would no longer line up; every step is expected to carry one.
  if (!out.includes("--filter")) out.splice(out.length - 1, 0, "--filter", "True");
  const slice = `${first + index - 1}:${last === undefined ? "" : last + 1}:${count}`;
  out.splice(out.length - 1, 0, "--range", slice, "-o", `downloader.part-directory=${JSON.stringify(partDir)}`);
  return out;
}

function rootOf(mediaRoot: string): string {
  const trimmed = mediaRoot.replace(/[\\/]+$/, "");
  // A drive root ("D:\") or "/" loses its meaning without the slash: "D:" is the current folder on D.
  return trimmed === "" || /^[A-Za-z]:$/.test(trimmed) ? `${trimmed}/` : trimmed;
}

function rootPrefixOf(mediaRoot: string): string {
  const root = rootOf(mediaRoot);
  return root.endsWith("/") ? root : `${root}/`;
}

function argvFor(
  spec: JobSpec,
  settings: Pick<Settings, "mediaRoot" | "cookies">,
  media: "images" | "videos",
): string[] {
  const site = siteDef(spec.site);
  const folder = folderNameFor(spec);
  const root = rootOf(settings.mediaRoot);
  const rootPrefix = rootPrefixOf(settings.mediaRoot);
  const argv = [
    "-d",
    root,
    "-o",
    `directory=${JSON.stringify(directoryFor(spec.layout, folder, media))}`,
    ...site.mediaOptions(media),
    "--download-archive",
    `${rootPrefix}${folder}/archive.sqlite3`,
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
      // Videos stay flat, as in the existing year-grouped accounts and the layout previews.
      return media === "videos" ? [folder, typeFolder] : [folder, typeFolder, "{date:%Y}"];
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

/** One cheap `-j` call for the first item, to read the account's media count. It writes nothing and uses no archive. */
export function probeArgv(spec: JobSpec, settings: Pick<Settings, "cookies">): string[] {
  const argv = ["-j", "--range", "1", "--no-colors", ...cookieFlags(spec, settings)];
  if (spec.advanced.proxy) argv.push("--proxy", spec.advanced.proxy);
  argv.push(siteDef(spec.site).urlFor(spec.account));
  return argv;
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

/** Flags that take no value; the token after one is the next argument, never its value. */
const SWITCHES = new Set(["--no-colors", "--simulate", "--no-skip", "--write-metadata"]);

function flagLines(argv: string[]): string[] {
  const lines: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith("-")) {
      lines.push(quoteArg(token));
      continue;
    }
    const value = argv[index + 1];
    if (!SWITCHES.has(token) && value !== undefined && !value.startsWith("-")) {
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
