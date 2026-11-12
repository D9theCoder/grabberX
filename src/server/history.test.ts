import { describe, expect, it, vi } from "vitest";
import { createDefaultSpec } from "@/lib/spec";
import type { Run } from "@/lib/spec";

function run(id: string, status: Run["status"], saved: number): Run {
  return {
    id,
    spec: createDefaultSpec({ defaultMedia: "all", defaultLayout: { kind: "byType" }, cookies: { browser: "firefox" } }),
    steps: [],
    status,
    stepIndex: 0,
    counts: { saved, skipped: 0, failed: 0 },
  };
}

const onDisk = [run("2026-11-12T10-00-02_beta", "running", 0), run("2026-11-12T09-00-00_alpha", "done", 40)];
const live = run("2026-11-12T10-00-02_beta", "running", 17);

vi.mock("server-only", () => ({}));
vi.mock("@/server/run-queue", () => ({
  runQueue: {
    whenReady: () => Promise.resolve(),
    list: () => [live],
    get: (id: string) => (id === live.id ? live : undefined),
  },
}));
vi.mock("@/server/store", () => ({
  listRuns: () => Promise.resolve(onDisk),
  getRun: (id: string) => Promise.resolve(onDisk.find((entry) => entry.id === id)),
}));

import { getRunLive, listRunsLive } from "@/server/history";

describe("history with live runs", () => {
  it("shows an active run's live counts instead of the 0 on disk", async () => {
    const runs = await listRunsLive();
    expect(runs.map((entry) => entry.counts.saved)).toEqual([17, 40]);
    expect((await getRunLive(live.id))?.counts.saved).toBe(17);
    expect((await getRunLive("2026-11-12T09-00-00_alpha"))?.counts.saved).toBe(40);
  });
});
