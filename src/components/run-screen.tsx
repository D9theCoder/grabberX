"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import type { KeyboardEvent } from "react";
import { accountHint, checkCookies, runAgain, startRun } from "@/app/actions";
import { CommandPanel } from "@/components/command-panel";
import { RunForm } from "@/components/run-form";
import { RunPanel } from "@/components/run-panel";
import { Notice } from "@/components/ui/notice";
import { Status } from "@/components/ui/status";
import { useRunStream } from "@/components/use-run-stream";
import { buildCommand, formatCommand } from "@/lib/command";
import { browserLabel, cookieNotice, cookieSiteLabel } from "@/lib/cookie-check";
import type { CookieCheckKind } from "@/lib/cookie-check";
import { changedAdvancedKeys, datePresetRange, templateToSegments } from "@/lib/form-helpers";
import type { DatePreset, LayoutKind } from "@/lib/form-helpers";
import { formatCount } from "@/lib/format";
import { isActiveStatus } from "@/lib/run-copy";
import { FOLDER_PATTERN, folderNameFor, siteDef, validateAccount } from "@/lib/sites";
import { createDefaultSpec } from "@/lib/spec";
import type { AccountHint, Advanced, JobSpec, Layout, Settings, SiteId } from "@/lib/spec";

const CAUGHT_UP_AFTER = 20;
const HINT_DEBOUNCE_MS = 300;
const DEFAULT_TEMPLATE = "{date:%Y}";

interface RunScreenProps {
  settings: Settings;
  galleryDlFound: boolean;
  initialRunId: string | null;
  /** Prefills the account field, e.g. from the Library's "Use as new run". */
  initialAccount: string;
}

function layoutFor(kind: LayoutKind, templateText: string): Layout {
  return kind === "custom" ? { kind, template: templateToSegments(templateText) } : { kind };
}

export function RunScreen({
  settings,
  galleryDlFound,
  initialRunId,
  initialAccount,
}: RunScreenProps) {
  const [spec, setSpec] = useState<JobSpec>(() => createDefaultSpec(settings));
  const [accountInput, setAccountInput] = useState(initialAccount);
  const [datePreset, setDatePreset] = useState<DatePreset>("all");
  const [templateText, setTemplateText] = useState(
    settings.defaultLayout.kind === "custom" ? settings.defaultLayout.template.join("/") : DEFAULT_TEMPLATE,
  );
  const [folderOverride, setFolderOverride] = useState("");
  const [caughtUpChoice, setCaughtUpChoice] = useState<boolean | null>(null);
  const [remote, setRemote] = useState<{ key: string; hint: AccountHint } | null>(null);
  const [runId, setRunId] = useState<string | null>(initialRunId);
  const [queuedAhead, setQueuedAhead] = useState<number | null>(null);
  const [pending, setPending] = useState<"preview" | "download" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cookieCheck, setCookieCheck] = useState<CookieCheckKind | null>(null);
  const [, startSubmit] = useTransition();
  const [runAgainPending, startRunAgain] = useTransition();

  const stream = useRunStream(runId);

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
  const hint: AccountHint | null = account && remote?.key === hintKey ? remote.hint : null;

  useEffect(() => {
    if (!account) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const result = await accountHint({ site: spec.site, account, folder: folderTrimmed || undefined });
      if (!cancelled) setRemote({ key: hintKey, hint: result });
    }, HINT_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [spec.site, account, folderTrimmed, hintKey]);

  const defaultCaughtUp = hint?.kind === "exists";
  const caughtUp = caughtUpChoice ?? defaultCaughtUp;

  const effectiveSpec: JobSpec = {
    ...spec,
    account,
    folder: folderError ? undefined : folderTrimmed || undefined,
    advanced: { ...spec.advanced, abortAfterSkipped: caughtUp ? CAUGHT_UP_AFTER : undefined },
  };

  const previewAccount = account || (spec.site === "url" ? "https://example.com/" : site.placeholder);
  const previewSpec: JobSpec = { ...effectiveSpec, account: previewAccount };
  const folderName = folderNameFor(previewSpec);
  const steps = buildCommand(previewSpec, settings).map((step) => ({
    label: step.label,
    command: formatCommand(step.argv),
  }));

  const dateError =
    datePreset === "custom" && spec.dateFrom && spec.dateTo && spec.dateFrom > spec.dateTo
      ? "Start date is after end date."
      : undefined;
  const emptyTemplate = spec.layout.kind === "custom" && spec.layout.template.length === 0;

  let reason: string | null = null;
  if (!galleryDlFound) reason = "gallery-dl not found, check Settings";
  else if (!accountInput.trim()) reason = "Enter an account first";
  else if (accountError) reason = "Fix the account first";
  else if (hint?.kind === "reserved") reason = "Choose a different folder name in Advanced → Folder name";
  else if (folderError) reason = "Fix the folder name first";
  else if (dateError) reason = dateError;
  else if (emptyTemplate) reason = "Enter a folder template first";

  const advancedChanged =
    changedAdvancedKeys(spec.advanced, settings.cookies).length +
    (folderTrimmed ? 1 : 0) +
    (caughtUp !== defaultCaughtUp ? 1 : 0);

  const run = stream.run;
  const accountHasActiveRun = hint?.kind === "active";
  const queuedNote =
    run?.status === "queued" && queuedAhead !== null
      ? `Queued · ${formatCount(queuedAhead)} ahead`
      : null;

  function patchSpec(patch: Partial<JobSpec>) {
    setSpec((current) => ({ ...current, ...patch }));
  }

  function onAccountInput(raw: string) {
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

  // Runs beside the run request, never in front of it: the warning appears when it arrives, and
  // the run still starts because public accounts work without a login.
  function probeCookies() {
    if (spec.advanced.cookies.browser === "none" || !account) return;
    void checkCookies({ site: spec.site, account, cookies: spec.advanced.cookies })
      .then((result) => {
        if (result.ok) setCookieCheck(result.data.kind);
      })
      .catch(() => undefined);
  }

  function submit(simulate: boolean) {
    if (reason !== null || pending !== null) return;
    setError(null);
    setCookieCheck(null);
    probeCookies();
    setPending(simulate ? "preview" : "download");
    startSubmit(async () => {
      const result = await startRun({ ...effectiveSpec, simulate });
      if (result.ok) {
        setRunId(result.data.runId);
        setQueuedAhead(result.data.position);
      } else {
        setError(result.error);
      }
      setPending(null);
    });
  }

  function onRunAgain() {
    if (!run) return;
    startRunAgain(async () => {
      const result = await runAgain(run.id);
      if (result.ok) {
        setRunId(result.data.runId);
        setQueuedAhead(result.data.position);
      } else {
        setError(result.error);
      }
    });
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      submit(false);
    }
  }

  const barSummary =
    run && isActiveStatus(run.status) ? (
      <>
        <Status state={run.status}>
          {" · "}
          {folderNameFor(run.spec)}
        </Status>
        <span className="text-small text-ink-2">{formatCount(stream.counts.saved)} saved</span>
      </>
    ) : null;

  const cookieMessage = cookieCheck
    ? cookieNotice(cookieCheck, {
        browser: browserLabel(spec.advanced.cookies.browser),
        site: cookieSiteLabel(spec.site),
      })
    : null;

  return (
    <main onKeyDown={onKeyDown} className="pt-8 pb-40 lg:pb-10">
      {!galleryDlFound ? (
        <Notice
          tone="danger"
          className="mb-6"
          action={
            <Link href="/settings" className="font-medium underline underline-offset-2">
              Set the path
            </Link>
          }
        >
          gallery-dl wasn&apos;t found at {settings.galleryDlPath}.
        </Notice>
      ) : null}

      <h1 className="m-0 text-display">New run</h1>

      <div className="mt-5 grid gap-8 lg:grid-cols-[minmax(0,1fr)_400px]">
        <RunForm
          spec={spec}
          accountInput={accountInput}
          accountError={accountError}
          hint={hint}
          folderName={folderName}
          onSite={(next: SiteId) => patchSpec({ site: next })}
          onAccountInput={onAccountInput}
          onMedia={(media) => patchSpec({ media })}
          datePreset={datePreset}
          dateError={dateError}
          onDatePreset={onDatePreset}
          onDates={(dates) => patchSpec(dates)}
          onLayoutKind={onLayoutKind}
          templateText={templateText}
          onTemplateText={onTemplateText}
          onAdvanced={(patch: Partial<Advanced>) =>
            patchSpec({ advanced: { ...spec.advanced, ...patch } })
          }
          cookiesDefault={settings.cookies}
          folderOverride={folderOverride}
          folderError={folderError}
          onFolderChange={setFolderOverride}
          caughtUp={caughtUp}
          caughtUpChanged={caughtUp !== defaultCaughtUp}
          onCaughtUpChange={setCaughtUpChoice}
          onCaughtUpReset={() => setCaughtUpChoice(null)}
          advancedChanged={advancedChanged}
        />

        <aside className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-6 lg:self-start">
          <CommandPanel
            steps={steps}
            reason={reason}
            downloadLabel={accountHasActiveRun ? "Queue" : "Download"}
            pending={pending}
            error={error}
            queuedNote={queuedNote}
            notice={
              cookieMessage ? (
                <Notice
                  tone="warning"
                  action={
                    cookieCheck === "unreadable" ? (
                      <Link href="/settings" className="font-medium underline underline-offset-2">
                        Open Settings
                      </Link>
                    ) : undefined
                  }
                >
                  {cookieMessage}
                </Notice>
              ) : undefined
            }
            barSummary={barSummary}
            onPreview={() => submit(true)}
            onDownload={() => submit(false)}
          />
          <div id="run-panel" className="scroll-mt-6 rounded-lg border border-line-strong p-4">
            <RunPanel
              stream={stream}
              galleryDlPath={settings.galleryDlPath}
              onRunAgain={onRunAgain}
              runAgainPending={runAgainPending}
            />
          </div>
        </aside>
      </div>
    </main>
  );
}
