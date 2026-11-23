"use client";

import Link from "next/link";
import { useState } from "react";
import type { FormEvent } from "react";
import { BackIcon } from "@/components/icons";
import {
  MobilePermissionNotice,
  MobileRunsList,
  useMobileDownloads,
} from "@/components/mobile/mobile-runs-list";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { Segmented } from "@/components/ui/segmented";
import { TextField } from "@/components/ui/text-field";
import type { DownloadKind } from "@/lib/mobile-downloads";
import { interpretDownloadInput } from "@/lib/x-url";

type Mode = "account" | "post";

export function MobileDownloadClient() {
  const { loaded, canDownload, runs, loadError, startDownload, stopDownload } = useMobileDownloads();
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<Mode>("account");
  const [kind, setKind] = useState<DownloadKind>("both");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [startedNote, setStartedNote] = useState<string | null>(null);

  const interpreted = interpretDownloadInput(input);

  function handleInputChange(next: string) {
    setInput(next);
    setError(null);
    setStartedNote(null);
    const detected = interpretDownloadInput(next);
    if (detected.kind === "post") setMode("post");
    else if (detected.kind === "account") setMode("account");
  }

  let targetHandle: string | null = null;
  let postUrl: string | null = null;
  let postId: string | null = null;
  let validationHint: string | null = null;

  if (mode === "post") {
    if (interpreted.kind === "post") {
      targetHandle = interpreted.post.handle;
      postUrl = interpreted.post.canonicalUrl;
      postId = interpreted.post.postId;
    } else if (interpreted.kind !== "empty") {
      validationHint = "Paste an X post link like https://x.com/username/status/123456.";
    }
  } else if (interpreted.kind === "post") {
    targetHandle = interpreted.post.handle;
  } else if (interpreted.kind === "account") {
    targetHandle = interpreted.handle;
  } else if (interpreted.kind === "invalid") {
    validationHint = "X handles are 1–15 letters, numbers or _, or paste an X post link.";
  }

  const ready = mode === "post" ? Boolean(postUrl) : Boolean(targetHandle);
  const canSubmit = loaded && canDownload && ready && !submitting;

  let disabledReason: string | null = null;
  if (loaded && !canDownload) {
    disabledReason = 'Enable "Can start downloads" for this phone in Settings on the PC.';
  } else if (interpreted.kind === "empty") {
    disabledReason = "Enter an X handle or paste a post link first.";
  } else if (validationHint) {
    disabledReason = validationHint;
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setStartedNote(null);
    setSubmitting(true);
    const result =
      mode === "post" && postUrl
        ? await startDownload({ mode: "post", url: postUrl })
        : targetHandle
          ? await startDownload({ mode: "account", account: targetHandle, kind })
          : ({ ok: false, error: "Enter a handle or post link first." } as const);
    setSubmitting(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setStartedNote(
      mode === "post" && postId && targetHandle
        ? `Queued post ${postId} from @${targetHandle}.`
        : `Queued @${targetHandle}.`,
    );
  }

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-5 px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-12">
      <div className="flex flex-col gap-2">
        <Link
          href="/m"
          className="inline-flex min-h-11 items-center gap-1 self-start text-small text-ink-2 underline decoration-line-strong underline-offset-4 hover:text-ink"
        >
          <BackIcon className="size-4" />
          Back to library
        </Link>
        <h1 className="m-0 text-display">Download</h1>
      </div>

      {loadError ? <Notice tone="danger">{loadError}</Notice> : null}
      <MobilePermissionNotice loaded={loaded} canDownload={canDownload} />

      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <TextField
          label="Account or post link"
          mono
          placeholder="@username or x.com/user/status/..."
          value={input}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          error={validationHint ?? undefined}
          hint={
            !validationHint && mode === "post" && postId && targetHandle
              ? `Post ${postId} · saves to ${targetHandle}/Image and ${targetHandle}/Video`
              : !validationHint && mode === "account" && targetHandle
                ? `Saves to ${targetHandle}/Image and ${targetHandle}/Video`
                : "Runs on the PC and saves straight into your library."
          }
          onChange={(event) => handleInputChange(event.target.value)}
          className="[&_input]:min-h-11 [&>div]:min-h-11"
        />

        <div className="flex flex-col gap-1.5">
          <span className="text-label text-ink">What to download</span>
          <Segmented
            label="What to download"
            columns={2}
            value={mode}
            onChange={(value) => {
              setMode(value as Mode);
              setError(null);
            }}
            options={[
              { value: "account", label: "Whole account" },
              { value: "post", label: "This post" },
            ]}
          />
        </div>

        {mode === "account" ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-label text-ink">Media</span>
            <Segmented
              label="Media"
              columns={3}
              value={kind}
              onChange={(value) => setKind(value as DownloadKind)}
              options={[
                { value: "image", label: "Images" },
                { value: "video", label: "Videos" },
                { value: "both", label: "Both" },
              ]}
            />
          </div>
        ) : null}

        {error ? <Notice tone="danger">{error}</Notice> : null}
        {startedNote ? <Notice tone="info">{startedNote}</Notice> : null}

        <div className="flex flex-col gap-1.5 pt-1">
          <Button
            type="submit"
            variant="primary"
            className="min-h-11 w-full"
            loading={submitting}
            disabled={!canSubmit}
          >
            Download
          </Button>
          {disabledReason ? <p className="m-0 text-small text-ink-2">{disabledReason}</p> : null}
        </div>
      </form>

      <MobileRunsList runs={runs} canDownload={canDownload} onStop={stopDownload} />
    </main>
  );
}
