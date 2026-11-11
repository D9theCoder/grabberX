import { describe, expect, it } from "vitest";
import { formatDuration, postDateOf, postIdOf, postUrlOf, sortFiles } from "./format";

describe("post helpers", () => {
  it("reads the post id from a filename", () => {
    expect(postIdOf("1800000000000000000_2.jpg")).toBe("1800000000000000000");
    expect(postIdOf("notes.jpg")).toBeNull();
    expect(postIdOf("12_1.jpg")).toBeNull();
  });

  it("derives the post date from the id", () => {
    expect(postDateOf("1800000000000000000")?.getUTCFullYear()).toBe(2024);
    expect(postDateOf("abc")).toBeNull();
  });

  it("builds the post link", () => {
    expect(postUrlOf("1800000000000000000")).toBe("https://x.com/i/status/1800000000000000000");
  });
});

describe("formatDuration", () => {
  it("formats minutes and seconds", () => {
    expect(formatDuration(5)).toBe("0:05");
    expect(formatDuration(125.4)).toBe("2:05");
    expect(formatDuration(Number.NaN)).toBe("");
  });
});

describe("sortFiles", () => {
  const files = [
    { name: "1800000000000000010_1.jpg", mtimeMs: 2 },
    { name: "1800000000000000002_1.jpg", mtimeMs: 3 },
    { name: "1800000000000000002_2.jpg", mtimeMs: 1 },
  ];

  it("orders newest first by post id, then by number", () => {
    expect(sortFiles(files, "newest").map((file) => file.name)).toEqual([
      "1800000000000000010_1.jpg",
      "1800000000000000002_2.jpg",
      "1800000000000000002_1.jpg",
    ]);
  });

  it("orders oldest first and by name", () => {
    expect(sortFiles(files, "oldest")[0]!.name).toBe("1800000000000000002_1.jpg");
    expect(sortFiles(files, "name").map((file) => file.name)).toEqual([
      "1800000000000000002_1.jpg",
      "1800000000000000002_2.jpg",
      "1800000000000000010_1.jpg",
    ]);
  });
});
