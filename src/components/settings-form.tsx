"use client";

import { useEffect, useState, useTransition } from "react";
import type { ReactNode } from "react";
import {
  checkGalleryDl,
  checkGalleryDlUpdate,
  saveSettingsAction,
  updateGalleryDl,
} from "@/app/actions";
import { CheckIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { Segmented } from "@/components/ui/segmented";
import { TextField } from "@/components/ui/text-field";
import { LAYOUT_LABELS } from "@/lib/form-helpers";
import { useShell } from "@/lib/shell";
import type { CookieBrowser, Media, Settings } from "@/lib/spec";

type FieldKey = "galleryDlPath" | "mediaRoot" | "cookies" | "profile" | "defaultMedia" | "defaultLayout" | "historyRetention" | "concurrency";

function Saved() {
  return (
    <span className="inline-flex items-center gap-1 text-ink-2">
      <CheckIcon className="size-3" strokeWidth={2.25} />
      Saved
    </span>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4 border-t border-line pt-8">
      <h2 className="m-0 text-title">{title}</h2>
      {children}
    </section>
  );
}

export function SettingsForm({ initial, appVersion }: { initial: Settings; appVersion: string }) {
  const shell = useShell();
  const [update, setUpdate] = useState<{ tone: "info" | "danger"; text: string; canUpdate?: boolean } | null>(null);
  const [checkingUpdate, startCheckUpdate] = useTransition();
  const [updating, startUpdate] = useTransition();
  const [settings, setSettings] = useState(initial);
  const [draft, setDraft] = useState({
    galleryDlPath: initial.galleryDlPath,
    mediaRoot: initial.mediaRoot,
    profile: initial.cookies.profile ?? "",
    historyRetention: String(initial.historyRetention),
  });
  const [saved, setSaved] = useState<FieldKey | null>(null);
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [check, setCheck] = useState<{ tone: "info" | "danger"; text: string } | null>(null);
  const [checking, startCheck] = useTransition();

  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(null), 1500);
    return () => clearTimeout(timer);
  }, [saved]);

  async function save(key: FieldKey, patch: Partial<Settings>) {
    const result = await saveSettingsAction(patch);
    if (result.ok) {
      setSettings(result.data);
      setErrors((current) => ({ ...current, [key]: undefined }));
      setSaved(key);
    } else {
      setErrors((current) => ({ ...current, [key]: result.error }));
    }
  }

  function onCheck() {
    setCheck(null);
    startCheck(async () => {
      const result = await checkGalleryDl(draft.galleryDlPath);
      setCheck(
        result.ok
          ? { tone: "info", text: `Found gallery-dl ${result.data.version}.` }
          : { tone: "danger", text: result.error },
      );
    });
  }

  async function browseMediaRoot() {
    const picked = await shell?.pickFolder(draft.mediaRoot);
    if (!picked || picked === settings.mediaRoot) return;
    setDraft((current) => ({ ...current, mediaRoot: picked }));
    await save("mediaRoot", { mediaRoot: picked });
  }

  function onCheckUpdate() {
    setUpdate(null);
    startCheckUpdate(async () => {
      const result = await checkGalleryDlUpdate();
      setUpdate(
        result.ok
          ? { tone: "info", text: result.data.message, canUpdate: !result.data.upToDate }
          : { tone: "danger", text: result.error },
      );
    });
  }

  function onUpdate() {
    startUpdate(async () => {
      const result = await updateGalleryDl();
      setUpdate(
        result.ok
          ? { tone: "info", text: `Updated. Now running gallery-dl ${result.data.version}.` }
          : { tone: "danger", text: result.error },
      );
    });
  }

  return (
    <div className="flex max-w-2xl flex-col gap-8">
      <h1 className="m-0 text-display">Settings</h1>

      <Group title="gallery-dl">
        <div className="flex items-start gap-2">
          <TextField
            label="gallery-dl path"
            mono
            className="flex-1"
            value={draft.galleryDlPath}
            error={errors.galleryDlPath}
            hint={saved === "galleryDlPath" ? <Saved /> : "The standalone gallery-dl.exe."}
            onChange={(event) => setDraft({ ...draft, galleryDlPath: event.target.value })}
            onBlur={() => draft.galleryDlPath !== settings.galleryDlPath && save("galleryDlPath", { galleryDlPath: draft.galleryDlPath })}
          />
          <Button variant="secondary" className="mt-[26px]" loading={checking} onClick={onCheck}>
            Check
          </Button>
        </div>
        {check ? <Notice tone={check.tone}>{check.text}</Notice> : null}
        <div className="flex items-start gap-2">
          <TextField
            label="Media root"
            mono
            className="flex-1"
            value={draft.mediaRoot}
            error={errors.mediaRoot}
            hint={saved === "mediaRoot" ? <Saved /> : "Account folders live here. Defaults to the app folder."}
            onChange={(event) => setDraft({ ...draft, mediaRoot: event.target.value })}
            onBlur={() => draft.mediaRoot !== settings.mediaRoot && save("mediaRoot", { mediaRoot: draft.mediaRoot })}
          />
          {shell ? (
            <Button variant="secondary" className="mt-[26px]" onClick={browseMediaRoot}>
              Browse…
            </Button>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" loading={checkingUpdate} onClick={onCheckUpdate}>
            Look for updates
          </Button>
          {update?.canUpdate ? (
            <Button variant="primary" loading={updating} onClick={onUpdate}>
              Update now
            </Button>
          ) : null}
        </div>
        {update ? <Notice tone={update.tone}>{update.text}</Notice> : null}
      </Group>

      <Group title="Session">
        <div className="flex flex-col gap-1.5">
          <span className="text-label">Cookies from</span>
          <Segmented
            label="Cookies from"
            size="sm"
            value={settings.cookies.browser}
            onChange={(browser) =>
              save("cookies", { cookies: { ...settings.cookies, browser: browser as CookieBrowser } })
            }
            options={[
              { value: "firefox", label: "Firefox" },
              { value: "chrome", label: "Chrome" },
              { value: "edge", label: "Edge" },
              { value: "none", label: "None" },
            ]}
          />
          <span className="text-small text-ink-2">
            {saved === "cookies" ? <Saved /> : "Sign in to the site in this browser first. gallery-dl reads its cookies on every run."}
          </span>
        </div>
        <TextField
          label="Browser profile"
          mono
          placeholder="default"
          value={draft.profile}
          error={errors.cookies}
          hint={saved === "profile" ? <Saved /> : "Optional. Leave empty for the default profile."}
          onChange={(event) => setDraft({ ...draft, profile: event.target.value })}
          onBlur={() =>
            draft.profile !== (settings.cookies.profile ?? "") &&
            save("profile", { cookies: { ...settings.cookies, profile: draft.profile.trim() || undefined } })
          }
        />
      </Group>

      <Group title="Defaults for new runs">
        <div className="flex flex-col gap-1.5">
          <span className="text-label">Media</span>
          <Segmented
            label="Default media"
            size="sm"
            value={settings.defaultMedia}
            onChange={(value) => save("defaultMedia", { defaultMedia: value as Media })}
            options={[
              { value: "images", label: "Images" },
              { value: "videos", label: "Videos" },
              { value: "all", label: "All" },
            ]}
          />
          {saved === "defaultMedia" ? <span className="text-small"><Saved /></span> : null}
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-label">Folder layout</span>
          <Segmented
            label="Default folder layout"
            size="sm"
            value={settings.defaultLayout.kind}
            onChange={(kind) =>
              save("defaultLayout", { defaultLayout: { kind } as Settings["defaultLayout"] })
            }
            options={(["byType", "byTypeYear", "byMonth", "flat"] as const).map((kind) => ({
              value: kind,
              label: LAYOUT_LABELS[kind],
            }))}
          />
          {saved === "defaultLayout" ? <span className="text-small"><Saved /></span> : null}
        </div>
      </Group>

      <Group title="About">
        <p className="m-0 text-label">gather {appVersion}</p>
        {shell ? (
          <div>
            <Button variant="secondary" onClick={() => void shell.openLogs()}>
              Open the logs folder
            </Button>
          </div>
        ) : null}
        <span className="text-small text-ink-2">
          gallery-dl is a separate program by Mike Fährmann, licensed GPL-2.0 (github.com/mikf/gallery-dl).
          gather runs it for you and does not change it.
        </span>
      </Group>

      <Group title="Runs">
        <TextField
          label="History retention (runs)"
          type="number"
          min={10}
          max={2000}
          value={draft.historyRetention}
          error={errors.historyRetention}
          hint={saved === "historyRetention" ? <Saved /> : "Older run records and logs are deleted. Downloaded files are never touched."}
          onChange={(event) => setDraft({ ...draft, historyRetention: event.target.value })}
          onBlur={() =>
            Number(draft.historyRetention) !== settings.historyRetention &&
            save("historyRetention", { historyRetention: Number(draft.historyRetention) })
          }
        />
        <div className="flex flex-col gap-1.5">
          <span className="text-label">Runs at the same time</span>
          <Segmented
            label="Runs at the same time"
            size="sm"
            value={String(settings.concurrency)}
            onChange={(value) => save("concurrency", { concurrency: Number(value) })}
            options={["1", "2", "3"]}
          />
          <span className="text-small text-ink-2">
            {saved === "concurrency" ? (
              <Saved />
            ) : (
              "Runs share one X session and one rate limit, so more at once mostly means more waiting. Never two runs on the same account."
            )}
          </span>
        </div>
      </Group>
    </div>
  );
}
