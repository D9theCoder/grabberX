import { formatRelative } from "@/lib/format";
import type { UpdateState } from "@/lib/shell";

/** The line under "Check for updates" in Settings → About. */
export function updateCopy(state: UpdateState, now: Date): { tone: "info" | "danger"; text: string } {
  switch (state.state) {
    case "checking":
      return { tone: "info", text: "Checking for updates…" };
    case "current":
      return { tone: "info", text: `grabberX is up to date. Checked ${formatRelative(state.checkedAt, now)}.` };
    case "downloading":
      return { tone: "info", text: `Downloading grabberX ${state.version} · ${state.percent}%` };
    case "ready":
      return { tone: "info", text: `grabberX ${state.version} is ready. It installs by itself once grabberX is in the tray with nothing downloading, or restart now.` };
    case "error":
      return { tone: "danger", text: `Couldn't check for updates: ${state.message}` };
    case "unavailable":
      return { tone: "info", text: "Updates work only in the installed app." };
    default:
      return { tone: "info", text: "grabberX checks for updates at start and every 6 hours, and installs them by itself while it sits in the tray with nothing downloading." };
  }
}
