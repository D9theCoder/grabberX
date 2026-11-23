"use client";

import { useEffect, useState, useTransition } from "react";
import { saveOfflineSettingsAction } from "@/app/settings/mobile-actions";
import { CheckIcon } from "@/components/icons";
import { Notice } from "@/components/ui/notice";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { TextField } from "@/components/ui/text-field";
import { formatBytes, formatCount } from "@/lib/format";
import type {
  OfflineEncoderStatus,
  OfflineEstimate,
  OfflineImageFormat,
  OfflineImageMaxEdge,
  OfflineSettings,
  OfflineSettingsPatch,
  OfflineVideoAudio,
  OfflineVideoAudioKbps,
  OfflineVideoEncoder,
  OfflineVideoMaxHeight,
} from "@/lib/offline";

function Saved() {
  return (
    <span className="inline-flex items-center gap-1 text-ink-2">
      <CheckIcon className="size-3" strokeWidth={2.25} />
      Saved
    </span>
  );
}

function formatEstimateSummary(estimate: OfflineEstimate, settings: OfflineSettings): string {
  const parts: string[] = [];
  if (estimate.imageCount > 0) {
    parts.push(`${formatCount(estimate.imageCount)} ${estimate.imageCount === 1 ? "image" : "images"}`);
  }
  if (estimate.videoCount > 0) {
    parts.push(`${formatCount(estimate.videoCount)} ${estimate.videoCount === 1 ? "video" : "videos"}`);
  }
  if (parts.length === 0) {
    if (estimate.thumbCount > 0) {
      return `About ${formatBytes(estimate.estimatedBytes)} for ${formatCount(estimate.thumbCount)} thumbnails only.`;
    }
    return "No files match these settings yet.";
  }
  const base = `About ${formatBytes(estimate.estimatedBytes)} for ${parts.join(" and ")}`;
  const prepared =
    estimate.cachedCount > 0
      ? ` · ${formatCount(estimate.cachedCount)} prepared (${formatBytes(estimate.cachedBytes)})`
      : "";
  const budgetNote = estimate.overPhoneBudget
    ? ` · phone keeps the newest ${formatBytes(settings.phoneBudgetMB * 1024 * 1024)}`
    : "";
  return `${base}${prepared}${budgetNote}.`;
}

/** The "Offline on phone" group on the Settings page. */
export function OfflineSettingsForm({
  initial,
  initialEstimate,
  initialEncoderStatus,
  availableAccounts,
}: {
  initial: OfflineSettings;
  initialEstimate: OfflineEstimate;
  initialEncoderStatus: OfflineEncoderStatus;
  availableAccounts: string[];
}) {
  const [settings, setSettings] = useState<OfflineSettings>(initial);
  const [estimate, setEstimate] = useState<OfflineEstimate>(initialEstimate);
  const [encoderStatus, setEncoderStatus] = useState<OfflineEncoderStatus>(initialEncoderStatus);
  const [draft, setDraft] = useState({
    newestCount: String(initial.newestCount),
    imageMaxKB: String(initial.image.maxKB),
    imageQuality: String(initial.image.quality),
    videoBitrateKbps: String(initial.video.bitrateKbps),
    videoCpuThreads: String(initial.video.cpuThreads),
    phoneBudgetMB: String(initial.phoneBudgetMB),
    pcCacheMB: String(initial.pcCacheMB),
  });
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, startBusy] = useTransition();

  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 1500);
    return () => clearTimeout(timer);
  }, [saved]);

  const accountMode = settings.accounts === "all" ? "all" : "selected";
  const selectedSet = new Set(
    settings.accounts === "all" ? [] : settings.accounts.map((name) => name.toLowerCase()),
  );

  const selectionPreset =
    settings.selection === "all"
      ? "all"
      : settings.newestCount === 50 || settings.newestCount === 200 || settings.newestCount === 500
        ? String(settings.newestCount)
        : "custom";

  function save(patch: OfflineSettingsPatch) {
    setError(null);
    startBusy(async () => {
      const result = await saveOfflineSettingsAction(patch);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const next = result.data.settings;
      setSettings(next);
      setEstimate(result.data.estimate);
      setEncoderStatus(result.data.encoderStatus);
      setDraft({
        newestCount: String(next.newestCount),
        imageMaxKB: String(next.image.maxKB),
        imageQuality: String(next.image.quality),
        videoBitrateKbps: String(next.video.bitrateKbps),
        videoCpuThreads: String(next.video.cpuThreads),
        phoneBudgetMB: String(next.phoneBudgetMB),
        pcCacheMB: String(next.pcCacheMB),
      });
      setSaved(true);
    });
  }

  function changeAccountMode(mode: string) {
    if (mode === "all") {
      save({ accounts: "all" });
    } else {
      const next = settings.accounts === "all" ? availableAccounts : settings.accounts;
      save({ accounts: next });
    }
  }

  function toggleAccount(folder: string, checked: boolean) {
    const current = settings.accounts === "all" ? [...availableAccounts] : [...settings.accounts];
    const key = folder.toLowerCase();
    const next = checked
      ? current.some((name) => name.toLowerCase() === key)
        ? current
        : [...current, folder]
      : current.filter((name) => name.toLowerCase() !== key);
    save({ accounts: next });
  }

  function changeSelectionPreset(value: string) {
    if (value === "all") {
      save({ selection: "all" });
    } else {
      const count = Number(value);
      save({ selection: "newest", newestCount: Number.isFinite(count) && count > 0 ? count : 200 });
    }
  }

  return (
    <section className="flex flex-col gap-6 border-t border-line pt-8" aria-labelledby="offline-title">
      <div className="flex items-center justify-between gap-3">
        <h2 id="offline-title" className="m-0 text-title">
          Offline on phone
        </h2>
        {saved ? (
          <span className="text-small">
            <Saved />
          </span>
        ) : null}
      </div>

      <Switch
        label="Allow offline sync on paired phones"
        checked={settings.enabled}
        disabled={busy}
        onChange={(enabled) => save({ enabled })}
        hint="Lets paired phones keep the library index, 320 px thumbnails, and reduced-quality offline copies while this PC is off. Cached files are visible to anyone who can unlock the phone."
      />

      <div className="flex flex-col gap-1 rounded-md border border-line bg-sunken px-3.5 py-2.5 text-small text-ink-2">
        <span className="tabular-nums text-ink">{formatEstimateSummary(estimate, settings)}</span>
        <span>
          {encoderStatus.ffmpegAvailable
            ? `Video encoder: ${encoderStatus.label}`
            : encoderStatus.label}
        </span>
      </div>

      <div className="flex flex-col gap-4 border-t border-line pt-4">
        <h3 className="m-0 text-label font-semibold text-ink">What to save</h3>

        <div className="flex flex-col gap-1.5">
          <span className="text-label">Accounts to include</span>
          <Segmented
            label="Accounts to include"
            size="sm"
            value={accountMode}
            onChange={changeAccountMode}
            options={[
              { value: "all", label: "All accounts" },
              { value: "selected", label: "Selected" },
            ]}
          />
        </div>

        {accountMode === "selected" ? (
          <div className="flex flex-col gap-1.5">
            {availableAccounts.length === 0 ? (
              <span className="text-small text-ink-2">No accounts in the library yet.</span>
            ) : (
              <ul className="m-0 flex max-h-52 list-none flex-col divide-y divide-line overflow-y-auto rounded-md border border-line bg-surface p-0">
                {availableAccounts.map((folder) => {
                  const checked = selectedSet.has(folder.toLowerCase());
                  return (
                    <li key={folder}>
                      <label className="flex min-h-10 cursor-pointer items-center justify-between gap-3 px-3 py-2 font-mono text-label text-ink">
                        <span className="min-w-0 truncate">{folder}</span>
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={busy}
                          onChange={(event) => toggleAccount(folder, event.target.checked)}
                          className="size-4 accent-ink"
                        />
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : null}

        <div className="flex flex-col gap-1.5">
          <span className="text-label">Files per account</span>
          <Segmented
            label="Files per account"
            size="sm"
            columns={4}
            value={selectionPreset === "custom" ? "200" : selectionPreset}
            onChange={changeSelectionPreset}
            options={[
              { value: "all", label: "All" },
              { value: "50", label: "50 newest" },
              { value: "200", label: "200 newest" },
              { value: "500", label: "500 newest" },
            ]}
          />
          <span className="text-small text-ink-2">
            Limit each account to its newest posts to keep phone storage predictable.
          </span>
        </div>

        {settings.selection === "newest" ? (
          <TextField
            label="Newest files per account"
            type="number"
            min={1}
            max={10000}
            value={draft.newestCount}
            hint="Enter any count from 1 to 10,000."
            onChange={(event) => setDraft({ ...draft, newestCount: event.target.value })}
            onBlur={() => {
              const value = Number(draft.newestCount);
              if (Number.isInteger(value) && value !== settings.newestCount) {
                save({ selection: "newest", newestCount: value });
              }
            }}
          />
        ) : null}

        <div className="flex flex-col divide-y divide-line border-y border-line">
          <Switch
            label="Include images"
            checked={settings.includeImages}
            disabled={busy}
            onChange={(includeImages) => save({ includeImages })}
            hint="Includes image listings and 320 px WebP thumbnails."
          />
          <Switch
            label="Include videos"
            checked={settings.includeVideos}
            disabled={busy}
            onChange={(includeVideos) => save({ includeVideos })}
            hint="Includes video listings and poster thumbnails when available."
          />
        </div>
      </div>

      {settings.includeImages ? (
        <div className="flex flex-col gap-4 border-t border-line pt-4">
          <h3 className="m-0 text-label font-semibold text-ink">Image copies</h3>

          <Switch
            label="Save full-size offline image copies"
            checked={settings.image.enabled}
            disabled={busy}
            onChange={(enabled) => save({ image: { enabled } })}
            hint="Resizes large images on this PC before sending them to the phone. Files already within limits are served as-is."
          />

          {settings.image.enabled ? (
            <>
              <div className="flex flex-col gap-1.5">
                <span className="text-label">Max image size</span>
                <Segmented
                  label="Max image size"
                  size="sm"
                  columns={2}
                  value={String(settings.image.maxEdge)}
                  onChange={(value) => {
                    const maxEdge: OfflineImageMaxEdge =
                      value === "original" ? "original" : (Number(value) as 1280 | 2048 | 2560);
                    save({ image: { maxEdge } });
                  }}
                  options={[
                    { value: "1280", label: "1280 px" },
                    { value: "2048", label: "2048 px" },
                    { value: "2560", label: "2560 px" },
                    { value: "original", label: "Original" },
                  ]}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <span className="text-label">Image format</span>
                <Segmented
                  label="Image format"
                  size="sm"
                  value={settings.image.format}
                  onChange={(value) => save({ image: { format: value as OfflineImageFormat } })}
                  options={[
                    { value: "webp", label: "WebP" },
                    { value: "jpeg", label: "JPEG" },
                  ]}
                />
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <TextField
                  label="Target max size (KB)"
                  type="number"
                  min={128}
                  max={2048}
                  value={draft.imageMaxKB}
                  hint="128–2048 KB. Quality steps down first, then dimensions."
                  onChange={(event) => setDraft({ ...draft, imageMaxKB: event.target.value })}
                  onBlur={() => {
                    const value = Number(draft.imageMaxKB);
                    if (Number.isInteger(value) && value !== settings.image.maxKB) {
                      save({ image: { maxKB: value } });
                    }
                  }}
                />
                <TextField
                  label="Starting quality"
                  type="number"
                  min={40}
                  max={95}
                  value={draft.imageQuality}
                  hint="40–95. Default is 80."
                  onChange={(event) => setDraft({ ...draft, imageQuality: event.target.value })}
                  onBlur={() => {
                    const value = Number(draft.imageQuality);
                    if (Number.isInteger(value) && value !== settings.image.quality) {
                      save({ image: { quality: value } });
                    }
                  }}
                />
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      {settings.includeVideos ? (
        <div className="flex flex-col gap-4 border-t border-line pt-4">
          <h3 className="m-0 text-label font-semibold text-ink">Video copies</h3>

          <Switch
            label="Save playable offline video copies"
            checked={settings.video.enabled}
            disabled={busy}
            onChange={(enabled) => save({ video: { enabled } })}
            hint="Transcodes videos to H.264 MP4 on this PC so they play offline on your phone."
          />

          {settings.video.enabled && !encoderStatus.ffmpegAvailable ? (
            <Notice tone="warning">{encoderStatus.label}</Notice>
          ) : null}

          {settings.video.enabled ? (
            <>
              <div className="flex flex-col gap-1.5">
                <span className="text-label">Max video height</span>
                <Segmented
                  label="Max video height"
                  size="sm"
                  columns={4}
                  value={String(settings.video.maxHeight)}
                  onChange={(value) =>
                    save({ video: { maxHeight: Number(value) as OfflineVideoMaxHeight } })
                  }
                  options={[
                    { value: "360", label: "360p" },
                    { value: "480", label: "480p" },
                    { value: "720", label: "720p" },
                    { value: "1080", label: "1080p" },
                  ]}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <span className="text-label">Video audio</span>
                <Segmented
                  label="Video audio"
                  size="sm"
                  value={settings.video.audio}
                  onChange={(value) => save({ video: { audio: value as OfflineVideoAudio } })}
                  options={[
                    { value: "keep", label: "Keep audio" },
                    { value: "drop", label: "No audio" },
                  ]}
                />
              </div>

              {settings.video.audio === "keep" ? (
                <div className="flex flex-col gap-1.5">
                  <span className="text-label">Audio bitrate</span>
                  <Segmented
                    label="Audio bitrate"
                    size="sm"
                    columns={3}
                    value={String(settings.video.audioKbps)}
                    onChange={(value) =>
                      save({ video: { audioKbps: Number(value) as OfflineVideoAudioKbps } })
                    }
                    options={[
                      { value: "64", label: "64 kbps" },
                      { value: "96", label: "96 kbps" },
                      { value: "128", label: "128 kbps" },
                    ]}
                  />
                </div>
              ) : null}

              <div className="flex flex-col gap-1.5">
                <span className="text-label">Video encoder</span>
                <Segmented
                  label="Video encoder"
                  size="sm"
                  columns={3}
                  value={settings.video.encoder}
                  onChange={(value) => save({ video: { encoder: value as OfflineVideoEncoder } })}
                  options={[
                    { value: "auto", label: "Auto" },
                    { value: "gpu", label: "GPU" },
                    { value: "cpu", label: "CPU" },
                  ]}
                />
                <span className="text-small text-ink-2">{encoderStatus.label}</span>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <TextField
                  label="Video bitrate (kbps)"
                  type="number"
                  min={400}
                  max={4000}
                  value={draft.videoBitrateKbps}
                  hint="400–4000 kbps. Default is 1200."
                  onChange={(event) => setDraft({ ...draft, videoBitrateKbps: event.target.value })}
                  onBlur={() => {
                    const value = Number(draft.videoBitrateKbps);
                    if (Number.isInteger(value) && value !== settings.video.bitrateKbps) {
                      save({ video: { bitrateKbps: value } });
                    }
                  }}
                />
                <TextField
                  label="CPU threads"
                  type="number"
                  min={1}
                  max={16}
                  value={draft.videoCpuThreads}
                  hint="Used when encoding on CPU (libx264)."
                  onChange={(event) => setDraft({ ...draft, videoCpuThreads: event.target.value })}
                  onBlur={() => {
                    const value = Number(draft.videoCpuThreads);
                    if (Number.isInteger(value) && value !== settings.video.cpuThreads) {
                      save({ video: { cpuThreads: value } });
                    }
                  }}
                />
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-col gap-4 border-t border-line pt-4">
        <h3 className="m-0 text-label font-semibold text-ink">Limits and behaviour</h3>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <TextField
            label="Phone storage limit (MB)"
            type="number"
            min={500}
            max={20000}
            value={draft.phoneBudgetMB}
            hint="500–20,000 MB. Phone keeps the newest files up to this cap."
            onChange={(event) => setDraft({ ...draft, phoneBudgetMB: event.target.value })}
            onBlur={() => {
              const value = Number(draft.phoneBudgetMB);
              if (Number.isInteger(value) && value !== settings.phoneBudgetMB) {
                save({ phoneBudgetMB: value });
              }
            }}
          />
          <TextField
            label="PC cache limit (MB)"
            type="number"
            min={256}
            max={100000}
            value={draft.pcCacheMB}
            hint="Oldest prepared copies on this PC are evicted past this cap."
            onChange={(event) => setDraft({ ...draft, pcCacheMB: event.target.value })}
            onBlur={() => {
              const value = Number(draft.pcCacheMB);
              if (Number.isInteger(value) && value !== settings.pcCacheMB) {
                save({ pcCacheMB: value });
              }
            }}
          />
        </div>

        <div className="flex flex-col divide-y divide-line border-y border-line">
          <Switch
            label="Only prepare while plugged in"
            checked={settings.onlyWhenPluggedIn}
            disabled={busy}
            onChange={(onlyWhenPluggedIn) => save({ onlyWhenPluggedIn })}
            hint="Pauses image and video preparation while a laptop is on battery. Desktop PCs are always treated as plugged in."
          />
          <Switch
            label="Prepare copies in the background"
            checked={settings.prepareInBackground}
            disabled={busy}
            onChange={(prepareInBackground) => save({ prepareInBackground })}
            hint="Pre-builds offline copies newest-first while this PC is idle. When off, copies are built on demand when your phone syncs."
          />
        </div>
      </div>

      {error ? <Notice tone="danger">{error}</Notice> : null}
    </section>
  );
}
