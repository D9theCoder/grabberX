import Link from "next/link";
import { Breadcrumb } from "@/components/gallery/breadcrumb";
import { MobileGallery } from "@/components/mobile/mobile-gallery";
import type { FolderListing } from "@/components/gallery/types";
import type { SiteId } from "@/lib/spec";
import { runsForFolder } from "@/lib/update-spec";
import { listFolder, MediaPathError, resolveMediaPath } from "@/server/media";
import { knownMeta } from "@/server/media-index";
import type { FolderMeta } from "@/server/media-index";
import { getSettings, listRuns } from "@/server/store";
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
  let meta: FolderMeta | null = null;
  let site: SiteId | undefined;
  let problem = "";
  try {
    const [folderListing, settings, runs] = await Promise.all([
      listFolder(account, path),
      getSettings(),
      listRuns(200),
    ]);
    listing = folderListing;
    // Only what the on-disk index already has: no file is opened here and no client /api/media/dims call is needed.
    const { full } = await resolveMediaPath(settings.mediaRoot, account, path);
    meta = await knownMeta(full, listing.files);
    const history = runsForFolder(account, runs);
    site = (history.find((run) => !run.spec.simulate) ?? history[0])?.spec.site;
  } catch (error) {
    problem = error instanceof MediaPathError ? error.message : "That folder couldn't be read.";
    if (!(error instanceof MediaPathError)) console.error("grabberX: could not list a folder for the mobile gallery.", error);
  }

  const crumbs = [
    { label: "Library", href: "/m" },
    { label: account, href: `/m/${encodeURIComponent(account)}` },
    ...segments.map((segment, index) => ({
      label: segment,
      href: `/m/${encodeURIComponent(account)}/${segments.slice(0, index + 1).map(encodeURIComponent).join("/")}`,
    })),
  ];

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5 px-3 pt-[max(1.25rem,env(safe-area-inset-top))] pb-16 sm:px-6">
      <div className="flex flex-col gap-2">
        <Breadcrumb items={crumbs} />
        <h1 className="m-0 font-mono text-display font-normal">{segments.at(-1) ?? account}</h1>
      </div>
      {listing ? (
        <MobileGallery
          key={`${account}/${path}`}
          account={account}
          path={path}
          site={site}
          base={`/m/${encodeURIComponent(account)}${segments.map((s) => "/" + encodeURIComponent(s)).join("")}`}
          folders={listing.folders.map((folder) => folder.name)}
          files={listing.files}
          initialDurations={meta?.durations}
          maxZipFiles={PHONE_ZIP_FILES}
          maxZipBytes={ZIP_MAX_BYTES}
        />
      ) : (
        <p className="text-body text-ink-2">
          {problem}{" "}
          <Link href="/m" className="underline decoration-line-strong underline-offset-4 hover:text-ink">
            Back to the library
          </Link>
        </p>
      )}
    </main>
  );
}
