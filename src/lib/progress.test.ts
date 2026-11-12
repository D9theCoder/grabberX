import { describe, expect, it } from "vitest";
import { createDefaultSpec } from "@/lib/spec";
import {
  ProgressTracker,
  formatEta,
  formatSpeed,
  parseProbeTotal,
  progressFraction,
  totalEligible,
} from "@/lib/progress";

const MB = 1024 * 1024;

describe("ProgressTracker", () => {
  it("reports total speed from every file, whichever worker saved it", () => {
    const tracker = new ProgressTracker(0);
    for (let second = 1; second <= 10; second += 1) tracker.record(second * 1000, 2 * MB);
    const progress = tracker.snapshot(10_000, 10);
    expect(progress.bytes).toBe(20 * MB);
    expect(progress.bytesPerSec).toBe(2 * MB);
    expect(progress.itemsPerSec).toBe(1);
  });

  it("lets speed fall to zero once nothing arrives for a window", () => {
    const tracker = new ProgressTracker(0);
    tracker.record(1000, 5 * MB);
    expect(tracker.snapshot(60_000, 1).bytesPerSec).toBe(0);
    expect(tracker.snapshot(60_000, 1).bytes).toBe(5 * MB);
  });

  it("has no total, percent or ETA until a total is known", () => {
    const tracker = new ProgressTracker(0);
    for (let i = 1; i <= 8; i += 1) tracker.record(i * 1000, MB);
    const progress = tracker.snapshot(8000, 8);
    expect(progress.total).toBeUndefined();
    expect(progress.etaSeconds).toBeUndefined();
  });

  it("estimates the time left from the recent file rate", () => {
    const tracker = new ProgressTracker(0);
    tracker.setTotal(100);
    for (let i = 1; i <= 10; i += 1) tracker.record(i * 1000, MB);
    const progress = tracker.snapshot(10_000, 10);
    expect(progress.processed).toBe(10);
    expect(progress.etaSeconds).toBe(90);
  });

  it("withholds the ETA while the sample is too small, and when the total is already passed", () => {
    const early = new ProgressTracker(0);
    early.setTotal(100);
    early.record(1000, MB);
    expect(early.snapshot(2000, 1).etaSeconds).toBeUndefined();

    const over = new ProgressTracker(0);
    over.setTotal(5);
    for (let i = 1; i <= 8; i += 1) over.record(i * 1000, MB);
    expect(over.snapshot(8000, 8).etaSeconds).toBeUndefined();
  });

  it("closes with the average speed of the whole run", () => {
    const tracker = new ProgressTracker(0);
    tracker.record(1000, 30 * MB);
    const closing = tracker.finish(30_000, 1);
    expect(closing.done).toBe(true);
    expect(closing.bytesPerSec).toBe(MB);
    expect(closing.etaSeconds).toBeUndefined();
  });
});

describe("progressFraction", () => {
  it("is null without a total and never reaches 100% while the run is live", () => {
    expect(progressFraction({ bytes: 0, bytesPerSec: 0, itemsPerSec: 0 }, false)).toBeNull();
    const over = { bytes: 0, bytesPerSec: 0, itemsPerSec: 0, total: 10, processed: 12 };
    expect(progressFraction(over, false)).toBe(0.99);
    expect(progressFraction(over, true)).toBe(1);
  });
});

describe("formatting", () => {
  it("formats speed and ETA", () => {
    expect(formatSpeed(0)).toBe("0 B/s");
    expect(formatSpeed(1536)).toBe("1.5 KB/s");
    expect(formatSpeed(4.2 * MB)).toBe("4.2 MB/s");
    expect(formatEta(30)).toBe("under a minute");
    expect(formatEta(12 * 60)).toBe("about 12 min");
    expect(formatEta(3900)).toBe("about 1 h 05 min");
  });
});

describe("totals", () => {
  const settings = { defaultMedia: "all" as const, defaultLayout: { kind: "byType" as const }, cookies: { browser: "firefox" as const } };

  it("is offered only for a whole-account X run", () => {
    const spec = createDefaultSpec(settings);
    expect(totalEligible({ ...spec, account: "nasa" })).toBe(true);
    expect(totalEligible({ ...spec, site: "reddit" })).toBe(false);
    expect(totalEligible({ ...spec, media: "images" })).toBe(false);
    expect(totalEligible({ ...spec, dateFrom: "2025-01-01" })).toBe(false);
    expect(totalEligible({ ...spec, advanced: { ...spec.advanced, range: 50 } })).toBe(false);
  });

  it("reads the media count from gallery-dl -j output", () => {
    const output = JSON.stringify([[2, { user: { media_count: 28246 }, author: { media_count: 5 } }]]);
    expect(parseProbeTotal(output)).toBe(28246);
    expect(parseProbeTotal(JSON.stringify([[2, { author: { media_count: 7 } }]]))).toBe(7);
    expect(parseProbeTotal("not json")).toBeUndefined();
    expect(parseProbeTotal("[]")).toBeUndefined();
  });
});
