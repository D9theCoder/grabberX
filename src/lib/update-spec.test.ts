import { describe, expect, it } from "vitest";
import type { ActionResult, Advanced, JobSpec, LibraryEntry, Run, Settings } from "@/lib/spec";
import { CAUGHT_UP_AFTER, buildUpdateSpec } from "@/lib/update-spec";

const SETTINGS: Settings = {
  galleryDlPath: "C:\\tools\\gallery-dl.exe",
  mediaRoot: "D:\\Photos\\p\\scrapper",
  cookies: { browser: "firefox", profile: "a1b2c3d4.default-release" },
  defaultMedia: "all",
  defaultLayout: { kind: "byType" },
  historyRetention: 200,
  concurrency: 1,
  schedule: { enabled: false, frequency: { kind: "daily", time: "03:00" } },
  pausedAccounts: [],
  closeToTray: true,
};

const ENTRY: LibraryEntry = { folder: "username", layout: "byType" };

function advanced(overrides: Partial<Advanced> = {}): Advanced {
  return {
    imageSize: "orig",
    retweets: false,
    replies: true,
    writeMetadata: false,
    noSkip: false,
    cookies: { browser: "firefox" },
    ...overrides,
  };
}

function spec(overrides: Partial<JobSpec> = {}, extraAdvanced: Partial<Advanced> = {}): JobSpec {
  return {
    site: "x",
    account: "username",
    media: "all",
    layout: { kind: "byType" },
    simulate: false,
    advanced: advanced(extraAdvanced),
    ...overrides,
  };
}

function run(id: string, runSpec: JobSpec, overrides: Partial<Run> = {}): Run {
  return {
    id,
    spec: runSpec,
    steps: [],
    status: "done",
    stepIndex: 0,
    counts: { saved: 0, skipped: 0, failed: 0 },
    startedAt: `${id.slice(0, 10)}T${id.slice(11, 13)}:${id.slice(14, 16)}:${id.slice(17, 19)}.000Z`,
    ...overrides,
  };
}

function expectOk<T>(result: ActionResult<T>): T {
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return result.data;
}

describe("buildUpdateSpec", () => {
  it("drops the one-off parts of the last run and turns on stop-when-caught-up", () => {
    const previous = spec(
      {
        site: "instagram",
        account: "john_doe",
        folder: "john_doe",
        media: "videos",
        dateFrom: "2025-01-01",
        dateTo: "2025-01-31",
        layout: { kind: "byMonth" },
      },
      {
        imageSize: "large",
        sleepRequest: 2,
        sleep: 1,
        sleep429: 30,
        retries: 7,
        limitRate: "5M",
        filesizeMin: "10k",
        filesizeMax: "20M",
        abortAfterSkipped: 3,
        range: 5,
        retweets: true,
        replies: false,
        writeMetadata: true,
        noSkip: true,
        cookies: { browser: "chrome", profile: "Profile 1" },
        proxy: "http://127.0.0.1:8080",
      },
    );

    const plan = expectOk(
      buildUpdateSpec(
        "john_doe",
        { folder: "john_doe", layout: "byType" },
        [run("2026-11-10T09-00-00_john_doe", previous)],
        SETTINGS,
      ),
    );

    expect(plan.assumedSite).toBeUndefined();
    expect(plan.spec.simulate).toBe(false);
    expect(plan.spec).not.toHaveProperty("dateFrom");
    expect(plan.spec).not.toHaveProperty("dateTo");
    expect(plan.spec.advanced).not.toHaveProperty("range");
    expect(plan.spec.advanced.noSkip).toBe(false);
    // The previous run was limited to --range 5, so it never reached the older files.
    expect(plan.spec.advanced.abortAfterSkipped).toBeUndefined();
  });

  describe("stop when caught up", () => {
    const entry = { folder: "username", layout: "byType" as const };

    function planFor(previousRun: Run): JobSpec["advanced"] {
      return expectOk(buildUpdateSpec("username", entry, [previousRun], SETTINGS)).spec.advanced;
    }

    it("is turned on after a finished run that walked the whole account", () => {
      const advanced = planFor(run("2026-11-10T09-00-00_username", spec(), { status: "done" }));
      expect(advanced.abortAfterSkipped).toBe(CAUGHT_UP_AFTER);
    });

    it("is left off after a failed, stopped or interrupted run, which may leave a backlog", () => {
      for (const status of ["failed", "stopped", "interrupted"] as const) {
        const advanced = planFor(run("2026-11-10T09-00-00_username", spec({}, { abortAfterSkipped: 3 }), { status }));
        expect(advanced.abortAfterSkipped, status).toBeUndefined();
      }
    });

    it("is left off when the only record is a preview", () => {
      const preview = run("2026-11-10T09-00-00_username", spec({ simulate: true }), { status: "done" });
      expect(planFor(preview).abortAfterSkipped).toBeUndefined();
    });

    it("attaches sincePostId from archiveTip for X updates and respects retweets", () => {
      const tip = { tweetId: "2120165612320411776", timelineId: "2120999999999999999" };
      const doneRun = run("2026-11-10T09-00-00_username", spec(), { status: "done" });
      const ownOnly = expectOk(buildUpdateSpec("username", entry, [doneRun], SETTINGS, { archiveTip: tip }));
      expect(ownOnly.spec.advanced.sincePostId).toBe("2120165612320411776");
      expect(ownOnly.spec.advanced.abortAfterSkipped).toBe(CAUGHT_UP_AFTER);

      const withRetweets = run("2026-11-10T09-00-00_username", spec({}, { retweets: true }), { status: "done" });
      const rtPlan = expectOk(buildUpdateSpec("username", entry, [withRetweets], SETTINGS, { archiveTip: tip }));
      expect(rtPlan.spec.advanced.sincePostId).toBe("2120999999999999999");
    });

    it("stays incremental after a failed or stopped update that saved nothing when an earlier run finished done", () => {
      const tip = { tweetId: "2120165612320411776", timelineId: "2120165612320411776" };
      const earlierDone = run("2026-11-09T09-00-00_username", spec(), {
        status: "done",
        counts: { saved: 500, skipped: 0, failed: 0 },
      });
      const stoppedUpdate = run("2026-11-10T09-00-00_username", spec({}, { abortAfterSkipped: 20 }), {
        status: "stopped",
        counts: { saved: 0, skipped: 21, failed: 0 },
      });

      const plan = expectOk(
        buildUpdateSpec("username", entry, [stoppedUpdate, earlierDone], SETTINGS, { archiveTip: tip }),
      );
      expect(plan.spec.advanced.sincePostId).toBe("2120165612320411776");
      expect(plan.spec.advanced.abortAfterSkipped).toBe(CAUGHT_UP_AFTER);
    });

    it("falls back to the last completed run checkpoint when a newer failed run partially saved files", () => {
      const tip = { tweetId: "2122000000000000000", timelineId: "2122000000000000000" };
      const earlierDone = run("2026-11-09T09-00-00_username", spec(), {
        status: "done",
        newestPostId: "2120000000000000000",
        counts: { saved: 500, skipped: 0, failed: 0 },
      });
      const partialFail = run("2026-11-10T09-00-00_username", spec(), {
        status: "failed",
        counts: { saved: 12, skipped: 0, failed: 1 },
      });

      const plan = expectOk(
        buildUpdateSpec("username", entry, [partialFail, earlierDone], SETTINGS, { archiveTip: tip }),
      );
      // Must not skip past the tweets whose images saved in Step 1 before Step 2 videos failed.
      expect(plan.spec.advanced.sincePostId).toBe("2120000000000000000");
      expect(plan.spec.advanced.abortAfterSkipped).toBeUndefined();
    });

    it("derives a snowflake floor from startedAt when the last completed run predates newestPostId", () => {
      const tip = { tweetId: "2125000000000000000", timelineId: "2125000000000000000" };
      const earlierDone = run("2026-11-09T09-00-00_username", spec(), {
        status: "done",
        startedAt: "2026-11-09T09:00:00.000Z",
        counts: { saved: 500, skipped: 0, failed: 0 },
      });
      const partialStop = run("2026-11-10T09-00-00_username", spec(), {
        status: "stopped",
        counts: { saved: 5, skipped: 0, failed: 0 },
      });

      const plan = expectOk(
        buildUpdateSpec("username", entry, [partialStop, earlierDone], SETTINGS, { archiveTip: tip }),
      );
      expect(plan.spec.advanced.sincePostId).toBeDefined();
      expect(BigInt(plan.spec.advanced.sincePostId!) < BigInt(tip.tweetId)).toBe(true);
      expect(plan.spec.advanced.abortAfterSkipped).toBeUndefined();
    });

    it("recovers an imported archive whose only grabberX runs were stopped while skipping existing files", () => {
      const tip = { tweetId: "2118299780522877396", timelineId: "2118299780522877396" };
      const stopped1 = run("2026-11-12T03-31-40_username", spec({}, { abortAfterSkipped: 20 }), {
        status: "stopped",
        counts: { saved: 0, skipped: 21, failed: 0 },
      });
      const stopped2 = run("2026-11-12T08-19-00_username", spec(), {
        status: "stopped",
        counts: { saved: 0, skipped: 414, failed: 0 },
      });

      const plan = expectOk(
        buildUpdateSpec("username", entry, [stopped2, stopped1], SETTINGS, { archiveTip: tip }),
      );
      expect(plan.spec.advanced.sincePostId).toBe("2118299780522877396");
      expect(plan.spec.advanced.abortAfterSkipped).toBe(CAUGHT_UP_AFTER);
    });

    it("does not trust a prior done run that had narrower media coverage or a date window", () => {
      const tip = { tweetId: "2120165612320411776", timelineId: "2120165612320411776" };
      const imagesOnlyDone = run("2026-11-09T09-00-00_username", spec({ media: "images" }), { status: "done" });
      const stoppedAll = run("2026-11-10T09-00-00_username", spec({ media: "all" }), {
        status: "stopped",
        counts: { saved: 10, skipped: 0, failed: 0 },
      });

      const plan = expectOk(
        buildUpdateSpec("username", entry, [stoppedAll, imagesOnlyDone], SETTINGS, { archiveTip: tip }),
      );
      expect(plan.spec.advanced.sincePostId).toBeUndefined();
      expect(plan.spec.advanced.abortAfterSkipped).toBeUndefined();

      const datedDone = run("2026-11-10T09-00-00_username", spec({ dateFrom: "2026-01-01" }), { status: "done" });
      const datedPlan = expectOk(
        buildUpdateSpec("username", entry, [datedDone], SETTINGS, { archiveTip: tip }),
      );
      expect(datedPlan.spec.advanced.sincePostId).toBeUndefined();
      expect(datedPlan.spec.advanced.abortAfterSkipped).toBeUndefined();
    });

    it("drops a stale sincePostId when a full walk is required and never sets it for non-X sites", () => {
      const tip = { tweetId: "2120165612320411776", timelineId: "2120165612320411776" };
      const partialFirst = run(
        "2026-11-10T09-00-00_username",
        spec({}, { sincePostId: "1999999999999999999" }),
        { status: "failed", counts: { saved: 10, skipped: 0, failed: 1 } },
      );
      const xPlan = expectOk(buildUpdateSpec("username", entry, [partialFirst], SETTINGS, { archiveTip: tip }));
      expect(xPlan.spec.advanced.sincePostId).toBeUndefined();

      const instaDone = run("2026-11-10T09-00-00_username", spec({ site: "instagram" }), { status: "done" });
      const instaPlan = expectOk(buildUpdateSpec("username", entry, [instaDone], SETTINGS, { archiveTip: tip }));
      expect(instaPlan.spec.advanced.sincePostId).toBeUndefined();
      expect(instaPlan.spec.advanced.abortAfterSkipped).toBe(CAUGHT_UP_AFTER);
    });
  });

  it("keeps the account preferences that are not one-offs", () => {
    const previous = spec(
      {
        site: "instagram",
        account: "john_doe",
        folder: "john_doe",
        media: "videos",
        layout: { kind: "byMonth" },
      },
      {
        imageSize: "large",
        sleepRequest: 2,
        sleep: 1,
        sleep429: 30,
        retries: 7,
        limitRate: "5M",
        filesizeMin: "10k",
        filesizeMax: "20M",
        retweets: true,
        replies: false,
        writeMetadata: true,
        cookies: { browser: "chrome", profile: "Profile 1" },
        proxy: "http://127.0.0.1:8080",
      },
    );

    const plan = expectOk(
      buildUpdateSpec(
        "john_doe",
        { folder: "john_doe", layout: "flat" },
        [run("2026-11-10T09-00-00_john_doe", previous)],
        SETTINGS,
      ),
    );

    expect(plan.spec.site).toBe("instagram");
    expect(plan.spec.account).toBe("john_doe");
    expect(plan.spec.folder).toBe("john_doe");
    expect(plan.spec.media).toBe("videos");
    expect(plan.spec.layout).toEqual({ kind: "byMonth" });
    expect(plan.spec.advanced).toMatchObject({
      imageSize: "large",
      sleepRequest: 2,
      sleep: 1,
      sleep429: 30,
      retries: 7,
      limitRate: "5M",
      filesizeMin: "10k",
      filesizeMax: "20M",
      retweets: true,
      replies: false,
      writeMetadata: true,
      cookies: { browser: "chrome", profile: "Profile 1" },
      proxy: "http://127.0.0.1:8080",
    });
  });

  it("prefers the newest real run over any preview, whatever order the history arrives in", () => {
    const olderReal = spec({ layout: { kind: "flat" } });
    const newerReal = spec({ layout: { kind: "byMonth" } });
    const newestPreview = spec({ layout: { kind: "byTypeYear" }, simulate: true });

    const runs = [
      run("2026-11-10T09-00-00_username", newestPreview, { startedAt: "2026-11-10T12:00:00.000Z" }),
      run("2026-11-08T09-00-00_username", olderReal, { startedAt: "2026-11-08T09:00:00.000Z" }),
      run("2026-11-09T09-00-00_username", newerReal, { startedAt: "2026-11-09T09:00:00.000Z" }),
    ];

    const plan = expectOk(buildUpdateSpec("username", ENTRY, runs, SETTINGS));

    expect(plan.spec.layout).toEqual({ kind: "byMonth" });
    expect(plan.spec.simulate).toBe(false);
  });

  it("falls back to a preview run's account and layout when that is all the history there is", () => {
    const preview = spec(
      { site: "bluesky", account: "name.bsky.social", folder: "name.bsky.social", layout: { kind: "byTypeYear" }, simulate: true },
      { range: 3 },
    );

    const plan = expectOk(
      buildUpdateSpec(
        "name.bsky.social",
        { folder: "name.bsky.social", layout: "flat" },
        [run("2026-11-10T09-00-00_name.bsky.social", preview)],
        SETTINGS,
      ),
    );

    expect(plan.spec.site).toBe("bluesky");
    expect(plan.spec.account).toBe("name.bsky.social");
    expect(plan.spec.layout).toEqual({ kind: "byTypeYear" });
    expect(plan.spec.simulate).toBe(false);
    expect(plan.spec.advanced).not.toHaveProperty("range");
  });

  it("matches the run folder case-insensitively, like the queue does", () => {
    const previous = spec({ account: "USERNAME", layout: { kind: "byMonth" } });

    const plan = expectOk(
      buildUpdateSpec(
        "username",
        ENTRY,
        [run("2026-11-10T09-00-00_USERNAME", previous)],
        SETTINGS,
      ),
    );

    expect(plan.spec.account).toBe("USERNAME");
    expect(plan.spec.layout).toEqual({ kind: "byMonth" });
  });

  it("matches a run that wrote into the folder through a folder override", () => {
    const previous = spec({ account: "real_handle", folder: "username", layout: { kind: "byMonth" } });

    const plan = expectOk(
      buildUpdateSpec(
        "username",
        ENTRY,
        [run("2026-11-10T09-00-00_username", previous)],
        SETTINGS,
      ),
    );

    expect(plan.spec.account).toBe("real_handle");
    expect(plan.spec.folder).toBe("username");
  });

  it("assumes X for a handle-shaped folder with no history and uses the layout on disk", () => {
    const plan = expectOk(
      buildUpdateSpec(
        "alice",
        { folder: "alice", layout: "byTypeYear" },
        [],
        { ...SETTINGS, defaultMedia: "images" },
      ),
    );

    expect(plan.assumedSite).toBe("x");
    expect(plan.spec.site).toBe("x");
    expect(plan.spec.account).toBe("alice");
    expect(plan.spec.media).toBe("images");
    expect(plan.spec.layout).toEqual({ kind: "byTypeYear" });
    expect(plan.spec.simulate).toBe(false);
    expect(plan.spec.advanced.noSkip).toBe(false);
    expect(plan.spec.advanced.abortAfterSkipped).toBe(CAUGHT_UP_AFTER);
    expect(plan.spec.advanced.cookies).toEqual(SETTINGS.cookies);
  });

  it("falls back to byType when the layout on disk is unknown", () => {
    const plan = expectOk(
      buildUpdateSpec("alice", { folder: "alice", layout: "unknown" }, [], SETTINGS),
    );

    expect(plan.spec.layout).toEqual({ kind: "byType" });
  });

  it("refuses a folder it cannot place on X instead of borrowing another account's spec", () => {
    const other = run("2026-11-10T09-00-00_bob", spec({ account: "bob" }));

    const result = buildUpdateSpec("john.doe", { folder: "john.doe", layout: "byType" }, [other], SETTINGS);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(
      "grabberX doesn't know which site john.doe came from. Run it once from the Run page first.",
    );
  });
});
