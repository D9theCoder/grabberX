"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { GearIcon } from "@/components/icons";
import { cn } from "@/lib/cn";

const RELEASES_URL = "https://github.com/D9theCoder/grabberX/releases/latest";

const LINKS = [
  { href: "/", label: "Run" },
  { href: "/library", label: "Library" },
  { href: "/history", label: "History" },
] as const;

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

export function TopBar() {
  const pathname = usePathname();
  const [inBrowser, setInBrowser] = useState(false);
  // Checked after mount so the server render and hydration match; the desktop app is already the download.
  useEffect(() => setInBrowser(window.gatherShell === undefined), []);

  return (
    <header className="border-b border-line">
      <nav
        aria-label="Main"
        className="mx-auto flex h-14 w-full max-w-[1120px] items-stretch gap-6 px-4 sm:px-8"
      >
        <Link href="/" className="flex items-center font-mono text-code font-normal text-ink">
          gather
        </Link>
        <div className="flex items-stretch gap-1">
          {LINKS.map((link) => {
            const active = isActive(pathname, link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-w-10 items-center justify-center border-b-2 px-3 text-label transition-colors duration-120",
                  active ? "border-ink text-ink" : "border-transparent text-ink-2 hover:text-ink",
                )}
              >
                {link.label}
              </Link>
            );
          })}
        </div>
        <div className="ml-auto flex items-stretch gap-4">
          {inBrowser && (
            // A quiet link on one line: at 390 px the old bordered button wrapped to three lines
            // and pushed the page wider than the screen, so it waits for 640 px.
            <a
              href={RELEASES_URL}
              target="_blank"
              rel="noreferrer"
              className="hidden self-center text-small text-ink-2 underline underline-offset-2 transition-colors duration-120 hover:text-ink sm:inline"
            >
              Get the desktop app
            </a>
          )}
          <Link
            href="/settings"
            aria-label="Settings"
            aria-current={isActive(pathname, "/settings") ? "page" : undefined}
            className={cn(
              "flex min-w-10 items-center justify-center border-b-2 px-2 transition-colors duration-120",
              isActive(pathname, "/settings") ? "border-ink text-ink" : "border-transparent text-ink-2 hover:text-ink",
            )}
          >
            <GearIcon className="size-5" />
          </Link>
        </div>
      </nav>
    </header>
  );
}
