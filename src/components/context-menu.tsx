"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { BackIcon, CopyIcon, ForwardIcon, ReloadIcon } from "@/components/icons";
import { cn } from "@/lib/cn";

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export type MenuEntry = MenuItem | "separator";

interface MenuState {
  x: number;
  y: number;
  label: string;
  entries: MenuEntry[];
}

type Point = { clientX: number; clientY: number; currentTarget?: EventTarget | null; target?: EventTarget | null };

interface ContextMenuApi {
  /** Opens the app menu at the pointer, or beside the element for a keyboard-opened menu. */
  open: (event: Point, label: string, entries: MenuEntry[]) => void;
  close: () => void;
}

const MenuContext = createContext<ContextMenuApi | null>(null);

const EDGE = 8;

/** Text fields keep the browser's own menu: cut, copy, paste and spelling belong there. */
export function keepsNativeMenu(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']") !== null;
}

/** A keyboard-opened menu (Menu key, Shift+F10) reports 0,0 or the element's corner; anchor it to the element instead. */
function anchorOf(event: Point): { x: number; y: number } {
  const element = (event.currentTarget ?? event.target) as Element | null;
  if (event.clientX === 0 && event.clientY === 0 && element instanceof Element) {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + Math.min(24, rect.width / 2), y: rect.top + Math.min(24, rect.height / 2) };
  }
  return { x: event.clientX, y: event.clientY };
}

export function useContextMenu(): ContextMenuApi {
  const api = useContext(MenuContext);
  if (!api) throw new Error("useContextMenu needs ContextMenuRoot.");
  return api;
}

/** Wraps a handler so it replaces the browser menu with `entries` (computed lazily, at the moment of the click). */
export function useMenuHandler(label: string, entries: () => MenuEntry[]) {
  const menu = useContextMenu();
  return useCallback(
    (event: ReactMouseEvent) => {
      if (keepsNativeMenu(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      menu.open(event, label, entries());
    },
    [menu, label, entries],
  );
}

function pageEntries(): MenuEntry[] {
  const selected = window.getSelection()?.toString() ?? "";
  const entries: MenuEntry[] = [];
  if (selected.trim() !== "") {
    entries.push(
      { label: "Copy", icon: <CopyIcon />, shortcut: "Ctrl+C", onSelect: () => void navigator.clipboard.writeText(selected) },
      "separator",
    );
  }
  entries.push(
    { label: "Back", icon: <BackIcon />, shortcut: "Alt+←", onSelect: () => window.history.back() },
    { label: "Forward", icon: <ForwardIcon />, shortcut: "Alt+→", onSelect: () => window.history.forward() },
    { label: "Reload", icon: <ReloadIcon />, shortcut: "F5", onSelect: () => window.location.reload() },
  );
  return entries;
}

export function ContextMenuRoot({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  const close = useCallback(() => {
    setMenu(null);
    setPosition(null);
    const target = returnFocus.current;
    returnFocus.current = null;
    if (target?.isConnected) target.focus({ preventScroll: true });
  }, []);

  const open = useCallback((event: Point, label: string, entries: MenuEntry[]) => {
    if (entries.length === 0) return;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const { x, y } = anchorOf(event);
    setPosition(null);
    setMenu({ x, y, label, entries });
  }, []);

  const api = useMemo(() => ({ open, close }), [open, close]);

  // Everything nobody else handled: the page menu instead of the browser's. Listening on window runs after
  // React's own handlers (attached at the root), so a tile that opened its menu has already prevented default.
  useEffect(() => {
    function onContextMenu(event: MouseEvent) {
      if (event.defaultPrevented || keepsNativeMenu(event.target)) return;
      event.preventDefault();
      open(event, "Page", pageEntries());
    }
    window.addEventListener("contextmenu", onContextMenu);
    return () => window.removeEventListener("contextmenu", onContextMenu);
  }, [open]);

  useLayoutEffect(() => {
    if (!menu || !panel.current) return;
    const { width, height } = panel.current.getBoundingClientRect();
    const left = menu.x + width + EDGE > window.innerWidth ? Math.max(EDGE, menu.x - width) : menu.x;
    const top = menu.y + height + EDGE > window.innerHeight ? Math.max(EDGE, menu.y - height) : menu.y;
    setPosition({ left, top });
  }, [menu]);

  // Focus moves in once the panel is placed and visible; a hidden element cannot take focus.
  useEffect(() => {
    if (position) panel.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
  }, [position]);

  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node)) close();
    };
    const dismiss = () => close();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [menu, close]);

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const items = Array.from(panel.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []);
    const at = items.indexOf(document.activeElement as HTMLElement);
    let next: HTMLElement | undefined;
    if (event.key === "ArrowDown") next = items[(at + 1) % items.length];
    else if (event.key === "ArrowUp") next = items[(at - 1 + items.length) % items.length];
    else if (event.key === "Home") next = items[0];
    else if (event.key === "End") next = items.at(-1);
    else if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      close();
      return;
    } else return;
    event.preventDefault();
    next?.focus();
  }

  return (
    <MenuContext.Provider value={api}>
      {children}
      {menu ? (
        <div
          ref={panel}
          role="menu"
          aria-label={menu.label}
          onKeyDown={onKeyDown}
          onContextMenu={(event) => event.preventDefault()}
          style={{ left: position?.left ?? menu.x, top: position?.top ?? menu.y, visibility: position ? "visible" : "hidden" }}
          className="fixed z-[60] flex min-w-52 max-w-80 flex-col rounded-md border border-line-strong bg-surface p-1 text-ink"
        >
          {menu.entries.map((entry, index) =>
            entry === "separator" ? (
              <div key={`separator-${index}`} role="separator" className="mx-1.5 my-1 h-px bg-line" />
            ) : (
              <button
                key={entry.label}
                type="button"
                role="menuitem"
                disabled={entry.disabled}
                onClick={() => {
                  close();
                  entry.onSelect();
                }}
                className={cn(
                  "grid h-9 grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-x-2.5 rounded-sm px-2.5 text-left text-label font-normal outline-none",
                  "hover:bg-sunken focus-visible:bg-sunken disabled:cursor-not-allowed disabled:bg-transparent disabled:text-ink-3",
                  "[&_svg]:size-4",
                  entry.danger ? "text-danger" : "text-ink [&_svg]:text-ink-2",
                )}
              >
                <span className="flex items-center">{entry.icon}</span>
                <span className="truncate">{entry.label}</span>
                {entry.shortcut ? <kbd className="font-mono text-log text-ink-2">{entry.shortcut}</kbd> : <span />}
              </button>
            ),
          )}
        </div>
      ) : null}
    </MenuContext.Provider>
  );
}
