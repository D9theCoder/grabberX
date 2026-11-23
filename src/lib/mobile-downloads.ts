import { z } from "zod";
import type { Counts, Media, RunProgress, RunStatus, SiteId, Step } from "@/lib/spec";

export type DownloadKind = "image" | "video" | "both";

export const remoteDownloadRequestSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("account"),
    account: z.string().trim().min(1, "Enter an account.").max(100, "That handle is too long."),
    kind: z.enum(["image", "video", "both"], "Choose image, video, or both."),
  }),
  z.strictObject({
    mode: z.literal("post"),
    url: z.string().trim().min(1, "Paste a post link.").max(2048, "That link is too long."),
  }),
]);

export type RemoteDownloadRequest = z.infer<typeof remoteDownloadRequestSchema>;

export const remoteStopRequestSchema = z.strictObject({
  runId: z.string().trim().min(1, "Choose a run.").max(160, "That run doesn't exist."),
});

export interface MobileRunSummary {
  id: string;
  account: string;
  site: SiteId;
  postId?: string;
  media: Media;
  status: RunStatus;
  step?: Step["label"];
  stepIndex: number;
  steps: number;
  counts: Counts;
  progress?: RunProgress;
  position: number;
  remote: boolean;
  startedAt?: string;
  endedAt?: string;
  errorMessage?: string;
}

export interface MobileDownloadsResponse {
  ok: true;
  canDownload: boolean;
  runs: MobileRunSummary[];
}

export const KIND_TO_MEDIA: Record<DownloadKind, Media> = {
  image: "images",
  video: "videos",
  both: "all",
};
