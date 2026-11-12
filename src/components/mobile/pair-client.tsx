"use client";

import { useEffect, useRef, useState } from "react";

type State = { kind: "working" } | { kind: "failed"; message: string };

/** Reads the pairing code from the part of the address after "#", which the browser never sends to a server. */
export function PairClient() {
  const [state, setState] = useState<State>({ kind: "working" });
  const started = useRef(false);

  useEffect(() => {
    // React Strict Mode runs effects twice in development. The code is single use and leaves the address bar on
    // the first run, so the second run must not start over.
    if (started.current) return;
    started.current = true;
    const token = window.location.hash.replace(/^#/, "").trim();
    // Drop the code from the address bar and history straight away, whatever happens next.
    window.history.replaceState(null, "", window.location.pathname);
    if (token === "") {
      setState({ kind: "failed", message: "This page needs the code from the QR code. Scan it again from the PC." });
      return;
    }
    fetch("/m/api/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then(async (response) => {
        if (response.ok) {
          window.location.replace("/m");
          return;
        }
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setState({ kind: "failed", message: body?.error ?? "Pairing failed. Make a new code on the PC." });
      })
      .catch(() => {
        setState({ kind: "failed", message: "Couldn't reach the PC. Check that you're on the same network." });
      });
  }, []);

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-3 p-6">
      <h1 className="m-0 text-title">{state.kind === "working" ? "Pairing…" : "Couldn't pair"}</h1>
      <p className="m-0 text-body text-ink-2" role={state.kind === "failed" ? "alert" : "status"}>
        {state.kind === "working" ? "Connecting this phone to your PC." : state.message}
      </p>
    </main>
  );
}
