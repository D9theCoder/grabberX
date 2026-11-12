import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { zipStream } from "@/server/zip";

let sandbox = "";

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "gather-zip-"));
});

afterAll(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

async function collect(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Reads the central directory back, the way an unzip tool finds the files. */
function readCentral(zip: Buffer) {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let offset = zip.readUInt32LE(end + 16);
  const entries: { name: string; crc: number; size: number; data: Buffer }[] = [];
  for (let index = 0; index < count; index++) {
    expect(zip.readUInt32LE(offset)).toBe(0x02014b50);
    const crc = zip.readUInt32LE(offset + 16);
    const size = zip.readUInt32LE(offset + 24);
    const nameLength = zip.readUInt16LE(offset + 28);
    const local = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const dataStart = local + 30 + zip.readUInt16LE(local + 26);
    entries.push({ name, crc, size, data: zip.subarray(dataStart, dataStart + size) });
    offset += 46 + nameLength;
  }
  return entries;
}

describe("zipStream", () => {
  it("stores every file with its CRC and size", async () => {
    const files = [
      { name: "1800000000000000001_1.jpg", body: Buffer.alloc(200_000, 7) },
      { name: "1800000000000000002_1.mp4", body: Buffer.from("tiny") },
      { name: "empty.png", body: Buffer.alloc(0) },
    ];
    const entries = [];
    for (const file of files) {
      const path = join(sandbox, file.name);
      await writeFile(path, file.body);
      const info = await stat(path);
      entries.push({ name: file.name, path, size: info.size, mtime: info.mtime });
    }

    const zip = await collect(zipStream(entries));
    const read = readCentral(zip);
    expect(read.map((entry) => entry.name)).toEqual(files.map((file) => file.name));
    read.forEach((entry, index) => {
      const body = files[index]!.body;
      expect(entry.size).toBe(body.length);
      expect(entry.crc).toBe(crc32(body));
      expect(entry.data.equals(body)).toBe(true);
    });
  });
});
