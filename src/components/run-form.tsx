"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { AdvancedFields } from "@/components/advanced-fields";
import { ChoiceList } from "@/components/ui/choice-list";
import { Disclosure } from "@/components/ui/disclosure";
import { Notice } from "@/components/ui/notice";
import { Segmented } from "@/components/ui/segmented";
import { TextField } from "@/components/ui/text-field";
import { formatBytes, formatCount, formatRelative, truncateMiddle } from "@/lib/format";
import { LAYOUT_LABELS, detectedLayoutOf, layoutPathPreview, layoutSummary } from "@/lib/form-helpers";
import type { DatePreset, LayoutKind } from "@/lib/form-helpers";
import { SITES, siteDef } from "@/lib/sites";
import type { AccountHint, Advanced, JobSpec, Media, SiteId } from "@/lib/spec";

const LAYOUT_ORDER: LayoutKind[] = ["byType", "byTypeYear", "byMonth", "flat", "custom"];
const TEMPLATE_TOKENS = ["{date:%Y}", "{tweet_id}", "{num}", "{extension}", "{author[name]}"];

interface RunFormProps {
  spec: JobSpec;
  accountInput: string;
  accountError?: string;
  hint: AccountHint | null;
  folderName: string;
  onSite: (site: SiteId) => void;
  onAccountInput: (raw: string) => void;
  onMedia: (media: Media) => void;
  datePreset: DatePreset;
  dateError?: string;
  onDatePreset: (preset: DatePreset) => void;
  onDates: (patch: { dateFrom?: string; dateTo?: string }) => void;
  onLayoutKind: (kind: LayoutKind) => void;
  templateText: string;
  onTemplateText: (text: string) => void;
  onAdvanced: (patch: Partial<Advanced>) => void;
  cookiesDefault: Advanced["cookies"];
  folderOverride: string;
  folderError?: string;
  onFolderChange: (value: string) => void;
  caughtUp: boolean;
  caughtUpChanged: boolean;
  onCaughtUpChange: (value: boolean) => void;
  onCaughtUpReset: () => void;
  advancedChanged: number;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4 border-t border-line pt-8">
      <h2 className="m-0 text-title">{title}</h2>
      {children}
    </section>
  );
}

function hintText(hint: AccountHint | null): { text: ReactNode; error?: string } {
  switch (hint?.kind) {
    case "exists":
      return {
        text: (
          <>
            ✓ On disk · {formatCount(hint.files)} files · {formatBytes(hint.bytes)}
            {hint.lastRunAt ? ` · last run ${formatRelative(hint.lastRunAt)}` : ""}
          </>
        ),
      };
    case "new":
      return { text: `New account · will create ${truncateMiddle(hint.folder, 40)}/` };
    case "reserved":
      return {
        text: null,
        error: `"${hint.folder}" is used by the app itself. Choose a different folder name in Advanced → Folder name.`,
      };
    case "active":
      return {
        text: (
          <span className="text-warn">
            A run for this account is in progress.{" "}
            <Link href={`/history/${hint.runId}`} className="underline underline-offset-2">
              View run
            </Link>
          </span>
        ),
      };
    case "invalid":
      return { text: null, error: hint.message };
    default:
      return { text: null };
  }
}

export function RunForm(props: RunFormProps) {
  const { spec } = props;
  const site = siteDef(spec.site);
  const isUrl = spec.site === "url";
  const accountHint = hintText(props.hint);
  const layoutMismatch =
    props.hint?.kind === "exists" &&
    props.hint.layout !== "unknown" &&
    props.hint.layout !== detectedLayoutOf(spec.layout);

  return (
    <div className="flex min-w-0 flex-col gap-8">
      <Section title="Source">
        <Segmented
          label="Site"
          scrollOnNarrow
          value={spec.site}
          onChange={(value) => props.onSite(value as SiteId)}
          options={SITES.map((entry) => ({
            value: entry.id,
            label: entry.label,
            tag: entry.beta ? "beta" : undefined,
          }))}
        />
        <TextField
          label={isUrl ? "Page URL" : "Account"}
          mono
          prefix={site.prefix || undefined}
          placeholder={site.placeholder}
          value={props.accountInput}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          error={props.accountError ?? accountHint.error}
          hint={accountHint.text}
          onChange={(event) => props.onAccountInput(event.target.value)}
        />
      </Section>

      <Section title="Media">
        <Segmented
          label="Media"
          value={spec.media}
          onChange={(value) => props.onMedia(value as Media)}
          options={[
            { value: "images", label: "Images", title: "jpg, jpeg, png, webp" },
            { value: "videos", label: "Videos", title: "mp4, webm, mov, m4v" },
            { value: "all", label: "All", title: "Images first, then videos, in one run" },
          ]}
        />
      </Section>

      <Section title="Dates">
        <Segmented
          label="Dates"
          size="sm"
          value={props.datePreset}
          onChange={(value) => props.onDatePreset(value as DatePreset)}
          options={[
            { value: "all", label: "All time" },
            { value: "30d", label: "Last 30 days" },
            { value: "year", label: "This year" },
            { value: "custom", label: "Custom" },
          ]}
        />
        {props.datePreset === "custom" ? (
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-start">
            <TextField
              label="From"
              type="date"
              value={spec.dateFrom ?? ""}
              error={props.dateError}
              onChange={(event) => props.onDates({ dateFrom: event.target.value || undefined, dateTo: spec.dateTo })}
            />
            <span
              aria-hidden="true"
              className="hidden h-10 items-center justify-center pt-[26px] text-ink-2 sm:flex"
            >
              →
            </span>
            <TextField
              label="To"
              type="date"
              value={spec.dateTo ?? ""}
              onChange={(event) => props.onDates({ dateFrom: spec.dateFrom, dateTo: event.target.value || undefined })}
            />
          </div>
        ) : null}
        <p className="m-0 text-small text-ink-2">Uses the post date, not the download date.</p>
      </Section>

      <Section title="Folders">
        <ChoiceList
          legend="Folder layout"
          value={spec.layout.kind}
          onChange={(value) => props.onLayoutKind(value as LayoutKind)}
          options={LAYOUT_ORDER.map((kind) => ({
            value: kind,
            label: LAYOUT_LABELS[kind],
            detail: kind === "custom" ? `${props.folderName}/<your template>/` : layoutSummary({ kind }, props.folderName),
          }))}
        />
        {spec.layout.kind === "custom" ? (
          <div className="flex flex-col gap-2">
            <TextField
              label="Template"
              mono
              value={props.templateText}
              placeholder="{date:%Y}/{tweet_id}"
              hint="Folders inside the account folder, separated by /."
              onChange={(event) => props.onTemplateText(event.target.value)}
            />
            <div className="flex flex-wrap gap-1.5" aria-label="Template keys">
              {TEMPLATE_TOKENS.map((token) => (
                <button
                  key={token}
                  type="button"
                  onClick={() =>
                    props.onTemplateText(props.templateText ? `${props.templateText}/${token}` : token)
                  }
                  className="h-8 rounded-sm border border-line-strong px-2 font-mono text-small text-ink-2 hover:border-ink-2 hover:text-ink"
                >
                  {token}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <p className="m-0 truncate font-mono text-code text-ink" title={layoutPathPreview(spec.layout, props.folderName, "image")}>
          {truncateMiddle(layoutPathPreview(spec.layout, props.folderName, "image"), 56)}
        </p>
        {layoutMismatch ? (
          <Notice tone="warning">
            Existing files use a different layout. They won&apos;t be moved. New files go to the new layout, and
            nothing is downloaded twice.
          </Notice>
        ) : null}
      </Section>

      <Disclosure
        title="Advanced"
        meta={props.advancedChanged > 0 ? `${props.advancedChanged} changed` : undefined}
      >
        <AdvancedFields
          advanced={spec.advanced}
          onChange={props.onAdvanced}
          cookiesDefault={props.cookiesDefault}
          supportsSize={site.supportsSize}
          isX={spec.site === "x"}
          folder={props.folderOverride}
          folderError={props.folderError}
          onFolderChange={props.onFolderChange}
          caughtUp={props.caughtUp}
          caughtUpChanged={props.caughtUpChanged}
          onCaughtUpChange={props.onCaughtUpChange}
          onCaughtUpReset={props.onCaughtUpReset}
        />
      </Disclosure>
    </div>
  );
}
