import { formatCount } from "@/lib/format";
import type { RunStatus } from "@/lib/spec";
import type { UpdateAccountData, UpdateAllResult } from "@/lib/update-spec";

export interface UpdateMessage {
  tone: "info" | "danger";
  text: string;
}

/** A reason for a folder that already has an active run. "already running" is harmless, not an error. */
export function activeSkipReason(status: RunStatus): string {
  return `already ${status}`;
}

export function isActiveSkipReason(reason: string): boolean {
  return (
    reason === activeSkipReason("queued") ||
    reason === activeSkipReason("running") ||
    reason === activeSkipReason("stopping")
  );
}

/** Copy for a Library update, shared by the table so tests can pin the wording. */
export function updateAccountMessage(folder: string, data: UpdateAccountData): UpdateMessage {
  const assumed = data.assumedSite ? `Assumed X for ${folder}. ` : "";
  return {
    tone: "info",
    text: `${assumed}Update for ${folder} is queued. Follow it on the Run page.`,
  };
}

export function updateAllMessage(result: UpdateAllResult): UpdateMessage {
  const parts = [queuedCopy(result.started)];

  if (result.assumed.length > 0) {
    parts.push(`Assumed X for ${result.assumed.join(", ")}.`);
  }

  const active = result.skipped.filter((skip) => isActiveSkipReason(skip.reason));
  if (active.length > 0) {
    const names = active.map((skip) => `${skip.folder} (${skip.reason})`).join(", ");
    parts.push(`Skipped: ${names}.`);
  }

  // "Already running" is normal; anything else is a refusal the user needs to read.
  const refused = result.skipped.filter((skip) => !isActiveSkipReason(skip.reason));
  for (const skip of refused) {
    parts.push(`Skipped ${skip.folder}: ${skip.reason}`);
  }

  return { tone: refused.length > 0 ? "danger" : "info", text: parts.join(" ") };
}

function queuedCopy(started: number): string {
  if (started === 0) return "No updates queued.";
  if (started === 1) return "1 update queued.";
  return `${formatCount(started)} updates queued.`;
}
