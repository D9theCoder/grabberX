import "server-only";
import { open } from "node:fs/promises";

export type Size = [number, number];

/**
 * Width and height from the first bytes of a JPEG, PNG, WebP or GIF, without decoding anything.
 * Returns null when the header isn't in `bytes` (a JPEG with a huge EXIF block) or the format is unknown.
 * JPEG EXIF orientation 5–8 swaps the sides, the same as the browser shows the image.
 */
export function sizeFromHeader(bytes: Uint8Array): Size | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = bytes.length;
  if (length >= 24 && view.getUint32(0) === 0x89504e47 && view.getUint32(12) === 0x49484452) {
    return positive(view.getUint32(16), view.getUint32(20));
  }
  if (length >= 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return positive(view.getUint16(6, true), view.getUint16(8, true));
  }
  if (length >= 30 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    const chunk = ascii(bytes, 12, 4);
    if (chunk === "VP8X") {
      return positive(1 + (view.getUint32(24, true) & 0xffffff), 1 + (view.getUint32(26, true) >>> 8));
    }
    if (chunk === "VP8 " && length >= 30) {
      return positive(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
    }
    if (chunk === "VP8L" && length >= 25) {
      const bits = view.getUint32(21, true);
      return positive((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    return null;
  }
  if (length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return jpegSize(bytes, view);
  return null;
}

function ascii(bytes: Uint8Array, start: number, count: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + count));
}

function positive(width: number, height: number): Size | null {
  return width > 0 && height > 0 ? [width, height] : null;
}

function jpegSize(bytes: Uint8Array, view: DataView): Size | null {
  let offset = 2;
  let orientation = 1;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    const segment = view.getUint16(offset + 2);
    if (marker === 0xe1 && offset + 4 + segment <= bytes.length) {
      orientation = exifOrientation(bytes, view, offset + 4, segment - 2) ?? orientation;
    }
    // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC), carry the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = view.getUint16(offset + 5);
      const width = view.getUint16(offset + 7);
      return orientation >= 5 ? positive(height, width) : positive(width, height);
    }
    offset += 2 + segment;
  }
  return null;
}

function exifOrientation(bytes: Uint8Array, view: DataView, start: number, length: number): number | null {
  if (length < 14 || ascii(bytes, start, 4) !== "Exif") return null;
  const tiff = start + 6;
  const little = bytes[tiff] === 0x49;
  const ifd = tiff + view.getUint32(tiff + 4, little);
  if (ifd + 2 > start + length) return null;
  const count = view.getUint16(ifd, little);
  for (let index = 0; index < count; index++) {
    const entry = ifd + 2 + index * 12;
    if (entry + 12 > start + length) return null;
    if (view.getUint16(entry, little) === 0x0112) return view.getUint16(entry + 8, little);
  }
  return null;
}

const HEAD_BYTES = 64 * 1024;

/** Reads the first 64 KB of a file and parses its header. Null when the header is further in or unknown. */
export async function readImageSize(path: string): Promise<Size | null> {
  const handle = await open(path, "r").catch(() => null);
  if (!handle) return null;
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return sizeFromHeader(buffer.subarray(0, bytesRead));
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}
