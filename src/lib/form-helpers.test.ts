import { describe, expect, it } from "vitest";
import {
  changedAdvancedKeys,
  datePresetRange,
  layoutPathPreview,
  templateToSegments,
  toIsoDate,
} from "@/lib/form-helpers";
import { DEFAULT_ADVANCED } from "@/lib/spec";

describe("datePresetRange", () => {
  const today = new Date(2026, 10, 11);

  it("returns nothing for all time and custom", () => {
    expect(datePresetRange("all", today)).toEqual({});
    expect(datePresetRange("custom", today)).toEqual({});
  });

  it("starts 30 days back", () => {
    expect(datePresetRange("30d", today)).toEqual({ dateFrom: "2026-10-12" });
  });

  it("starts on 1 January for this year", () => {
    expect(datePresetRange("year", today)).toEqual({ dateFrom: "2026-01-01" });
  });
});

describe("toIsoDate", () => {
  it("zero-pads month and day in local time", () => {
    expect(toIsoDate(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

describe("layoutPathPreview", () => {
  it("shows the by-type paths", () => {
    expect(layoutPathPreview({ kind: "byType" }, "username", "image")).toBe("username/Image/1834220145_1.jpg");
    expect(layoutPathPreview({ kind: "byType" }, "username", "video")).toBe("username/Video/1834220145_1.mp4");
  });

  it("adds a year folder to images only for by-type-year", () => {
    expect(layoutPathPreview({ kind: "byTypeYear" }, "a", "image")).toBe("a/Image/2025/1834220145_1.jpg");
    expect(layoutPathPreview({ kind: "byTypeYear" }, "a", "video")).toBe("a/Video/1834220145_1.mp4");
  });

  it("renders a custom template with sample values", () => {
    const layout = { kind: "custom" as const, template: ["{date:%Y}", "{author[name]}"] };
    expect(layoutPathPreview(layout, "username", "image")).toBe("username/2025/username/1834220145_1.jpg");
  });

  it("leaves unknown tokens visible", () => {
    const layout = { kind: "custom" as const, template: ["{mystery}"] };
    expect(layoutPathPreview(layout, "a", "image")).toBe("a/{mystery}/1834220145_1.jpg");
  });
});

describe("templateToSegments", () => {
  it("splits on slashes and drops empty segments", () => {
    expect(templateToSegments(" {date:%Y} //{tweet_id} ")).toEqual(["{date:%Y}", "{tweet_id}"]);
  });
});

describe("changedAdvancedKeys", () => {
  const cookies = { browser: "firefox" as const };

  it("is empty for the defaults", () => {
    expect(changedAdvancedKeys({ ...DEFAULT_ADVANCED, cookies }, cookies)).toEqual([]);
  });

  it("lists each changed key once", () => {
    const changed = { ...DEFAULT_ADVANCED, cookies, sleepRequest: 2, retweets: true, imageSize: "large" as const };
    expect(changedAdvancedKeys(changed, cookies).sort()).toEqual(["imageSize", "retweets", "sleepRequest"]);
  });

  it("treats a different cookie browser as changed", () => {
    expect(changedAdvancedKeys({ ...DEFAULT_ADVANCED, cookies: { browser: "chrome" } }, cookies)).toEqual(["cookies"]);
  });
});
