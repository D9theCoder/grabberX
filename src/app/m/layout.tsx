import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { MobilePwa } from "@/components/mobile/mobile-pwa";

export const metadata: Metadata = {
  title: "grabberX gallery",
  description: "Your grabberX library on this phone.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "grabberX gallery",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: "/m-icons/icon-192.png",
    apple: "/m-icons/icon-192.png",
  },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0b0c" },
  ],
};

export default function MobileLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh pb-[env(safe-area-inset-bottom)]">
      <MobilePwa />
      {children}
    </div>
  );
}
