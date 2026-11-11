"use client";

import type { ReactNode } from "react";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { TextField } from "@/components/ui/text-field";
import type { Advanced, CookieBrowser } from "@/lib/spec";

interface AdvancedFieldsProps {
  advanced: Advanced;
  onChange: (patch: Partial<Advanced>) => void;
  cookiesDefault: Advanced["cookies"];
  supportsSize: boolean;
  isX: boolean;
  folder: string;
  folderError?: string;
  onFolderChange: (value: string) => void;
  caughtUp: boolean;
  onCaughtUpChange: (value: boolean) => void;
}

function Hint({ text, changed, onReset }: { text?: string; changed: boolean; onReset: () => void }) {
  if (!changed) return text ?? null;
  return (
    <>
      {text ? `${text} ` : null}
      <span>
        Changed ·{" "}
        <button type="button" onClick={onReset} className="underline underline-offset-2 hover:text-ink">
          Reset
        </button>
      </span>
    </>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-4 pt-4">
      <h3 className="m-0 text-title">{title}</h3>
      {children}
    </div>
  );
}

function parseNumber(raw: string): number | undefined {
  if (raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function AdvancedFields({
  advanced,
  onChange,
  cookiesDefault,
  supportsSize,
  isX,
  folder,
  folderError,
  onFolderChange,
  caughtUp,
  onCaughtUpChange,
}: AdvancedFieldsProps) {
  const numberField = (
    key: "sleepRequest" | "sleep" | "sleep429" | "retries" | "range",
    label: string,
    hint: string,
    placeholder: string,
  ) => (
    <TextField
      label={label}
      type="number"
      inputMode="decimal"
      min={0}
      step={key === "retries" || key === "range" ? 1 : "any"}
      placeholder={placeholder}
      value={advanced[key] ?? ""}
      onChange={(event) => onChange({ [key]: parseNumber(event.target.value) })}
      hint={<Hint text={hint} changed={advanced[key] !== undefined} onReset={() => onChange({ [key]: undefined })} />}
    />
  );

  const textField = (
    key: "filesizeMin" | "filesizeMax" | "limitRate" | "proxy",
    label: string,
    hint: string,
    placeholder: string,
  ) => (
    <TextField
      label={label}
      mono
      placeholder={placeholder}
      value={advanced[key] ?? ""}
      onChange={(event) => onChange({ [key]: event.target.value.trim() === "" ? undefined : event.target.value })}
      hint={<Hint text={hint} changed={Boolean(advanced[key])} onReset={() => onChange({ [key]: undefined })} />}
    />
  );

  return (
    <div className="flex flex-col gap-8">
      <Block title="Quality">
        {supportsSize ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-label">Image size</span>
            <Segmented
              label="Image size"
              size="sm"
              value={advanced.imageSize}
              onChange={(value) => onChange({ imageSize: value as Advanced["imageSize"] })}
              options={[
                { value: "orig", label: "Original" },
                { value: "large", label: "Large" },
                { value: "medium", label: "Medium" },
              ]}
            />
            <span className="text-small text-ink-2">
              Original is the full file the artist uploaded (X caps at 4096 px).
            </span>
          </div>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          {textField("filesizeMin", "Min file size", "e.g. 200k, 5M", "")}
          {textField("filesizeMax", "Max file size", "e.g. 200k, 5M", "")}
        </div>
        {isX ? (
          <>
            <Switch
              label="Include retweets"
              checked={advanced.retweets}
              onChange={(retweets) => onChange({ retweets })}
            />
            <Switch
              label="Include replies"
              checked={advanced.replies}
              onChange={(replies) => onChange({ replies })}
            />
          </>
        ) : null}
      </Block>

      <Block title="Pace and limits">
        <div className="grid gap-4 sm:grid-cols-2">
          {numberField(
            "sleepRequest",
            "Wait between pages (s)",
            "Slows page loading. The only setting that helps against rate limits.",
            "0",
          )}
          {numberField("sleep", "Wait between files (s)", "Slows downloads, not page loading.", "0")}
          {numberField("sleep429", "Wait after rate limit (s)", "Empty uses the gallery-dl default.", "default")}
          {numberField("retries", "Retries", "Empty uses 4.", "4")}
          {textField("limitRate", "Bandwidth cap", "e.g. 2M", "none")}
          {numberField("range", "Only the newest N files", "Useful for a quick test.", "all")}
        </div>
        <Switch
          label="Stop when caught up"
          hint="Stops after 20 files in a row are already saved. Makes updates fast."
          checked={caughtUp}
          onChange={onCaughtUpChange}
        />
      </Block>

      <Block title="Output and session">
        <Switch
          label="Save metadata"
          hint="Writes a .json file beside each file."
          checked={advanced.writeMetadata}
          onChange={(writeMetadata) => onChange({ writeMetadata })}
        />
        <Switch
          label="Overwrite existing files"
          hint="Downloads everything again and replaces what is on disk. Use with care."
          checked={advanced.noSkip}
          onChange={(noSkip) => onChange({ noSkip })}
        />
        <div className="flex flex-col gap-1.5">
          <span className="text-label">Cookies from</span>
          <Segmented
            label="Cookies from"
            size="sm"
            value={advanced.cookies.browser}
            onChange={(browser) => onChange({ cookies: { ...advanced.cookies, browser: browser as CookieBrowser } })}
            options={[
              { value: "firefox", label: "Firefox" },
              { value: "chrome", label: "Chrome" },
              { value: "edge", label: "Edge" },
              { value: "none", label: "None" },
            ]}
          />
          <span className="text-small text-ink-2">
            {advanced.cookies.browser === cookiesDefault.browser
              ? "From Settings."
              : `Settings use ${cookiesDefault.browser}.`}
          </span>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Folder name"
            mono
            value={folder}
            placeholder="account handle"
            error={folderError}
            hint="Overrides the account folder. Needed for reserved names."
            onChange={(event) => onFolderChange(event.target.value)}
          />
          {textField("proxy", "Proxy", "e.g. http://127.0.0.1:8080", "none")}
        </div>
      </Block>
    </div>
  );
}
