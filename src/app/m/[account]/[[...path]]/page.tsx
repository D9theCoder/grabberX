import Link from "next/link";
import { MobileGallery } from "@/components/mobile/mobile-gallery";
import type { FolderListing } from "@/components/gallery/types";
import { listFolder, MediaPathError } from "@/server/media";
import { ZIP_MAX_BYTES, ZIP_MAX_FILES } from "@/server/zip";

// The gateway caps a phone's POST at 1 MB; each file name adds about 35 bytes, so 5,000 names is about 175 KB.
const PHONE_ZIP_FILES = Math.min(ZIP_MAX_FILES, 5000);

export const dynamic = "force-dynamic";

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export default async function MobileFolderPage({ params }: PageProps<"/m/[account]/[[...path]]">) {
  const { account: rawAccount, path: rawPath } = await params;
  const account = decode(rawAccount);
  const segments = (rawPath ?? []).map(decode);
  const path = segments.join("/");

  let listing: FolderListing | null = null;
  let problem = "";
  try {
    listing = await listFolder(account, path);
  } catch (error) {
    problem = error instanceof MediaPathError ? error.message : "That folder couldn't be read.";
    if (!(error instanceof MediaPathError)) console.error("gather: could not list a folder for the mobile gallery.", error);
  }

  const parentHref =
    segments.length === 0
      ? "/m"
      : `/m/${encodeURIComponent(account)}${segments.length > 1 ? "/" + segments.slice(0, -1).map(encodeURIComponent).join("/") : ""}`;

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-3 pb-10">
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-paper px-2 pt-[env(safe-area-inset-top)]">
        <Link href={parentHref} aria-label="Back" className="flex size-11 items-center justify-center text-title">
          ‹
        </Link>
        <h1 className="m-0 min-w-0 truncate font-mono text-body font-normal">{segments.at(-1) ?? account}</h1>
      </header>
      {listing ? (
        <MobileGallery
          key={`${account}/${path}`}
          account={account}
          path={path}
          base={`/m/${encodeURIComponent(account)}${segments.map((s) => "/" + encodeURIComponent(s)).join("")}`}
          folders={listing.folders.map((folder) => folder.name)}
          files={listing.files}
          maxZipFiles={PHONE_ZIP_FILES}
          maxZipBytes={ZIP_MAX_BYTES}
        />
      ) : (
        <p className="m-0 px-4 text-body text-ink-2">{problem}</p>
      )}
    </main>
  );
}
