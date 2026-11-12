"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { GrabberXShell, UpdateState } from "@/lib/shell";
import { cn } from "@/lib/cn";
import { updateCopy } from "@/lib/update-copy";

/** Settings → About: a manual update check for the desktop app, live while it downloads. */
export function AppUpdate({ shell }: { shell: GrabberXShell }) {
  const [state, setState] = useState<UpdateState>({ state: "idle" });
  const [installing, setInstalling] = useState(false);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let alive = true;
    void shell.getUpdateState?.().then((current) => {
      if (alive && current) setState(current);
    });
    const stop = shell.onUpdateState?.((next) => {
      setNow(new Date());
      setState(next);
    });
    const clock = setInterval(() => setNow(new Date()), 60_000);
    return () => {
      alive = false;
      stop?.();
      clearInterval(clock);
    };
  }, [shell]);

  if (!shell.checkForUpdate) return null;

  const copy = updateCopy(state, now);
  const busy = state.state === "checking" || state.state === "downloading";

  async function check() {
    const next = await shell.checkForUpdate?.();
    if (next) setState(next);
  }

  async function install() {
    setInstalling(true);
    const started = await shell.installUpdate?.();
    if (!started) setInstalling(false);
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        {state.state === "ready" ? (
          <Button variant="primary" loading={installing} onClick={() => void install()}>
            Restart and update
          </Button>
        ) : (
          <Button
            variant="secondary"
            loading={busy}
            disabled={state.state === "unavailable"}
            onClick={() => void check()}
          >
            Check for updates
          </Button>
        )}
      </div>
      <span role="status" className={cn("text-small", copy.tone === "danger" ? "text-danger" : "text-ink-2")}>
        {copy.text}
      </span>
    </div>
  );
}
