import type { Metadata } from "next";
import { Fragment_Mono, Schibsted_Grotesk } from "next/font/google";
import { ContextMenuRoot } from "@/components/context-menu";
import { DesktopChrome } from "@/components/desktop-chrome";
import { THEME_INIT_SCRIPT } from "@/lib/theme";
import "./globals.css";

const sans = Schibsted_Grotesk({
  variable: "--font-schibsted",
  subsets: ["latin"],
  display: "swap",
});

const mono = Fragment_Mono({
  variable: "--font-fragment",
  subsets: ["latin"],
  weight: "400",
  display: "swap",
});

export const metadata: Metadata = {
  title: "gather",
  description: "A local front end for gallery-dl.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // The theme script sets data-theme and color-scheme on <html> before React hydrates.
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-dvh bg-paper text-ink">
        <ContextMenuRoot>
          <DesktopChrome />
          <div className="mx-auto w-full max-w-[1120px] px-4 sm:px-8">{children}</div>
        </ContextMenuRoot>
      </body>
    </html>
  );
}
