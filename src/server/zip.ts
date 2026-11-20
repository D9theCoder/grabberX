import "server-only";
import { createReadStream } from "node:fs";
import { crc32 } from "node:zlib";

export interface ZipEntry {
  /** Name inside the archive. */
  name: string;
  path: string;
  size: number;
  mtime: Date;
}

/** Plain zip, no zip64: 4 GB and 65,535 files at most. Callers check before streaming. */
export const ZIP_MAX_BYTES = 0xffffffff - 64 * 1024 * 1024;
export const ZIP_MAX_FILES = 0xfffe;

function dosDateTime(date: Date): { time: number; date: number } {
  // DOS date field stores (year - 1980) in 7 bits (0..127 => 1980..2107).
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

// Bit 3: sizes and CRC follow the data. Bit 11: names are UTF-8.
const FLAGS = 0x0808;

function localHeader(name: Buffer, stamp: { time: number; date: number }): Buffer {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(FLAGS, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(stamp.time, 10);
  header.writeUInt16LE(stamp.date, 12);
  header.writeUInt16LE(name.length, 26);
  return Buffer.concat([header, name]);
}

function descriptor(crc: number, size: number): Buffer {
  const out = Buffer.alloc(16);
  out.writeUInt32LE(0x08074b50, 0);
  out.writeUInt32LE(crc >>> 0, 4);
  out.writeUInt32LE(size, 8);
  out.writeUInt32LE(size, 12);
  return out;
}

function centralRecord(name: Buffer, stamp: { time: number; date: number }, crc: number, size: number, offset: number): Buffer {
  const record = Buffer.alloc(46);
  record.writeUInt32LE(0x02014b50, 0);
  record.writeUInt16LE(20, 4);
  record.writeUInt16LE(20, 6);
  record.writeUInt16LE(FLAGS, 8);
  record.writeUInt16LE(0, 10);
  record.writeUInt16LE(stamp.time, 12);
  record.writeUInt16LE(stamp.date, 14);
  record.writeUInt32LE(crc >>> 0, 16);
  record.writeUInt32LE(size, 20);
  record.writeUInt32LE(size, 24);
  record.writeUInt16LE(name.length, 28);
  record.writeUInt32LE(offset, 42);
  return Buffer.concat([record, name]);
}

function endRecord(count: number, size: number, offset: number): Buffer {
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return end;
}

function uniqueZipName(raw: string, used: Set<string>): string {
  const key = raw.toLowerCase();
  if (!used.has(key)) {
    used.add(key);
    return raw;
  }
  const dot = raw.lastIndexOf(".");
  const stem = dot > 0 ? raw.slice(0, dot) : raw;
  const ext = dot > 0 ? raw.slice(dot) : "";
  let n = 2;
  while (used.has(`${stem}_${n}${ext}`.toLowerCase())) n += 1;
  const unique = `${stem}_${n}${ext}`;
  used.add(unique.toLowerCase());
  return unique;
}

const UINT32_MAX = 0xffffffff;

/**
 * Streams the files into a stored (uncompressed) zip. Photos and videos are already compressed, so storing
 * them is as small as deflating and costs no CPU, and nothing is held in memory beyond one read chunk.
 */
export function zipStream(entries: readonly ZipEntry[]): ReadableStream<Uint8Array> {
  async function* generate(): AsyncGenerator<Buffer> {
    const central: Buffer[] = [];
    const usedNames = new Set<string>();
    let offset = 0;
    for (const entry of entries) {
      const name = Buffer.from(uniqueZipName(entry.name, usedNames), "utf8");
      const stamp = dosDateTime(entry.mtime);
      const header = localHeader(name, stamp);
      const start = offset;
      if (start > UINT32_MAX) throw new Error("Zip archive exceeded the 4 GB limit while streaming.");
      yield header;
      offset += header.length;
      let crc = 0;
      let written = 0;
      for await (const chunk of createReadStream(entry.path)) {
        const bytes = chunk as Buffer;
        crc = crc32(bytes, crc);
        written += bytes.length;
        if (written > UINT32_MAX || offset + written > UINT32_MAX) {
          throw new Error("Zip archive exceeded the 4 GB limit while streaming.");
        }
        yield bytes;
      }
      const tail = descriptor(crc, written);
      yield tail;
      offset += written + tail.length;
      central.push(centralRecord(name, stamp, crc, written, start));
    }
    const directory = Buffer.concat(central);
    if (offset > UINT32_MAX || directory.length > UINT32_MAX) {
      throw new Error("Zip archive exceeded the 4 GB limit while streaming.");
    }
    yield directory;
    yield endRecord(central.length, directory.length, offset);
  }

  const iterator = generate();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await iterator.next();
        if (done) controller.close();
        else controller.enqueue(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return(undefined);
    },
  });
}
