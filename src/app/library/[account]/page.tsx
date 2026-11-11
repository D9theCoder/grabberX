import Link from "next/link";
import { Breadcrumb } from "@/components/gallery/breadcrumb";
import { Gallery } from "@/components/gallery/gallery";
import type { FolderListing } from "@/components/gallery/types";
import { listFolder, MediaPathError } from "@/server/media";
import { requireSetup } from "@/server/setup";

export const dynamic = "force-dynamic";

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export default async function AccountGalleryPage({ params, searchParams }: PageProps<"/library/[account]">) {
  await requireSetup();
  const { account: rawAccount } = await params;
  const query = await searchParams;
  const account = decodeURIComponent(rawAccount);
  const path = first(query.path).replace(/\/+$/, "");
  const file = first(query.file);

  let listing: FolderListing | null = null;
  let problem = "";
  try {
    listing = await listFolder(account, path);
  } catch (error) {
    problem = error instanceof MediaPathError ? error.message : "That folder couldn't be read.";
    if (!(error instanceof MediaPathError)) console.error("gather: could not list a library folder.", error);
  }

  const segments = path === "" ? [] : path.split("/");
  const crumbs = [
    { label: "Library", href: "/library" },
    { label: account, href: `/library/${encodeURIComponent(account)}` },
    ...segments.map((segment, index) => ({
      label: segment,
      href: `/library/${encodeURIComponent(account)}?path=${encodeURIComponent(segments.slice(0, index + 1).join("/"))}`,
    })),
  ];

  return (
    <main className="flex flex-col gap-6 pt-12 pb-16">
      <div className="flex flex-col gap-3">
        <Breadcrumb items={crumbs} />
        <h1 className="m-0 font-mono text-display font-normal">{segments.at(-1) ?? account}</h1>
      </div>
      {listing ? (
        <Gallery
          key={`${account}/${path}`}
          account={account}
          path={path}
          listing={listing}
          initialFile={file === "" ? undefined : file}
        />
      ) : (
        <p className="text-body text-ink-2">
          {problem}{" "}
          <Link href="/library" className="underline decoration-line-strong underline-offset-4 hover:text-ink">
            Back to the library
          </Link>
        </p>
      )}
    </main>
  );
}
