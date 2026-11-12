"use client";

import { useCallback, useEffect, useState } from "react";

export type ThemePreference = "system" | "light" | "dark";
export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "gather-theme";
const CHANGE_EVENT = "gather-theme-change";
const DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * Runs in <head> before the first paint, so a reload never flashes the wrong theme.
 * Kept as plain ES5 in a string: it executes before any bundle loads.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var p=localStorage.getItem("${THEME_STORAGE_KEY}");var d=p==="dark"||(p!=="light"&&matchMedia("${DARK_QUERY}").matches);var r=document.documentElement;r.dataset.theme=d?"dark":"light";r.style.colorScheme=d?"dark":"light";}catch(e){}})();`;

export function readPreference(): ThemePreference {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    return saved === "light" || saved === "dark" ? saved : "system";
  } catch {
    return "system";
  }
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): Theme {
  if (preference === "system") return systemDark ? "dark" : "light";
  return preference;
}

function systemDark(): boolean {
  return typeof matchMedia === "function" && matchMedia(DARK_QUERY).matches;
}

function paint(theme: Theme, animate: boolean) {
  const root = document.documentElement;
  if (root.dataset.theme === theme) return;
  const swap = () => {
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
  };
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (animate && !reduced && typeof document.startViewTransition === "function") {
    document.startViewTransition(swap);
  } else {
    swap();
  }
  void window.gatherShell?.setTheme?.(theme);
}

export function setThemePreference(preference: ThemePreference) {
  try {
    if (preference === "system") localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    /* private mode: the choice lasts for this page only */
  }
  paint(resolveTheme(preference, systemDark()), true);
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

/**
 * The saved preference and the theme on screen. Both start as "system"/"light" on the server and the first
 * client render, then catch up after mount, so hydration matches.
 */
export function useTheme() {
  const [preference, setPreference] = useState<ThemePreference>("system");
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    const sync = () => {
      const next = readPreference();
      setPreference(next);
      setTheme(resolveTheme(next, systemDark()));
    };
    sync();
    const media = matchMedia(DARK_QUERY);
    const onSystem = () => {
      if (readPreference() === "system") paint(resolveTheme("system", media.matches), true);
      sync();
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY) return;
      paint(resolveTheme(readPreference(), systemDark()), false);
      sync();
    };
    media.addEventListener("change", onSystem);
    window.addEventListener(CHANGE_EVENT, sync);
    window.addEventListener("storage", onStorage);
    void window.gatherShell?.setTheme?.(resolveTheme(readPreference(), media.matches));
    return () => {
      media.removeEventListener("change", onSystem);
      window.removeEventListener(CHANGE_EVENT, sync);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const choose = useCallback((next: ThemePreference) => setThemePreference(next), []);
  return { preference, theme, choose };
}
