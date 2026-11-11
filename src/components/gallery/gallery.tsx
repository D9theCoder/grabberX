"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { FolderCard } from "@/components/gallery/folder-card";
import { sortFiles } from "@/components/gallery/format";
import type { KindFilter, SortKey } from "@/components/gallery/format";
import { centreOf, justify, nearestInRow, rowOfIndex, totalHeight, visibleRows } from "@/components/gallery/layout";
import { Lightbox } from "@/components/gallery/lightbox";
import { Thumbnail } from "@/components/gallery/thumbnail";
import type { FolderListing } from "@/components/gallery/types";
import { Segmented } from "@/components/ui/segmented";

// Matches the `space-1` token. The justified layout needs the number, so it cannot come from a class.
const GAP = 4;
const OVERSCAN = 600;
const VIDEO_ASPECT = 16 / 9;
const DEFAULT_ASPECT = 3 / 2;

export interface GalleryProps {
  account: string;
  path: string;
  listing: FolderListing;
  initialFile?: string;
}

export function folderHref(account: string, path: string): string {
  const base = `/library/${encodeURIComponent(account)}`;
  return path === "" ? base : `${base}?path=${encodeURIComponent(path)}`;
}

export function Gallery({ account, path, listing, initialFile }: GalleryProps) {
  const [kind, setKind] = useState<KindFilter>("all");
  const [sort, setSort] = useState<SortKey>("newest");
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [dimensions, setDimensions] = useState<Record<string, [number, number]>>({});
  const [width, setWidth] = useState(0);
  const [viewport, setViewport] = useState({ from: 0, to: 1200 });
  const [active, setActive] = useState(0);
  const [openName, setOpenName] = useState<string | null>(initialFile ?? null);

  const container = useRef<HTMLDivElement>(null);
  const wantFocus = useRef(false);

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
      .then((body: { dimensions?: Record<string, [number, number]> } | null) => {
        if (!cancelled && body?.dimensions) setDimensions(body.dimensions);
      })
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

  const updateViewport = useCallback(() => {
    const element = container.current;
    if (!element) return;
    const top = element.getBoundingClientRect().top + window.scrollY;
    setViewport({
      from: window.scrollY - top - OVERSCAN,
      to: window.scrollY + window.innerHeight - top + OVERSCAN,
    });
  }, []);

  useEffect(() => {
    let frame = 0;
    function onScroll() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(updateViewport);
    }
    updateViewport();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [updateViewport, width]);

  const targetHeight = width < 520 ? 120 : 200;
  const rows = useMemo(() => {
    const aspects = files.map((file) => {
      if (file.kind === "video") return VIDEO_ASPECT;
      const size = dimensions[file.name];
      return size ? size[0] / size[1] : DEFAULT_ASPECT;
    });
    return justify(aspects, width, targetHeight, GAP);
  }, [files, dimensions, width, targetHeight]);

  const shown = useMemo(() => visibleRows(rows, viewport.from, viewport.to), [rows, viewport]);
  const clampedActive = Math.min(active, Math.max(0, files.length - 1));

  useEffect(() => {
    if (!wantFocus.current) return;
    const tile = container.current?.querySelector<HTMLElement>(`[data-index="${clampedActive}"]`);
    if (tile) {
      tile.focus({ preventScroll: true });
      wantFocus.current = false;
    }
  }, [clampedActive, shown]);

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

  function onGridKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (files.length === 0 || event.altKey || event.ctrlKey || event.metaKey) return;
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
    moveTo(next);
  }

  const open = useCallback(
    (name: string | null) => {
      setOpenName(name);
      const url = new URL(window.location.href);
      if (name === null) url.searchParams.delete("file");
      else url.searchParams.set("file", name);
      window.history.replaceState(window.history.state, "", url);
    },
    [],
  );

  const openIndex = openName === null ? -1 : files.findIndex((file) => file.name === openName);

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
        onKeyDown={onGridKeyDown}
        className="relative"
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
                  onOpen={(position) => open(files[position]?.name ?? null)}
                  onActivate={setActive}
                />
              );
            })}
          </div>
        ))}
      </div>

      {openIndex >= 0 ? (
        <Lightbox
          account={account}
          path={path}
          files={files}
          index={openIndex}
          onIndexChange={(position) => open(files[position]?.name ?? null)}
          onClose={closeLightbox}
          onDeleted={onDeleted}
        />
      ) : null}
    </div>
  );
}
