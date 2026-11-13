"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

const DISMISS_KEY = "gather-m-install-dismissed";

function isStandaloneMode(): boolean {
  if (typeof window === "undefined") return false;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return window.matchMedia?.("(display-mode: standalone)")?.matches === true || nav.standalone === true;
}

/**
 * Registers the mobile gallery service worker (/m/sw.js), offers an in-app Install button when the browser
 * fires `beforeinstallprompt`, and shows a quiet status banner when the phone loses network connectivity.
 */
export function MobilePwa() {
  const pathname = usePathname();
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [standalone, setStandalone] = useState(false);
  const [offline, setOffline] = useState(false);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    setStandalone(isStandaloneMode());
    setOffline(!window.navigator.onLine);
    try {
      if (window.sessionStorage.getItem(DISMISS_KEY) === "1") {
        setDismissed(true);
      }
    } catch {
      // sessionStorage can throw in restricted browser modes; ignore.
    }

    if ("serviceWorker" in window.navigator && window.isSecureContext) {
      void window.navigator.serviceWorker.register("/m/sw.js", { scope: "/m" }).catch(() => {});
    }

    function onBeforeInstallPrompt(event: Event) {
      event.preventDefault();
      if (isStandaloneMode()) return;
      setDeferredPrompt(event as BeforeInstallPromptEvent);
    }

    function onAppInstalled() {
      setDeferredPrompt(null);
      setStandalone(true);
    }

    function onOnline() {
      setOffline(false);
    }

    function onOffline() {
      setOffline(true);
    }

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onAppInstalled);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onAppInstalled);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  if (pathname === "/m/pair") return null;

  async function handleInstall() {
    if (!deferredPrompt || installing) return;
    setInstalling(true);
    try {
      await deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      setDeferredPrompt(null);
      if (choice?.outcome === "dismissed") {
        dismiss();
      }
    } catch {
      setDeferredPrompt(null);
    } finally {
      setInstalling(false);
    }
  }

  function dismiss() {
    setDismissed(true);
    try {
      window.sessionStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // ignore
    }
  }

  const showInstall = Boolean(deferredPrompt) && !dismissed && !standalone;
  if (!showInstall && !offline) return null;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-3 pt-[max(0.75rem,env(safe-area-inset-top))] sm:px-6">
      {offline ? (
        <div
          role="status"
          aria-live="polite"
          className="rounded-md border border-line-strong bg-sunken px-3 py-2 text-small text-ink-2"
        >
          Offline · waiting for your connection to the PC.
        </div>
      ) : null}
      {showInstall ? (
        <section
          aria-label="Install app"
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line-strong bg-surface px-3 py-2.5"
        >
          <span className="text-small text-ink">Add grabberX gallery to your home screen.</span>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={dismiss}>
              Not now
            </Button>
            <Button size="sm" variant="primary" loading={installing} onClick={handleInstall}>
              Install app
            </Button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
