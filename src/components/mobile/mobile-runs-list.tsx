"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { RunProgressView } from "@/components/run-progress";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { Stat } from "@/components/ui/stat";
import { Status } from "@/components/ui/status";
import { MEDIA_LABELS } from "@/lib/form-helpers";
import type { MobileDownloadsResponse, MobileRunSummary, RemoteDownloadRequest } from "@/lib/mobile-downloads";
import { isActiveStatus } from "@/lib/run-copy";

const ACTIVE_POLL_MS = 2000;
const IDLE_POLL_MS = 6000;

export interface MobileDownloadsState {
  loaded: boolean;
  canDownload: boolean;
  runs: MobileRunSummary[];
  loadError: string | null;
  refresh: () => Promise<void>;
  startDownload: (
    payload: RemoteDownloadRequest,
  ) => Promise<{ ok: true; runId: string } | { ok: false; error: string }>;
  stopDownload: (runId: string) => Promise<{ ok: true } | { ok: false; error: string }>;
}

export function useMobileDownloads(): MobileDownloadsState {
  const [loaded, setLoaded] = useState(false);
  const [canDownload, setCanDownload] = useState(false);
  const [runs, setRuns] = useState<MobileRunSummary[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/m/api/downloads", { cache: "no-store" });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setLoadError(body?.error ?? "Couldn't read download status from the PC.");
        setLoaded(true);
        return;
      }
      const data = (await response.json()) as MobileDownloadsResponse;
      setCanDownload(data.canDownload === true);
      setRuns(Array.isArray(data.runs) ? data.runs : []);
      setLoadError(null);
      setLoaded(true);
    } catch {
      setLoadError("Couldn't reach the PC. Check that you're on the same network.");
      setLoaded(true);
    }
  }, []);

  const hasActive = runs.some((run) => isActiveStatus(run.status));

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function tick() {
      await load();
      if (!alive || document.visibilityState !== "visible") return;
      timer = setTimeout(tick, hasActive ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    }

    function onVisibility() {
      if (document.visibilityState === "visible") {
        clearTimeout(timer);
        void tick();
      }
    }

    void tick();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load, hasActive]);

  const startDownload = useCallback(
    async (
      payload: RemoteDownloadRequest,
    ): Promise<{ ok: true; runId: string } | { ok: false; error: string }> => {
      try {
        const response = await fetch("/m/api/downloads", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = (await response.json().catch(() => null)) as {
          ok?: boolean;
          runId?: string;
          run?: MobileRunSummary;
          error?: string;
        } | null;
        if (!response.ok || !data?.ok || !data.runId) {
          if (response.status === 403) void load();
          return { ok: false, error: data?.error ?? "The download couldn't be started." };
        }
        if (data.run) {
          const startedRun = data.run;
          setRuns((current) => [startedRun, ...current.filter((entry) => entry.id !== startedRun.id)]);
        }
        void load();
        return { ok: true, runId: data.runId };
      } catch {
        return { ok: false, error: "Couldn't reach the PC. Check that you're on the same network." };
      }
    },
    [load],
  );

  const stopDownload = useCallback(
    async (runId: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        const response = await fetch("/m/api/downloads/stop", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ runId }),
        });
        const data = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!response.ok || !data?.ok) {
          void load();
          return { ok: false, error: data?.error ?? "The run couldn't be stopped." };
        }
        void load();
        return { ok: true };
      } catch {
        return { ok: false, error: "Couldn't reach the PC. Check that you're on the same network." };
      }
    },
    [load],
  );

  return { loaded, canDownload, runs, loadError, refresh: load, startDownload, stopDownload };
}

export function MobilePermissionNotice({ loaded, canDownload }: { loaded: boolean; canDownload: boolean }) {
  if (!loaded || canDownload) return null;
  return (
    <Notice tone="info" title="Downloads are off for this phone">
      Open grabberX on the PC, go to Settings → Mobile gallery, and turn on &ldquo;Can start downloads&rdquo; for this
      phone.
    </Notice>
  );
}

export function MobileRunsList({
  runs,
  canDownload,
  onStop,
  emptyText = "No downloads yet.",
}: {
  runs: MobileRunSummary[];
  canDownload: boolean;
  onStop: (runId: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  emptyText?: string;
}) {
  const [stoppingId, setStoppingId] = useState<string | null>(null);
  const [stopError, setStopError] = useState<string | null>(null);

  async function handleStop(runId: string) {
    setStopError(null);
    setStoppingId(runId);
    const result = await onStop(runId);
    setStoppingId(null);
    if (!result.ok) setStopError(result.error);
  }

  return (
    <section className="flex flex-col gap-3 border-t border-line pt-6" aria-labelledby="mobile-runs-heading">
      <h2 id="mobile-runs-heading" className="m-0 text-title">
        Runs
      </h2>
      {stopError ? <Notice tone="danger">{stopError}</Notice> : null}
      {runs.length === 0 ? (
        <p className="m-0 text-body text-ink-2">{emptyText}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-line border-y border-line p-0">
          {runs.map((run) => {
            const active = isActiveStatus(run.status);
            const canStopRun = run.remote && canDownload && active && run.status !== "stopping";
            const detailParts: string[] = [];
            if (run.postId) detailParts.push(`post ${run.postId}`);
            else detailParts.push(MEDIA_LABELS[run.media]);
            if (run.status === "queued" && run.position > 0) detailParts.push(`#${run.position} in line`);
            if (active && run.steps > 1 && run.step) {
              detailParts.push(`${run.step} ${run.stepIndex + 1}/${run.steps}`);
            }
            return (
              <li key={run.id} className="flex flex-col gap-3 py-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className="font-mono text-code text-ink">@{run.account}</span>
                    <span className="text-small text-ink-2">{detailParts.join(" · ")}</span>
                  </div>
                  <Status state={run.status} />
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <Stat value={run.counts.saved} label="saved" />
                  <Stat value={run.counts.skipped} label="skipped" tone="muted" />
                  <Stat
                    value={run.counts.failed}
                    label={run.counts.failed > 0 ? "✕ failed" : "failed"}
                    tone={run.counts.failed > 0 ? "danger" : "default"}
                  />
                </div>

                <RunProgressView progress={run.progress} active={active} completed={run.status === "done"} />

                {run.errorMessage ? (
                  <Notice tone={run.status === "failed" ? "danger" : "info"}>{run.errorMessage}</Notice>
                ) : null}

                {canStopRun || run.status === "done" ? (
                  <div className="flex flex-wrap items-center gap-3">
                    {canStopRun ? (
                      <Button
                        variant="danger"
                        size="sm"
                        className="min-h-11 px-4"
                        loading={stoppingId === run.id}
                        onClick={() => void handleStop(run.id)}
                      >
                        {run.status === "queued" ? "Cancel" : "Stop"}
                      </Button>
                    ) : null}
                    {run.status === "done" ? (
                      <Link
                        href={`/m/${encodeURIComponent(run.account)}`}
                        className="inline-flex min-h-11 items-center text-label text-ink underline decoration-line-strong underline-offset-4 hover:text-ink-2"
                      >
                        Open in library
                      </Link>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
