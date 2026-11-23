"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { BackIcon } from "@/components/icons";
import {
  MobilePermissionNotice,
  MobileRunsList,
  useMobileDownloads,
} from "@/components/mobile/mobile-runs-list";
import { RunForm } from "@/components/run-form";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { Switch } from "@/components/ui/switch";
import { parallelBlock } from "@/lib/command";
import { changedAdvancedKeys, datePresetRange, templateToSegments } from "@/lib/form-helpers";
import type { DatePreset, LayoutKind } from "@/lib/form-helpers";
import { FOLDER_PATTERN, folderNameFor, siteDef, validateAccount } from "@/lib/sites";
import { createDefaultSpec } from "@/lib/spec";
import type { AccountHint, Advanced, JobSpec, Layout, Settings, SiteId } from "@/lib/spec";
import { parseXPostUrl } from "@/lib/x-url";

// Same values as the desktop Run screen, so a run started from the phone behaves like one started at the PC.
const CAUGHT_UP_AFTER = 20;
const HINT_DEBOUNCE_MS = 300;
const DEFAULT_TEMPLATE = "{date:%Y}";

export type MobileRunDefaults = Pick<Settings, "defaultMedia" | "defaultLayout" | "cookies">;

interface MobileDownloadClientProps {
  defaults: MobileRunDefaults;
  initialSite?: SiteId;
  initialAccount?: string;
}

function layoutFor(kind: LayoutKind, templateText: string): Layout {
  return kind === "custom" ? { kind, template: templateToSegments(templateText) } : { kind };
}

function xPostOf(raw: string) {
  const trimmed = raw.trim();
  return parseXPostUrl(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
}

export function MobileDownloadClient({ defaults, initialSite, initialAccount = "" }: MobileDownloadClientProps) {
  const { loaded, canDownload, runs, loadError, startDownload, stopDownload } = useMobileDownloads();
  const [spec, setSpec] = useState<JobSpec>(() => ({
    ...createDefaultSpec(defaults),
    site: initialSite ?? "x",
  }));
  const [accountInput, setAccountInput] = useState(() => {
    const site = initialSite ?? "x";
    const parsed = initialAccount && site !== "url" ? validateAccount(site, initialAccount) : null;
    return parsed?.ok ? parsed.account : initialAccount;
  });
  const [postId, setPostId] = useState<string | null>(() =>
    (initialSite ?? "x") === "x" && initialAccount ? (xPostOf(initialAccount)?.postId ?? null) : null,
  );
  const [onlyPost, setOnlyPost] = useState(true);
  const [datePreset, setDatePreset] = useState<DatePreset>("all");
  const [templateText, setTemplateText] = useState(
    defaults.defaultLayout.kind === "custom" ? defaults.defaultLayout.template.join("/") : DEFAULT_TEMPLATE,
  );
  const [folderOverride, setFolderOverride] = useState("");
  const [caughtUpChoice, setCaughtUpChoice] = useState<boolean | null>(null);
  const [remoteHint, setRemoteHint] = useState<{ key: string; hint: AccountHint } | null>(null);
  const [pending, setPending] = useState<"preview" | "download" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startedNote, setStartedNote] = useState<string | null>(null);

  const site = siteDef(spec.site);
  const validation = accountInput.trim() ? validateAccount(spec.site, accountInput) : null;
  const account = validation?.ok ? validation.account : "";
  const accountError = validation && !validation.ok ? validation.message : undefined;

  const folderTrimmed = folderOverride.trim();
  const folderError =
    folderTrimmed && (!FOLDER_PATTERN.test(folderTrimmed) || folderTrimmed.endsWith("."))
      ? "Use 1–64 letters, numbers, dots, dashes or _."
      : undefined;

  const hintKey = `${spec.site}|${account}|${folderTrimmed}`;
  const hint: AccountHint | null = account && remoteHint?.key === hintKey ? remoteHint.hint : null;

  useEffect(() => {
    if (!account) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const query = new URLSearchParams({ site: spec.site, account });
      if (folderTrimmed) query.set("folder", folderTrimmed);
      try {
        const response = await fetch(`/m/api/downloads/hint?${query}`, { cache: "no-store" });
        const body = (await response.json().catch(() => null)) as { hint?: AccountHint } | null;
        if (!cancelled && body?.hint) setRemoteHint({ key: hintKey, hint: body.hint });
      } catch {
        // The hint is a convenience; the run still validates on the PC.
      }
    }, HINT_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [spec.site, account, folderTrimmed, hintKey]);

  const singlePost = spec.site === "x" && postId !== null && onlyPost;
  const defaultCaughtUp = hint?.kind === "exists";
  const caughtUp = caughtUpChoice ?? defaultCaughtUp;

  const parallelReason = parallelBlock({ ...spec, account });
  const parallel = parallelReason === null ? spec.advanced.parallel : undefined;

  const effectiveSpec: JobSpec = {
    ...spec,
    account,
    ...(singlePost && postId ? { postId } : {}),
    folder: folderError ? undefined : folderTrimmed || undefined,
    advanced: {
      ...spec.advanced,
      parallel,
      abortAfterSkipped: caughtUp && !singlePost ? CAUGHT_UP_AFTER : undefined,
    },
  };

  const previewAccount = account || (spec.site === "url" ? "https://example.com/" : site.placeholder);
  const folderName = folderNameFor({ ...effectiveSpec, account: previewAccount });

  const dateError =
    datePreset === "custom" && spec.dateFrom && spec.dateTo && spec.dateFrom > spec.dateTo
      ? "Start date is after end date."
      : undefined;
  const emptyTemplate = spec.layout.kind === "custom" && spec.layout.template.length === 0;

  let reason: string | null = null;
  if (loaded && !canDownload) reason = 'Turn on "Can start downloads" for this phone in Settings on the PC.';
  else if (!accountInput.trim()) reason = "Enter an account first";
  else if (accountError) reason = "Fix the account first";
  else if (hint?.kind === "reserved") reason = "Choose a different folder name in Advanced → Folder name";
  else if (folderError) reason = "Fix the folder name first";
  else if (dateError) reason = dateError;
  else if (emptyTemplate) reason = "Enter a folder template first";

  const advancedChanged =
    changedAdvancedKeys({ ...spec.advanced, parallel }, defaults.cookies).length +
    (folderTrimmed ? 1 : 0) +
    (caughtUp !== defaultCaughtUp ? 1 : 0);

  function patchSpec(patch: Partial<JobSpec>) {
    setSpec((current) => ({ ...current, ...patch }));
  }

  function resetNotes() {
    setError(null);
    setStartedNote(null);
  }

  function onSite(next: SiteId) {
    resetNotes();
    setPostId(null);
    patchSpec({ site: next });
  }

  function onAccountInput(raw: string) {
    resetNotes();
    setPostId(spec.site === "x" ? (xPostOf(raw)?.postId ?? null) : null);
    const parsed = spec.site !== "url" && /[/.]/.test(raw) ? validateAccount(spec.site, raw) : null;
    setAccountInput(parsed?.ok ? parsed.account : raw);
  }

  function onDatePreset(preset: DatePreset) {
    setDatePreset(preset);
    if (preset !== "custom") patchSpec({ dateFrom: undefined, dateTo: undefined, ...datePresetRange(preset, new Date()) });
  }

  function onLayoutKind(kind: LayoutKind) {
    patchSpec({ layout: layoutFor(kind, templateText) });
  }

  function onTemplateText(text: string) {
    setTemplateText(text);
    if (spec.layout.kind === "custom") patchSpec({ layout: layoutFor("custom", text) });
  }

  async function submit(simulate: boolean) {
    if (reason !== null || pending !== null || !loaded) return;
    resetNotes();
    setPending(simulate ? "preview" : "download");
    const result = await startDownload({ mode: "run", spec: { ...effectiveSpec, simulate } });
    setPending(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    const what = singlePost ? `post ${postId} from ${folderName}` : folderName;
    setStartedNote(simulate ? `Queued a preview of ${what}.` : `Queued ${what}.`);
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void submit(false);
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
        <p className="m-0 text-small text-ink-2">Runs on the PC and saves straight into your library.</p>
      </div>

      {loadError ? <Notice tone="danger">{loadError}</Notice> : null}
      <MobilePermissionNotice loaded={loaded} canDownload={canDownload} />

      <form onSubmit={onSubmit} className="flex flex-col gap-2">
        <RunForm
          spec={spec}
          accountInput={accountInput}
          accountError={accountError}
          hint={hint}
          folderName={folderName}
          onSite={onSite}
          onAccountInput={onAccountInput}
          onMedia={(media) => patchSpec({ media })}
          datePreset={datePreset}
          dateError={dateError}
          onDatePreset={onDatePreset}
          onDates={(dates) => patchSpec(dates)}
          onLayoutKind={onLayoutKind}
          templateText={templateText}
          onTemplateText={onTemplateText}
          onAdvanced={(patch: Partial<Advanced>) => patchSpec({ advanced: { ...spec.advanced, ...patch } })}
          cookiesDefault={defaults.cookies}
          folderOverride={folderOverride}
          folderError={folderError}
          onFolderChange={setFolderOverride}
          caughtUp={caughtUp}
          caughtUpChanged={caughtUp !== defaultCaughtUp}
          onCaughtUpChange={setCaughtUpChoice}
          onCaughtUpReset={() => setCaughtUpChoice(null)}
          advancedChanged={advancedChanged}
          parallelBlock={parallelReason}
          linkRuns={false}
        />

        {spec.site === "x" && postId ? (
          <div className="border-t border-line py-4">
            <Switch
              label="Only this post"
              hint={
                onlyPost
                  ? `Downloads post ${postId} only, into ${folderName}/.`
                  : `Downloads every post from @${account || "this account"}.`
              }
              checked={onlyPost}
              onChange={setOnlyPost}
            />
          </div>
        ) : null}

        {error ? <Notice tone="danger">{error}</Notice> : null}
        {startedNote ? <Notice tone="info">{startedNote}</Notice> : null}

        <div className="flex flex-col gap-2 border-t border-line pt-4">
          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant="secondary"
              className="min-h-11 w-full"
              loading={pending === "preview"}
              disabled={reason !== null || pending !== null || !loaded}
              onClick={() => void submit(true)}
            >
              Preview files
            </Button>
            <Button
              type="submit"
              variant="primary"
              className="min-h-11 w-full"
              loading={pending === "download"}
              disabled={reason !== null || pending !== null || !loaded}
            >
              {hint?.kind === "active" ? "Queue" : "Download"}
            </Button>
          </div>
          {reason ? <p className="m-0 text-small text-ink-2">{reason}</p> : null}
        </div>
      </form>

      <MobileRunsList runs={runs} canDownload={canDownload} onStop={stopDownload} />
    </main>
  );
}
