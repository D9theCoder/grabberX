"use client";

import { usePathname } from "next/navigation";
import { TopBar } from "@/components/top-bar";

/** The phone pages under /m have their own header; the desktop bar would also poll routes the gateway blocks. */
export function DesktopChrome() {
  const pathname = usePathname();
  if (pathname === "/m" || pathname.startsWith("/m/")) return null;
  return <TopBar />;
}
