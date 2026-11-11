export type MediaKind = "image" | "video";

export interface MediaFile {
  name: string;
  size: number;
  mtimeMs: number;
  kind: MediaKind;
}

export interface MediaFolder {
  name: string;
}

export interface FolderListing {
  folders: MediaFolder[];
  files: MediaFile[];
}

const IMAGE_EXTENSION = /\.(jpe?g|png|webp|gif)$/i;
const VIDEO_EXTENSION = /\.(mp4|webm|mov|m4v)$/i;

/** The one rule for what the gallery shows: known media extensions only, never sidecars or `.part` files. */
export function mediaKindOf(name: string): MediaKind | null {
  if (IMAGE_EXTENSION.test(name)) return "image";
  if (VIDEO_EXTENSION.test(name)) return "video";
  return null;
}
