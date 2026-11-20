"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { deleteRunAction } from "@/app/actions";
import { CopyIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";

/** Extracts unique http(s) URLs from error/warning log lines so failed items can be copied or retried. */
export function extractFailedUrls(lines: readonly string[]): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const line of lines) {
    if (!/\b(error|warning|failed|http\s+[45]\d\d)\b/i.test(line)) continue;
    const matches = line.match(/https?:\/\/[^\s"'<>)\]]+/gi);
    if (!matches) continue;
    for (const raw of matches) {
      const cleaned = raw.replace(/[.,;:]+$/, "");
      if (!seen.has(cleaned)) {
        seen.add(cleaned);
        urls.push(cleaned);
      }
    }
  }
  return urls;
}

export function LogActions({ lines }: { lines: string[] }) {
  const [copied, setCopied] = useState<"log" | "urls" | null>(null);
  const failedUrls = extractFailedUrls(lines);

  async function copy(kind: "log" | "urls", text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      setTimeout(() => setCopied((current) => (current === kind ? null : current)), 1500);
    } catch {
      /* clipboard blocked */
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="secondary" onClick={() => void copy("log", lines.join("\n"))}>
        <CopyIcon className="size-3.5" />
        {copied === "log" ? "Copied log" : "Copy log"}
      </Button>
      {failedUrls.length > 0 ? (
        <Button size="sm" variant="secondary" onClick={() => void copy("urls", failedUrls.join("\n"))}>
          <CopyIcon className="size-3.5" />
          {copied === "urls"
            ? `Copied ${failedUrls.length} URL${failedUrls.length === 1 ? "" : "s"}`
            : `Copy failed URLs (${failedUrls.length})`}
        </Button>
      ) : null}
    </div>
  );
}

export function DeleteRunButton({ runId }: { runId: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onConfirm() {
    setError(null);
    startTransition(async () => {
      const result = await deleteRunAction(runId);
      if (result.ok) {
        router.push("/history");
        router.refresh();
      } else {
        setError(result.error);
        setConfirming(false);
      }
    });
  }

  return (
    <div className="flex flex-col items-start gap-2">
      {confirming ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="danger" size="sm" loading={pending} onClick={onConfirm}>
            Confirm delete
          </Button>
          <Button variant="ghost" size="sm" disabled={pending} onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <Button variant="ghost" className="text-danger" onClick={() => setConfirming(true)}>
          Delete from history
        </Button>
      )}
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </div>
  );
}
