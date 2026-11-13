"use client";

import { useState } from "react";

export function ForgetButton() {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        if (!window.confirm("Forget this phone? You'll need a new QR code to view the gallery again.")) return;
        setBusy(true);
        if ("serviceWorker" in navigator && navigator.serviceWorker.controller) {
          navigator.serviceWorker.controller.postMessage({ type: "CLEAR_CACHE" });
        }
        await fetch("/m/api/logout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => {});
        window.location.replace("/m");
      }}
      className="min-h-11 text-small text-ink-2 underline decoration-line-strong underline-offset-4"
    >
      Forget this phone
    </button>
  );
}
