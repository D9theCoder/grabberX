"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { useContextMenu } from "@/components/context-menu";
import type { MenuEntry } from "@/components/context-menu";
import {
  copyImage,
  copyPaths,
  deleteSelection,
  downloadFiles,
  openWithApp,
  showInFolder,
} from "@/components/gallery/file-actions";
import { FolderCard } from "@/components/gallery/folder-card";
import { sortFiles } from "@/components/gallery/format";
import type { KindFilter, SortKey } from "@/components/gallery/format";
import { ExpandIcon, TrashIcon } from "@/components/gallery/gallery-icons";
import { centreOf, justify, nearestInRow, rowOfIndex, totalHeight, visibleRows } from "@/components/gallery/layout";
import type { Row } from "@/components/gallery/layout";
import { Lightbox } from "@/components/gallery/lightbox";
import { Thumbnail } from "@/components/gallery/thumbnail";
import type { FolderListing, MediaFile } from "@/components/gallery/types";
import { CopyIcon, DownloadIcon, FolderIcon, OpenIcon, SelectIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { formatCount } from "@/lib/format";

// Matches the `space-1` token. The justified layout needs the number, so it cannot come from a class.
const GAP = 4;
const OVERSCAN = 900;
const VIDEO_ASPECT = 16 / 9;
const DEFAULT_ASPECT = 3 / 2;
const DRAG_THRESHOLD = 6;
const EDGE_SCROLL = 64;

export interface GalleryProps {
  account: string;
  path: string;
  listing: FolderListing;
  initialFile?: string;
  /** What the media index already knew when the page rendered, so the first layout is the real one. */
  initialDimensions?: Record<string, [number, number]>;
  initialDurations?: Record<string, number>;
}

export function folderHref(account: string, path: string): string {
  const base = `/library/${encodeURIComponent(account)}`;
  return path === "" ? base : `${base}?path=${encodeURIComponent(path)}`;
}

interface Marquee {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Tiles whose box touches the rectangle, from the layout alone, so tiles scrolled out of the DOM still count. */
function tilesIn(rows: readonly Row[], rect: Marquee): number[] {
  const left = Math.min(rect.x0, rect.x1);
  const right = Math.max(rect.x0, rect.x1);
  const hits: number[] = [];
  for (const row of visibleRows(rows, Math.min(rect.y0, rect.y1), Math.max(rect.y0, rect.y1))) {
    let x = 0;
    row.widths.forEach((width, offset) => {
      if (x < right && x + width > left) hits.push(row.start + offset);
      x += width + GAP;
    });
  }
  return hits;
}

export function Gallery({ account, path, listing, initialFile, initialDimensions, initialDurations }: GalleryProps) {
  const [kind, setKind] = useState<KindFilter>("all");
  const [sort, setSort] = useState<SortKey>("newest");
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [dimensions, setDimensions] = useState<Record<string, [number, number]>>(initialDimensions ?? {});
  const [durations, setDurations] = useState<Record<string, number>>(initialDurations ?? {});
  const [width, setWidth] = useState(0);
  const [range, setRange] = useState({ from: -OVERSCAN, to: 1200 + OVERSCAN });
  const [active, setActive] = useState(0);
  const [openName, setOpenName] = useState<string | null>(initialFile ?? null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  const [confirm, setConfirm] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const menu = useContextMenu();
  const container = useRef<HTMLDivElement>(null);
  const wantFocus = useRef(false);
  const anchor = useRef<number | null>(null);
  const drag = useRef<{
    pointer: number;
    startX: number;
    startY: number;
    clientX: number;
    clientY: number;
    base: ReadonlySet<string>;
    remove: boolean;
    moved: boolean;
    frame: number;
  } | null>(null);
  const suppressClick = useRef(false);

  const files = useMemo(() => {
    const visible = listing.files.filter(
      (file) => !removed.has(file.name) && (kind === "all" || file.kind === kind),
    );
    return sortFiles(visible, sort);
  }, [listing.files, removed, kind, sort]);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ account, path });
    void fetch(`/api/media/dims?${params.toString()}`)
      .then((response) => (response.ok ? response.json() : null))
      .then(
        (body: { dimensions?: Record<string, [number, number]>; durations?: Record<string, number> } | null) => {
          if (cancelled || !body) return;
          if (body.dimensions) setDimensions(body.dimensions);
          if (body.durations) setDurations(body.durations);
        },
      )
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [account, path]);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);

  const targetHeight = width < 520 ? 120 : 200;
  const rows = useMemo(() => {
    const aspects = files.map((file) => {
      if (file.kind === "video") return VIDEO_ASPECT;
      const size = dimensions[file.name];
      return size ? size[0] / size[1] : DEFAULT_ASPECT;
    });
    return justify(aspects, width, targetHeight, GAP);
  }, [files, dimensions, width, targetHeight]);

  // Scrolling re-renders only when the set of rows near the viewport changes, not on every frame.
  const updateRange = useCallback(() => {
    const element = container.current;
    if (!element) return;
    const top = element.getBoundingClientRect().top;
    const from = -top - OVERSCAN;
    const to = -top + window.innerHeight + OVERSCAN;
    const shownNow = visibleRows(rows, from, to);
    setRange((current) => {
      const before = visibleRows(rows, current.from, current.to);
      const same = before.length === shownNow.length && before[0]?.start === shownNow[0]?.start;
      return same ? current : { from, to };
    });
  }, [rows]);

  useEffect(() => {
    let frame = 0;
    function onScroll() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(updateRange);
    }
    updateRange();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [updateRange]);

  const shown = useMemo(() => visibleRows(rows, range.from, range.to), [rows, range]);
  const clampedActive = Math.min(active, Math.max(0, files.length - 1));

  useEffect(() => {
    if (!wantFocus.current) return;
    const tile = container.current?.querySelector<HTMLElement>(`[data-index="${clampedActive}"]`);
    if (tile) {
      tile.focus({ preventScroll: true });
      wantFocus.current = false;
    }
  }, [clampedActive, shown]);

  // A file that left the view (filter, delete) leaves the selection too.
  useEffect(() => {
    setSelected((current) => {
      if (current.size === 0) return current;
      const names = new Set(files.map((file) => file.name));
      const kept = [...current].filter((name) => names.has(name));
      return kept.length === current.size ? current : new Set(kept);
    });
  }, [files]);

  const open = useCallback((name: string | null) => {
    setOpenName(name);
    const url = new URL(window.location.href);
    if (name === null) url.searchParams.delete("file");
    else url.searchParams.set("file", name);
    window.history.replaceState(window.history.state, "", url);
  }, []);

  const openIndex = openName === null ? -1 : files.findIndex((file) => file.name === openName);

  function moveTo(next: number) {
    const target = Math.max(0, Math.min(files.length - 1, next));
    const row = rowOfIndex(rows, target);
    const element = container.current;
    if (row && element) {
      const top = element.getBoundingClientRect().top + window.scrollY + row.top;
      if (top < window.scrollY + 8 || top + row.height > window.scrollY + window.innerHeight - 8) {
        window.scrollTo({ top: top - window.innerHeight / 3 });
      }
    }
    wantFocus.current = true;
    setActive(target);
  }

  const startSelecting = useCallback((names: Iterable<string> = []) => {
    setSelecting(true);
    setSelected(new Set(names));
    setMessage("");
  }, []);

  const stopSelecting = useCallback(() => {
    setSelecting(false);
    setSelected(new Set());
    anchor.current = null;
  }, []);

  function toggle(name: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function selectRange(from: number, to: number) {
    const [low, high] = from < to ? [from, to] : [to, from];
    setSelected((current) => {
      const next = new Set(current);
      for (const file of files.slice(low, high + 1)) next.add(file.name);
      return next;
    });
  }

  const onPress = useCallback(
    (index: number, event: ReactMouseEvent) => {
      if (suppressClick.current) return;
      const file = files[index];
      if (!file) return;
      const modified = event.ctrlKey || event.metaKey || event.shiftKey;
      if (!selecting && !modified) {
        open(file.name);
        return;
      }
      if (!selecting) setSelecting(true);
      if (event.shiftKey && anchor.current !== null) selectRange(anchor.current, index);
      else toggle(file.name);
      anchor.current = index;
    },
    // selectRange and toggle only touch state setters and `files`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [files, selecting, open],
  );

  // ---- Drag to select -------------------------------------------------------------------------------

  function contentPoint(clientX: number, clientY: number) {
    const rect = container.current!.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  function applyDrag() {
    const state = drag.current;
    if (!state) return;
    const point = contentPoint(state.clientX, state.clientY);
    const rect = { x0: state.startX, y0: state.startY, x1: point.x, y1: point.y };
    setMarquee(rect);
    const hits = tilesIn(rows, rect).map((index) => files[index]?.name).filter((name): name is string => Boolean(name));
    const next = new Set(state.base);
    for (const name of hits) {
      if (state.remove) next.delete(name);
      else next.add(name);
    }
    setSelected(next);
  }

  function edgeScroll() {
    const state = drag.current;
    if (!state?.moved) return;
    let delta = 0;
    if (state.clientY < EDGE_SCROLL) delta = -Math.ceil((EDGE_SCROLL - state.clientY) / 4);
    else if (state.clientY > window.innerHeight - EDGE_SCROLL) delta = Math.ceil((state.clientY - (window.innerHeight - EDGE_SCROLL)) / 4);
    if (delta !== 0) {
      window.scrollBy(0, delta);
      applyDrag();
    }
    state.frame = requestAnimationFrame(edgeScroll);
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    // Touch keeps scrolling; drag-select is for a mouse or pen, in select mode.
    if (!selecting || event.button !== 0 || event.pointerType === "touch" || !container.current) return;
    const start = contentPoint(event.clientX, event.clientY);
    const tile = (event.target as Element).closest<HTMLElement>("[data-name]");
    const startName = tile?.dataset.name;
    drag.current = {
      pointer: event.pointerId,
      startX: start.x,
      startY: start.y,
      clientX: event.clientX,
      clientY: event.clientY,
      base: selected,
      // Starting on a tile that is already selected drags to deselect, the way photo apps do.
      remove: startName !== undefined && selected.has(startName),
      moved: false,
      frame: 0,
    };
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const state = drag.current;
    if (!state || event.pointerId !== state.pointer) return;
    state.clientX = event.clientX;
    state.clientY = event.clientY;
    if (!state.moved) {
      const point = contentPoint(event.clientX, event.clientY);
      if (Math.hypot(point.x - state.startX, point.y - state.startY) < DRAG_THRESHOLD) return;
      state.moved = true;
      container.current?.setPointerCapture(event.pointerId);
      document.getSelection()?.removeAllRanges();
      state.frame = requestAnimationFrame(edgeScroll);
    }
    applyDrag();
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const state = drag.current;
    if (!state || event.pointerId !== state.pointer) return;
    cancelAnimationFrame(state.frame);
    drag.current = null;
    setMarquee(null);
    if (state.moved) {
      // The click that follows a drag must not also toggle the tile it ended on.
      suppressClick.current = true;
      setTimeout(() => {
        suppressClick.current = false;
      }, 0);
    }
  }

  // ---- Actions ----------------------------------------------------------------------------------------

  const say = useCallback((text: string) => setMessage(text), []);

  const run = useCallback(
    (label: string, task: () => Promise<unknown>) => {
      void task().catch((error: unknown) => {
        console.error(error);
        say(`${label} didn't work.`);
      });
    },
    [say],
  );

  const singleEntries = useCallback(
    (file: MediaFile, inLightbox: boolean): MenuEntry[] => {
      const desktop = Boolean(window.gatherShell);
      const entries: MenuEntry[] = [];
      if (!inLightbox) entries.push({ label: "Open", icon: <ExpandIcon />, shortcut: "Enter", onSelect: () => open(file.name) });
      entries.push(
        {
          label: desktop ? "Open with default app" : "Open in new tab",
          icon: <OpenIcon />,
          onSelect: () => run("Opening the file", () => openWithApp(account, path, file.name)),
        },
        {
          label: desktop ? "Show in folder" : "Open account folder",
          icon: <FolderIcon />,
          onSelect: () => run("Opening the folder", () => showInFolder(account, path, file.name)),
        },
        "separator",
        { label: "Download", icon: <DownloadIcon />, onSelect: () => downloadFiles(account, path, [file.name]) },
      );
      if (file.kind === "image") {
        entries.push({
          label: "Copy image",
          icon: <CopyIcon />,
          onSelect: () => run("Copying the image", async () => {
            await copyImage(account, path, file.name);
            say("Image copied");
          }),
        });
      }
      entries.push({
        label: "Copy path",
        icon: <CopyIcon />,
        onSelect: () => run("Copying the path", async () => {
          await copyPaths(account, path, [file.name]);
          say("Path copied");
        }),
      });
      if (!inLightbox) {
        entries.push({
          label: selecting && selected.has(file.name) ? "Deselect" : "Select",
          icon: <SelectIcon />,
          shortcut: "Space",
          onSelect: () => (selecting ? toggle(file.name) : startSelecting([file.name])),
        });
        entries.push("separator", {
          label: "Delete",
          icon: <TrashIcon />,
          shortcut: "Del",
          danger: true,
          onSelect: () => setConfirm([file.name]),
        });
      }
      return entries;
    },
    // toggle only touches a state setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [account, path, open, run, say, selecting, selected, startSelecting],
  );

  const bulkEntries = useCallback(
    (names: string[]): MenuEntry[] => {
      const count = `${formatCount(names.length)} files`;
      return [
        { label: `Download ${count}`, icon: <DownloadIcon />, onSelect: () => downloadFiles(account, path, names) },
        {
          label: `Copy ${names.length} paths`,
          icon: <CopyIcon />,
          onSelect: () => run("Copying the paths", async () => say(`${formatCount(await copyPaths(account, path, names))} paths copied`)),
        },
        { label: "Clear selection", icon: <SelectIcon />, onSelect: () => setSelected(new Set()) },
        "separator",
        { label: `Delete ${count}`, icon: <TrashIcon />, shortcut: "Del", danger: true, onSelect: () => setConfirm(names) },
      ];
    },
    [account, path, run, say],
  );

  const onTileMenu = useCallback(
    (index: number, event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const file = files[index];
      if (!file) return;
      setActive(index);
      if (selecting && selected.size > 1 && selected.has(file.name)) {
        menu.open(event, `${selected.size} selected files`, bulkEntries([...selected]));
      } else {
        menu.open(event, file.name, singleEntries(file, false));
      }
    },
    [files, selecting, selected, menu, bulkEntries, singleEntries],
  );

  function onGridMenu(event: ReactMouseEvent) {
    if (event.defaultPrevented) return;
    event.preventDefault();
    menu.open(event, "Gallery", [
      { label: "Select all", icon: <SelectIcon />, shortcut: "Ctrl+A", onSelect: () => startSelecting(files.map((file) => file.name)) },
      selecting
        ? { label: "Leave select mode", icon: <SelectIcon />, shortcut: "Esc", onSelect: stopSelecting }
        : { label: "Select files", icon: <SelectIcon />, shortcut: "S", onSelect: () => startSelecting() },
      "separator",
      {
        label: "Download all",
        icon: <DownloadIcon />,
        disabled: files.length === 0,
        onSelect: () => downloadFiles(account, path, files.map((file) => file.name)),
      },
      {
        label: "Open account folder",
        icon: <FolderIcon />,
        onSelect: () =>
          run("Opening the folder", () =>
            fetch("/api/open-folder", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ folder: account }),
            }),
          ),
      },
    ]);
  }

  async function confirmDelete() {
    if (!confirm) return;
    setBusy(true);
    try {
      const outcome = await deleteSelection(account, path, confirm);
      if (outcome.deleted.length > 0) {
        setRemoved((current) => new Set([...current, ...outcome.deleted]));
        setSelected((current) => new Set([...current].filter((name) => !outcome.deleted.includes(name))));
      }
      say(
        outcome.error ??
          (outcome.deleted.length === 1 ? `Deleted ${outcome.deleted[0]}` : `Deleted ${formatCount(outcome.deleted.length)} files`),
      );
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  }

  function onGridKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (files.length === 0 || event.altKey) return;
    const current = files[clampedActive];
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      startSelecting(files.map((file) => file.name));
      return;
    }
    if (event.ctrlKey || event.metaKey) return;
    if (event.key === "Escape" && selecting) {
      event.preventDefault();
      stopSelecting();
      return;
    }
    if (event.key === " " && current) {
      event.preventDefault();
      if (!selecting) startSelecting([current.name]);
      else toggle(current.name);
      anchor.current = clampedActive;
      return;
    }
    if (event.key === "Delete" && current) {
      event.preventDefault();
      setConfirm(selecting && selected.size > 0 ? [...selected] : [current.name]);
      return;
    }
    if (event.key.toLowerCase() === "s" && !event.shiftKey) {
      event.preventDefault();
      if (selecting) stopSelecting();
      else startSelecting();
      return;
    }
    const row = rowOfIndex(rows, clampedActive);
    if (!row) return;
    let next: number | null = null;
    if (event.key === "ArrowRight") next = clampedActive + 1;
    else if (event.key === "ArrowLeft") next = clampedActive - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = files.length - 1;
    else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const target = rows[rows.indexOf(row) + (event.key === "ArrowDown" ? 1 : -1)];
      if (target) next = nearestInRow(target, centreOf(row, clampedActive, GAP), GAP);
    }
    if (next === null) return;
    event.preventDefault();
    if (event.shiftKey && selecting) {
      const target = Math.max(0, Math.min(files.length - 1, next));
      selectRange(anchor.current ?? clampedActive, target);
    }
    moveTo(next);
  }

  function closeLightbox() {
    if (openIndex >= 0) {
      wantFocus.current = true;
      setActive(openIndex);
    }
    open(null);
  }

  function onDeleted(name: string) {
    const position = files.findIndex((file) => file.name === name);
    setRemoved((current) => new Set(current).add(name));
    const remaining = files.filter((file) => file.name !== name);
    if (remaining.length === 0) {
      open(null);
      return;
    }
    open(remaining[Math.min(position, remaining.length - 1)]!.name);
  }

  const noMedia = listing.files.length === removed.size && listing.folders.length === 0;
  const selectedCount = selected.size;

  return (
    <div className="flex flex-col gap-6">
      {listing.folders.length > 0 ? (
        <section aria-label="Folders" className="flex flex-wrap gap-3">
          {listing.folders.map((folder) => (
            <FolderCard
              key={folder.name}
              name={folder.name}
              href={folderHref(account, path === "" ? folder.name : `${path}/${folder.name}`)}
            />
          ))}
        </section>
      ) : null}

      {listing.files.length > 0 ? (
        <div className="flex flex-wrap items-end justify-between gap-4">
          <Segmented
            label="Show"
            size="sm"
            value={kind}
            onChange={(value) => setKind(value as KindFilter)}
            options={[
              { value: "all", label: "All" },
              { value: "image", label: "Images" },
              { value: "video", label: "Videos" },
            ]}
          />
          <div className="flex flex-wrap items-end gap-3">
            <Segmented
              label="Sort by"
              size="sm"
              value={sort}
              onChange={(value) => setSort(value as SortKey)}
              options={[
                { value: "newest", label: "Newest first" },
                { value: "oldest", label: "Oldest first" },
                { value: "name", label: "Name" },
              ]}
            />
            <Button
              size="sm"
              variant={selecting ? "primary" : "secondary"}
              aria-pressed={selecting}
              onClick={() => (selecting ? stopSelecting() : startSelecting())}
              className="h-10"
            >
              <SelectIcon className="size-4" />
              {selecting ? "Done" : "Select"}
            </Button>
          </div>
        </div>
      ) : null}

      {noMedia ? (
        <p className="text-body text-ink-2">
          No files here yet.{" "}
          <Link
            href={path === "" ? "/library" : folderHref(account, "")}
            className="underline decoration-line-strong underline-offset-4 hover:text-ink"
          >
            {path === "" ? "Back to the library" : `Back to ${account}`}
          </Link>
        </p>
      ) : listing.files.length > 0 && files.length === 0 ? (
        <p className="text-body text-ink-2">Nothing matches this filter in this folder.</p>
      ) : null}

      <div
        ref={container}
        role="group"
        aria-label={`${files.length} files`}
        aria-multiselectable={selecting || undefined}
        onKeyDown={onGridKeyDown}
        onContextMenu={onGridMenu}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className={selecting ? "relative select-none" : "relative"}
        style={{ height: totalHeight(rows) }}
      >
        {shown.map((row) => (
          <div key={row.start} className="absolute left-0 flex" style={{ top: row.top, gap: GAP, height: row.height }}>
            {files.slice(row.start, row.end).map((file, offset) => {
              const index = row.start + offset;
              return (
                <Thumbnail
                  key={file.name}
                  file={file}
                  account={account}
                  path={path}
                  index={index}
                  width={row.widths[offset] ?? 0}
                  height={row.height}
                  active={index === clampedActive}
                  selecting={selecting}
                  selected={selected.has(file.name)}
                  duration={durations[file.name]}
                  onPress={onPress}
                  onActivate={setActive}
                  onMenu={onTileMenu}
                />
              );
            })}
          </div>
        ))}
        {marquee ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute z-10 border border-ink bg-ink/8"
            style={{
              left: Math.min(marquee.x0, marquee.x1),
              top: Math.min(marquee.y0, marquee.y1),
              width: Math.abs(marquee.x1 - marquee.x0),
              height: Math.abs(marquee.y1 - marquee.y0),
            }}
          />
        ) : null}
      </div>

      {selecting ? (
        <div
          role="toolbar"
          aria-label="Selection"
          className="sticky bottom-4 z-20 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-line-strong bg-surface py-2 pr-2 pl-4"
        >
          <span className="text-label font-semibold tabular-nums" aria-live="polite">
            {selectedCount === 0
              ? "Nothing selected"
              : `${formatCount(selectedCount)} ${selectedCount === 1 ? "file" : "files"} selected`}
          </span>
          <div className="flex gap-1">
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set(files.map((file) => file.name)))}>
              Select all
            </Button>
            <Button variant="ghost" size="sm" disabled={selectedCount === 0} onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          </div>
          <div className="ml-auto flex flex-wrap gap-1">
            <Button size="sm" disabled={selectedCount === 0} onClick={() => downloadFiles(account, path, [...selected])}>
              <DownloadIcon className="size-4" />
              Download
            </Button>
            <Button variant="danger" size="sm" disabled={selectedCount === 0} onClick={() => setConfirm([...selected])}>
              <TrashIcon className="size-4" />
              Delete
            </Button>
            <Button variant="ghost" size="sm" onClick={stopSelecting}>
              Done
            </Button>
          </div>
        </div>
      ) : null}

      <p role="status" aria-live="polite" className="m-0 min-h-[18px] text-small text-ink-2">
        {message}
      </p>

      {confirm ? (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-paper/80 p-4"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !busy) setConfirm(null);
          }}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="bulk-delete-title"
            aria-describedby="bulk-delete-body"
            className="w-full max-w-md rounded-lg border border-line-strong bg-surface p-6"
          >
            <h2 id="bulk-delete-title" className="m-0 text-title">
              {confirm.length === 1 ? `Delete ${confirm[0]}?` : `Delete ${formatCount(confirm.length)} files?`}
            </h2>
            <p id="bulk-delete-body" className="mt-2 mb-0 text-body text-ink-2">
              {confirm.length === 1
                ? window.gatherShell
                  ? "It moves to the Recycle Bin."
                  : "It is deleted for good."
                : window.gatherShell
                  ? "They move to the Recycle Bin."
                  : "They are deleted for good."}{" "}
              gather still remembers {confirm.length === 1 ? "it" : "them"} in the archive, so a later update will not
              download {confirm.length === 1 ? "it" : "them"} again.
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <Button variant="secondary" autoFocus onClick={() => setConfirm(null)} disabled={busy}>
                Cancel
              </Button>
              <Button variant="secondary" className="text-danger" loading={busy} onClick={() => void confirmDelete()}>
                Delete
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {openIndex >= 0 ? (
        <Lightbox
          account={account}
          path={path}
          files={files}
          index={openIndex}
          onIndexChange={(position) => open(files[position]?.name ?? null)}
          onClose={closeLightbox}
          onDeleted={onDeleted}
          menuEntries={(file) => singleEntries(file, true)}
        />
      ) : null}
    </div>
  );
}
