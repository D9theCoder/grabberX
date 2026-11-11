import { formatCount } from "@/lib/format";
import type { Run, SiteId } from "@/lib/spec";

const SITE_NAMES: Record<SiteId, string> = {
  x: "X",
  instagram: "Instagram",
  bluesky: "Bluesky",
  pixiv: "Pixiv",
  reddit: "Reddit",
  url: "The site",
};

const SITE_HOSTS: Record<SiteId, string> = {
  x: "x.com",
  instagram: "instagram.com",
  bluesky: "bsky.app",
  pixiv: "pixiv.net",
  reddit: "reddit.com",
  url: "the site",
};

/** What the user reads when a run ends. Returns null while it is still going. */
export function endMessage(run: Run, galleryDlPath: string): { tone: "info" | "danger"; text: string } | null {
  const site = SITE_NAMES[run.spec.site];
  const host = SITE_HOSTS[run.spec.site];

  switch (run.status) {
    case "done":
      return run.counts.saved === 0
        ? { tone: "info", text: "Up to date · nothing new since last run." }
        : null;
    case "stopped":
      return { tone: "info", text: "Stopped. Unfinished files were removed." };
    case "interrupted":
      return { tone: "info", text: "The app restarted during this run. Unfinished files were removed." };
    case "failed":
      switch (run.errorKind) {
        case "auth":
          return { tone: "danger", text: `${site} asked for a login. Open ${host} in Firefox, sign in, then run again.` };
        case "notFound":
          return { tone: "danger", text: "This account doesn't exist or its posts are protected." };
        case "rateLimit":
          return {
            tone: "danger",
            text: `${site} is limiting requests. Wait about 15 minutes, or set Wait between pages to 2 s.`,
          };
        case "diskFull":
          return {
            tone: "danger",
            text: `The drive is full. ${formatCount(run.counts.saved)} files were saved before it stopped.`,
          };
        case "binaryMissing":
          return { tone: "danger", text: `gallery-dl wasn't found at ${galleryDlPath}. Set the path in Settings.` };
        default:
          return { tone: "danger", text: "The run failed. Check the log for details." };
      }
    default:
      return null;
  }
}

export function isActiveStatus(status: Run["status"]): boolean {
  return status === "queued" || status === "running" || status === "stopping";
}
