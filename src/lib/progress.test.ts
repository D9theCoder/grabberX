import { describe, expect, it } from "vitest";
import { createDefaultSpec } from "@/lib/spec";
import {
  ProgressTracker,
  formatEta,
  formatSpeed,
  parseProbeTotal,
  postIdOf,
  progressFraction,
  totalEligible,
} from "@/lib/progress";

const MB = 1024 * 1024;

describe("ProgressTracker", () => {
  it("reports total speed from every file, whichever worker saved it", () => {
    const tracker = new ProgressTracker(0);
    for (let second = 1; second <= 10; second += 1) tracker.record(second * 1000, 2 * MB);
    const progress = tracker.snapshot(10_000);
    expect(progress.bytes).toBe(20 * MB);
    expect(progress.bytesPerSec).toBe(2 * MB);
    expect(progress.itemsPerSec).toBe(1);
  });

  it("lets speed fall to zero once nothing arrives for a window", () => {
    const tracker = new ProgressTracker(0);
    tracker.record(1000, 5 * MB);
    expect(tracker.snapshot(60_000).bytesPerSec).toBe(0);
    expect(tracker.snapshot(60_000).bytes).toBe(5 * MB);
  });

  it("has no total, percent or ETA until a total is known", () => {
    const tracker = new ProgressTracker(0);
    for (let i = 1; i <= 8; i += 1) tracker.record(i * 1000, MB);
    const progress = tracker.snapshot(8000);
    expect(progress.total).toBeUndefined();
    expect(progress.etaSeconds).toBeUndefined();
  });

  it("estimates the time left from the recent file rate", () => {
    const tracker = new ProgressTracker(0);
    tracker.setTotal(100);
    for (let i = 1; i <= 10; i += 1) tracker.record(i * 1000, MB);
    const progress = tracker.snapshot(10_000);
    expect(progress.processed).toBe(10);
    expect(progress.etaSeconds).toBe(90);
  });

  it("withholds the ETA while the sample is too small, and when the total is already passed", () => {
    const early = new ProgressTracker(0);
    early.setTotal(100);
    early.record(1000, MB);
    expect(early.snapshot(2000).etaSeconds).toBeUndefined();

    const over = new ProgressTracker(0);
    over.setTotal(5);
    for (let i = 1; i <= 8; i += 1) over.record(i * 1000, MB);
    expect(over.snapshot(8000).etaSeconds).toBeUndefined();
  });

  it("counts a large file while it downloads, and only the rest when it finishes", () => {
    const tracker = new ProgressTracker(0);
    for (let second = 1; second <= 10; second += 1) tracker.recordPart(second * 1000, "1_1.mp4", second * 10 * MB);
    const live = tracker.snapshot(10_000);
    expect(live.bytes).toBe(100 * MB);
    expect(live.bytesPerSec).toBe(10 * MB);
    expect(live.itemsPerSec).toBe(0);

    tracker.record(11_000, 105 * MB, { key: "1_1.mp4" });
    // A reading taken just before the rename and delivered after it must not add the file again.
    tracker.recordPart(11_100, "1_1.mp4", 104 * MB);
    const done = tracker.snapshot(11_000);
    expect(done.bytes).toBe(105 * MB);
    expect(done.itemsPerSec).toBeCloseTo(1 / 11, 1);
  });

  it("ignores a .part that shrinks and counts a file with no readings in full", () => {
    const tracker = new ProgressTracker(0);
    tracker.recordPart(1000, "a.mp4", 8 * MB);
    tracker.recordPart(2000, "a.mp4", 2 * MB);
    tracker.record(3000, 9 * MB, { key: "a.mp4" });
    tracker.record(3000, 4 * MB, { key: "b.jpg" });
    expect(tracker.snapshot(3000).bytes).toBe(13 * MB);
  });

  it("splits the posts left by the saved-to-skipped ratio, each timed by its own kind", () => {
    const tracker = new ProgressTracker(0);
    tracker.setTotal(200);
    // A resumed run: a burst of 50 skips in 1.5 s, then a download a second.
    for (let i = 0; i < 50; i += 1) tracker.recordSkip(500 + i * 20);
    for (let second = 3; second <= 10; second += 1) tracker.record(second * 1000, MB);
    const progress = tracker.snapshot(10_000);
    // Skips took 1.48 s for 50 posts, saves 8.52 s for 8. Of 142 posts left, 8/58 are expected to download.
    const expected = 142 * ((8 / 58) * (8.52 / 8) + (50 / 58) * (1.48 / 50));
    expect(progress.etaSeconds).toBe(Math.ceil(expected));
    expect(progress.itemsPerSec).toBe(5.8);
  });

  it("keeps a short ETA through the skips that end an update run", () => {
    const tracker = new ProgressTracker(0);
    tracker.setTotal(10_000);
    // Five new posts download, one a second, then the archive skips the old ones, a hundred a second.
    for (let second = 1; second <= 5; second += 1) tracker.record(second * 1000, MB, { post: `new${second}` });
    let at = 5000;
    for (let i = 0; i < 200; i += 1) tracker.recordSkip((at += 10), `old${i}`);
    // 9,795 posts left, 2.4% expected to download at 1 s and the rest to skip at 0.01 s: about 5.5 min. Pacing by
    // the downloads alone said nearly 4 hours.
    const early = tracker.snapshot(7000).etaSeconds;
    expect(early).toBeDefined();
    expect(early!).toBeLessThan(600);

    for (let i = 200; i < 3000; i += 1) tracker.recordSkip((at += 10), `old${i}`);
    // The downloads have left the 15 s window, but the skips still set a pace, so the ETA stays.
    const later = tracker.snapshot(35_000);
    expect(later.processed).toBe(3005);
    expect(later.etaSeconds).toBeDefined();
    expect(later.etaSeconds!).toBeLessThan(120);
  });

  it("paces the ETA by skips while nothing has been saved", () => {
    const tracker = new ProgressTracker(0);
    tracker.setTotal(100);
    for (let second = 1; second <= 10; second += 1) tracker.recordSkip(second * 1000);
    expect(tracker.snapshot(10_000).etaSeconds).toBe(90);
  });

  it("counts posts, not files, towards the total: an album of three is one post", () => {
    const tracker = new ProgressTracker(0);
    tracker.setTotal(10);
    let at = 0;
    for (let post = 1; post <= 4; post += 1) {
      for (let n = 1; n <= 3; n += 1) tracker.record((at += 500), MB, { post: String(post) });
    }
    // The same post in the video pass, after the image pass, is not counted again.
    tracker.recordSkip((at += 500), "1");
    const progress = tracker.snapshot(6500);
    expect(progress.processed).toBe(4);
    // 4 posts took 6 s, so the 6 left take 9 s.
    expect(progress.etaSeconds).toBe(9);
    expect(progress.itemsPerSec).toBe(2);
  });

  it("does not count a .part left by an earlier run as this run's download", () => {
    const tracker = new ProgressTracker(0);
    tracker.seedPart("old.mp4", 800 * MB);
    tracker.recordPart(1000, "old.mp4", 800 * MB);
    expect(tracker.snapshot(1000).bytes).toBe(0);
    // Resumed: only the growth after it was found counts, also once it finishes.
    tracker.recordPart(2000, "old.mp4", 810 * MB);
    expect(tracker.snapshot(2000).bytes).toBe(10 * MB);
    tracker.record(3000, 820 * MB, { key: "old.mp4" });
    expect(tracker.snapshot(3000).bytes).toBe(20 * MB);
  });

  it("leaves the bytes of a file that never finished out of the closing numbers", () => {
    const tracker = new ProgressTracker(0);
    tracker.record(1000, 10 * MB, { key: "kept.jpg" });
    tracker.recordPart(2000, "stopped.mp4", 500 * MB);
    expect(tracker.snapshot(2000).bytes).toBe(510 * MB);
    const closing = tracker.finish(10_000);
    expect(closing.bytes).toBe(10 * MB);
    expect(closing.bytesPerSec).toBe(MB);
  });


  it("closes with the average speed of the whole run", () => {
    const tracker = new ProgressTracker(0);
    tracker.record(1000, 30 * MB);
    const closing = tracker.finish(30_000);
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
    expect(totalEligible({ ...spec, site: "instagram", account: "nasa" })).toBe(false);
    expect(totalEligible({ ...spec, site: "bluesky" })).toBe(false);
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

describe("postIdOf", () => {
  it("reads the post from X and Instagram file names, on either path separator", () => {
    expect(postIdOf("D:\\Photos\\scrapper\\kizakisato\\Image\\1837033048123_2.jpg")).toBe("1837033048123");
    expect(postIdOf("acct/Video/1837033048123_1.mp4")).toBe("1837033048123");
    expect(postIdOf("aoi/4023575739228270482_4023575632727325547.jpg")).toBe("4023575739228270482");
    expect(postIdOf("aoi/4028604394690902491.jpg")).toBe("4028604394690902491");
    expect(postIdOf("reddit/abc123 my title.jpg")).toBeUndefined();
  });
});
