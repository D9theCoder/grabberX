import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatCount,
  formatElapsed,
  formatRelative,
  truncateMiddle,
} from "@/lib/format";

describe("formatBytes", () => {
  it("formats zero and small values", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("uses 1024-based units", () => {
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1024 * 1024 * 412)).toBe("412 MB");
    expect(formatBytes(3.1 * 1024 ** 3)).toBe("3.1 GB");
    expect(formatBytes(2 * 1024 ** 4)).toBe("2 TB");
  });

  it("keeps kilobytes whole", () => {
    expect(formatBytes(1536)).toBe("2 KB");
  });
});

describe("formatCount", () => {
  it("groups thousands", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(1204)).toBe("1,204");
    expect(formatCount(1234567)).toBe("1,234,567");
  });
});

describe("formatElapsed", () => {
  it("prints mm:ss", () => {
    expect(formatElapsed(0)).toBe("00:00");
    expect(formatElapsed(9_000)).toBe("00:09");
    expect(formatElapsed(134_000)).toBe("02:14");
    expect(formatElapsed(59_999)).toBe("00:59");
  });

  it("prints h:mm:ss past one hour", () => {
    expect(formatElapsed(3_600_000)).toBe("1:00:00");
    expect(formatElapsed(3_734_000)).toBe("1:02:14");
  });

  it("clamps negative input", () => {
    expect(formatElapsed(-1000)).toBe("00:00");
  });
});

describe("formatRelative", () => {
  const now = new Date("2026-11-11T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

  it("describes recent times", () => {
    expect(formatRelative(ago(5_000), now)).toBe("just now");
    expect(formatRelative(ago(60_000), now)).toBe("1 minute ago");
    expect(formatRelative(ago(300_000), now)).toBe("5 minutes ago");
    expect(formatRelative(ago(2 * 3_600_000), now)).toBe("2 hours ago");
    expect(formatRelative(ago(3 * 86_400_000), now)).toBe("3 days ago");
    expect(formatRelative(ago(60 * 86_400_000), now)).toBe("2 months ago");
    expect(formatRelative(ago(400 * 86_400_000), now)).toBe("1 year ago");
  });

  it("treats a future timestamp as just now", () => {
    expect(formatRelative(new Date(now.getTime() + 60_000).toISOString(), now)).toBe(
      "just now",
    );
  });

  it("returns an empty string for an unparseable date", () => {
    expect(formatRelative("not a date", now)).toBe("");
  });
});

describe("truncateMiddle", () => {
  it("keeps short text as it is", () => {
    expect(truncateMiddle("Image/1.jpg", 40)).toBe("Image/1.jpg");
    expect(truncateMiddle("abc", 3)).toBe("abc");
  });

  it("keeps both ends", () => {
    const text = "Video/1834220145123456789_1.mp4";
    const short = truncateMiddle(text, 16);
    expect(short).toHaveLength(16);
    expect(short.startsWith("Video/")).toBe(true);
    expect(short.endsWith(".mp4")).toBe(true);
    expect(short).toContain("…");
  });

  it("handles tiny widths", () => {
    expect(truncateMiddle("abcdef", 1)).toBe("…");
    expect(truncateMiddle("abcdef", 0)).toBe("");
    expect(truncateMiddle("abcdef", 2)).toBe("a…");
  });
});
