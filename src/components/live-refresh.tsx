"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { RUNS_CHANGED_EVENT } from "@/lib/task-list";

const REFRESH_MS = 2000;

/** Re-renders the server page every 2 s while it shows an active run, so counts and status stay current. */
export function LiveRefresh({ active }: { active: boolean }) {
  const router = useRouter();

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    window.addEventListener(RUNS_CHANGED_EVENT, refresh);
    document.addEventListener("visibilitychange", refresh);
    const timer = active ? setInterval(refresh, REFRESH_MS) : undefined;
    return () => {
      window.removeEventListener(RUNS_CHANGED_EVENT, refresh);
      document.removeEventListener("visibilitychange", refresh);
      clearInterval(timer);
    };
  }, [active, router]);

  return null;
}
