"use client";

import Link from "next/link";
import { useState } from "react";
import { BackIcon } from "@/components/icons";
import {
  MobilePermissionNotice,
  MobileRunsList,
  useMobileDownloads,
} from "@/components/mobile/mobile-runs-list";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { Segmented } from "@/components/ui/segmented";
import type { DownloadKind } from "@/lib/mobile-downloads";
import type { ParsedXPost } from "@/lib/x-url";

export function MobileShareClient({
  parsedPost,
  parsedAccount,
}: {
  parsedPost: ParsedXPost | null;
  parsedAccount: string | null;
}) {
  const { loaded, canDownload, runs, loadError, startDownload, stopDownload } = useMobileDownloads();
  const [kind, setKind] = useState<DownloadKind>("both");
  const [pending, setPending] = useState<"post" | "account" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startedNote, setStartedNote] = useState<string | null>(null);

  const handle = parsedPost?.handle ?? parsedAccount;
  const actionsDisabled = !loaded || !canDownload || pending !== null;

  async function runPost() {
    if (!parsedPost || actionsDisabled) return;
    setError(null);
    setStartedNote(null);
    setPending("post");
    const result = await startDownload({ mode: "post", url: parsedPost.canonicalUrl });
    setPending(null);
    if (!result.ok) setError(result.error);
    else setStartedNote(`Queued post ${parsedPost.postId} from @${parsedPost.handle}.`);
  }

  async function runAccount() {
    if (!handle || actionsDisabled) return;
    setError(null);
    setStartedNote(null);
    setPending("account");
    const result = await startDownload({ mode: "account", account: handle, kind });
    setPending(null);
    if (!result.ok) setError(result.error);
    else setStartedNote(`Queued @${handle}.`);
  }

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-5 px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-12">
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <Link
            href="/m"
            className="inline-flex min-h-11 items-center gap-1 text-small text-ink-2 underline decoration-line-strong underline-offset-4 hover:text-ink"
          >
            <BackIcon className="size-4" />
            Library
          </Link>
          <Link
            href="/m/download"
            className="inline-flex min-h-11 items-center text-small text-ink-2 underline decoration-line-strong underline-offset-4 hover:text-ink"
          >
            Download page
          </Link>
        </div>
        <h1 className="m-0 text-display">Shared link</h1>
      </div>

      {loadError ? <Notice tone="danger">{loadError}</Notice> : null}
      <MobilePermissionNotice loaded={loaded} canDownload={canDownload} />

      {parsedPost ? (
        <div className="flex flex-col gap-4 rounded-lg border border-line-strong bg-surface p-4">
          <div className="flex flex-col gap-1">
            <span className="font-mono text-title text-ink">@{parsedPost.handle}</span>
            <span className="font-mono text-small break-all text-ink-2">{parsedPost.canonicalUrl}</span>
          </div>

          <Button
            variant="primary"
            className="min-h-11 w-full"
            loading={pending === "post"}
            disabled={actionsDisabled}
            onClick={() => void runPost()}
          >
            Download this post
          </Button>

          <div className="flex flex-col gap-3 border-t border-line pt-4">
            <div className="flex flex-col gap-1.5">
              <span className="text-label text-ink">Account media</span>
              <Segmented
                label="Account media"
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
            <Button
              variant="secondary"
              className="min-h-11 w-full"
              loading={pending === "account"}
              disabled={actionsDisabled}
              onClick={() => void runAccount()}
            >
              {`Download all media from @${parsedPost.handle}`}
            </Button>
          </div>

          {loaded && !canDownload ? (
            <p className="m-0 text-small text-ink-2">
              Enable &ldquo;Can start downloads&rdquo; for this phone in Settings on the PC first.
            </p>
          ) : null}
        </div>
      ) : parsedAccount ? (
        <div className="flex flex-col gap-4 rounded-lg border border-line-strong bg-surface p-4">
          <div className="flex flex-col gap-1">
            <span className="font-mono text-title text-ink">@{parsedAccount}</span>
            <span className="text-small text-ink-2">Profile link shared (no post ID found).</span>
          </div>
          <Segmented
            label="Account media"
            columns={3}
            value={kind}
            onChange={(value) => setKind(value as DownloadKind)}
            options={[
              { value: "image", label: "Images" },
              { value: "video", label: "Videos" },
              { value: "both", label: "Both" },
            ]}
          />
          <Button
            variant="primary"
            className="min-h-11 w-full"
            loading={pending === "account"}
            disabled={actionsDisabled}
            onClick={() => void runAccount()}
          >
            {`Download all media from @${parsedAccount}`}
          </Button>
          {loaded && !canDownload ? (
            <p className="m-0 text-small text-ink-2">
              Enable &ldquo;Can start downloads&rdquo; for this phone in Settings on the PC first.
            </p>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <Notice tone="info" title="No X post link found">
            Nothing shared looked like an X post link. Open the Download page to enter a handle or link by hand.
          </Notice>
          <Link
            href="/m/download"
            className="inline-flex min-h-11 items-center justify-center rounded-md border border-line-strong bg-surface px-4 text-label font-medium text-ink transition-colors duration-120 hover:border-ink-2"
          >
            Open Download
          </Link>
        </div>
      )}

      {error ? <Notice tone="danger">{error}</Notice> : null}
      {startedNote ? <Notice tone="info">{startedNote}</Notice> : null}

      <MobileRunsList runs={runs} canDownload={canDownload} onStop={stopDownload} />
    </main>
  );
}
