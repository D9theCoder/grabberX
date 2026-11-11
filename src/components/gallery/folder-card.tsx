import Link from "next/link";
import { FolderIcon } from "@/components/icons";

/** A sub-folder of the current path. A bordered link, never a filled tile, so thumbnails stay the loudest thing on the page. */
export function FolderCard({ name, href }: { name: string; href: string }) {
  return (
    <Link
      href={href}
      className="flex h-12 min-w-40 items-center gap-3 rounded-md border border-line-strong bg-surface px-4 text-label transition-colors duration-120 hover:border-ink-2"
    >
      <FolderIcon className="size-4 flex-none text-ink-2" />
      <span className="truncate font-mono text-code">{name}</span>
    </Link>
  );
}
