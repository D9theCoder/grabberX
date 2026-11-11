"use client";

import { useEffect, useState } from "react";

/** Current time in ms, ticking while `active`. Starts at 0 so server and client render the same first frame. */
export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(0);

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);

  return now;
}
