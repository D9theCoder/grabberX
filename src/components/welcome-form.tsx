"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { completeSetup } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { Segmented } from "@/components/ui/segmented";
import { TextField } from "@/components/ui/text-field";
import type { CookieBrowser } from "@/lib/spec";
import { useShell } from "@/lib/shell";

type GalleryDlStatus = { ok: true; version: string } | { ok: false; error: string };

export function WelcomeForm({
  defaultMediaRoot,
  defaultBrowser,
  galleryDl,
}: {
  defaultMediaRoot: string;
  defaultBrowser: CookieBrowser;
  galleryDl: GalleryDlStatus;
}) {
  const router = useRouter();
  const shell = useShell();
  const [mediaRoot, setMediaRoot] = useState(defaultMediaRoot);
  const [browser, setBrowser] = useState<CookieBrowser>(defaultBrowser);
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  async function browse() {
    const picked = await shell?.pickFolder(mediaRoot);
    if (picked) setMediaRoot(picked);
  }

  function finish() {
    setError(null);
    startSaving(async () => {
      const result = await completeSetup({ mediaRoot, browser });
      if (result.ok) router.replace("/");
      else setError(result.error);
    });
  }

  return (
    <div className="flex max-w-2xl flex-col gap-8">
      <div className="flex flex-col gap-2">
        <h1 className="m-0 text-display">Welcome to grabberX</h1>
        <p className="m-0 text-ink-2">
          Two choices and you can start. Everything stays on this computer.
        </p>
      </div>

      <section className="flex flex-col gap-4 border-t border-line pt-8">
        <h2 className="m-0 text-title">Where should downloads go?</h2>
        <div className="flex items-start gap-2">
          <TextField
            label="Library folder"
            mono
            className="flex-1"
            value={mediaRoot}
            hint="One folder per account is created inside it. It is created if it doesn't exist."
            onChange={(event) => setMediaRoot(event.target.value)}
          />
          {shell ? (
            <Button variant="secondary" className="mt-[26px]" onClick={browse}>
              Browse…
            </Button>
          ) : null}
        </div>
      </section>

      <section className="flex flex-col gap-4 border-t border-line pt-8">
        <h2 className="m-0 text-title">Which browser are you signed in to?</h2>
        <Segmented
          label="Cookies from"
          size="sm"
          value={browser}
          onChange={(value) => setBrowser(value as CookieBrowser)}
          options={[
            { value: "firefox", label: "Firefox" },
            { value: "chrome", label: "Chrome" },
            { value: "edge", label: "Edge" },
            { value: "none", label: "None" },
          ]}
        />
        <span className="text-small text-ink-2">
          Sign in to the site in that browser first. grabberX reads its cookies on every run and never copies them.
          If a browser can&apos;t be read, you can switch in Settings.
        </span>
      </section>

      <section className="flex flex-col gap-4 border-t border-line pt-8">
        <h2 className="m-0 text-title">gallery-dl</h2>
        {galleryDl.ok ? (
          <Notice tone="info">Found gallery-dl {galleryDl.version}.</Notice>
        ) : (
          <Notice tone="danger">
            {galleryDl.error} You can point to another copy in Settings after this step.
          </Notice>
        )}
      </section>

      {error ? <Notice tone="danger">{error}</Notice> : null}
      <div>
        <Button variant="primary" loading={saving} onClick={finish}>
          Get started
        </Button>
      </div>
    </div>
  );
}
