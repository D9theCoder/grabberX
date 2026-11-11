"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SlidersIcon } from "@/components/icons";
import { cn } from "@/lib/cn";

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
        <Link
          href="/settings"
          aria-label="Settings"
          aria-current={isActive(pathname, "/settings") ? "page" : undefined}
          className={cn(
            "ml-auto flex min-w-10 items-center justify-center border-b-2 px-2 transition-colors duration-120",
            isActive(pathname, "/settings") ? "border-ink text-ink" : "border-transparent text-ink-2 hover:text-ink",
          )}
        >
          <SlidersIcon className="size-5" />
        </Link>
      </nav>
    </header>
  );
}
