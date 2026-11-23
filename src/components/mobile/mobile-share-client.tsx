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
import type { DownloadKind, RemoteDownloadRequest } from "@/lib/mobile-downloads";
import type { SharedLink } from "@/lib/share-link";
import { siteDef } from "@/lib/sites";

type Action = "post" | "account" | "link";

const ACTION_BUTTON = "min-h-11 w-full";

function accountLabel(link: SharedLink): string {
  if (!link.site || !link.account) return "";
  const def = siteDef(link.site.id);
  return def.prefix === "@" ? `@${link.account}` : `${link.account} on ${link.site.label}`;
}

function fullFormHref(link: SharedLink): string {
  const query = new URLSearchParams(
    link.site ? { site: link.site.id, account: link.post ? link.url : (link.account ?? link.url) } : { site: "url", account: link.url },
  );
  return `/m/download?${query}`;
}

export function MobileShareClient({ link }: { link: SharedLink | null }) {
  const { loaded, canDownload, runs, loadError, startDownload, stopDownload } = useMobileDownloads();
  const [kind, setKind] = useState<DownloadKind>("both");
  const [pending, setPending] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startedNote, setStartedNote] = useState<string | null>(null);

  const actionsDisabled = !loaded || !canDownload || pending !== null;

  async function run(action: Action, payload: RemoteDownloadRequest, note: string) {
    if (actionsDisabled) return;
    setError(null);
    setStartedNote(null);
    setPending(action);
    const result = await startDownload(payload);
    setPending(null);
    if (!result.ok) setError(result.error);
    else setStartedNote(note);
  }

  const kindPicker = (
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
  );

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
            href={link ? fullFormHref(link) : "/m/download"}
            className="inline-flex min-h-11 items-center text-small text-ink-2 underline decoration-line-strong underline-offset-4 hover:text-ink"
          >
            {link ? "More options" : "Download page"}
          </Link>
        </div>
        <h1 className="m-0 text-display">Shared link</h1>
      </div>

      {loadError ? <Notice tone="danger">{loadError}</Notice> : null}
      <MobilePermissionNotice loaded={loaded} canDownload={canDownload} />

      {link ? (
        <div className="flex flex-col gap-4 rounded-lg border border-line-strong bg-surface p-4">
          <div className="flex flex-col gap-1">
            <span className="font-mono text-title text-ink">
              {link.post ? `@${link.post.handle}` : link.account ? accountLabel(link) : (link.site?.label ?? "Other link")}
            </span>
            <span className="font-mono text-small break-all text-ink-2">{link.post?.canonicalUrl ?? link.url}</span>
          </div>

          {link.post ? (
            <Button
              variant="primary"
              className={ACTION_BUTTON}
              loading={pending === "post"}
              disabled={actionsDisabled}
              onClick={() =>
                void run(
                  "post",
                  { mode: "post", url: link.post!.canonicalUrl },
                  `Queued post ${link.post!.postId} from @${link.post!.handle}.`,
                )
              }
            >
              Download this post
            </Button>
          ) : null}

          <div className={link.post ? "flex flex-col gap-3 border-t border-line pt-4" : "flex flex-col gap-3"}>
            {kindPicker}
            {link.site && link.account ? (
              <Button
                variant={link.post ? "secondary" : "primary"}
                className={ACTION_BUTTON}
                loading={pending === "account"}
                disabled={actionsDisabled}
                onClick={() =>
                  void run(
                    "account",
                    { mode: "account", site: link.site!.id, account: link.account!, kind },
                    `Queued ${accountLabel(link)}.`,
                  )
                }
              >
                {`Download all media from ${accountLabel(link)}`}
              </Button>
            ) : null}
            {!link.post ? (
              <Button
                variant={link.site && link.account ? "secondary" : "primary"}
                className={ACTION_BUTTON}
                loading={pending === "link"}
                disabled={actionsDisabled}
                onClick={() => void run("link", { mode: "link", url: link.url, kind }, "Queued this link.")}
              >
                {link.site && link.account ? "Download just this link" : "Download this link"}
              </Button>
            ) : null}
          </div>

          {loaded && !canDownload ? (
            <p className="m-0 text-small text-ink-2">
              Enable &ldquo;Can start downloads&rdquo; for this phone in Settings on the PC first.
            </p>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <Notice tone="info" title="No link found">
            Nothing shared looked like a web link. Open the Download page to enter an account or link by hand.
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
