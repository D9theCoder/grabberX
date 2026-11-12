import { describe, expect, it } from "vitest";
import { createDefaultSpec } from "@/lib/spec";
import type { Run } from "@/lib/spec";
import { summarizeTasks, taskCountLabel, taskDetail } from "@/lib/task-list";

function run(id: string, status: Run["status"], extra: Partial<Run> = {}): Run {
  return {
    id,
    spec: {
      ...createDefaultSpec({ defaultMedia: "all", defaultLayout: { kind: "byType" }, cookies: { browser: "firefox" } }),
      account: id.split("_")[1]!,
    },
    steps: [
      { label: "images", argv: [] },
      { label: "videos", argv: [] },
    ],
    status,
    stepIndex: 0,
    counts: { saved: 0, skipped: 0, failed: 0 },
    ...extra,
  };
}

describe("summarizeTasks", () => {
  it("lists running runs first, then the queue in order, and drops finished runs", () => {
    const runs = [
      run("2026-11-12T10-00-03_gamma", "queued"),
      run("2026-11-12T10-00-02_beta", "running", { startedAt: "2026-11-12T10:00:05.000Z", stepIndex: 1 }),
      run("2026-11-12T10-00-04_delta", "queued"),
      run("2026-11-12T10-00-01_alpha", "running", { startedAt: "2026-11-12T10:00:01.000Z" }),
      run("2026-11-12T09-00-00_omega", "done"),
    ];
    const order = ["2026-11-12T10-00-04_delta", "2026-11-12T10-00-03_gamma"];
    const tasks = summarizeTasks(runs, (id) => order.indexOf(id) + 1);
    expect(tasks.map((task) => task.folder)).toEqual(["alpha", "beta", "delta", "gamma"]);
    expect(tasks[1]).toMatchObject({ step: "videos", stepIndex: 1, steps: 2, position: 0 });
    expect(tasks[2]!.position).toBe(1);
  });
});

describe("task copy", () => {
  it("describes a running and a queued task", () => {
    const [running, queued] = summarizeTasks(
      [
        run("2026-11-12T10-00-01_alpha", "running", { counts: { saved: 1234, skipped: 0, failed: 2 } }),
        run("2026-11-12T10-00-02_beta", "queued"),
      ],
      () => 2,
    );
    expect(taskDetail(running!)).toBe("Images 1/2 · 1,234 saved · 2 failed");
    expect(taskDetail(queued!)).toBe("#2 in line");
    expect(taskCountLabel([running!, queued!])).toBe("1 running, 1 queued");
  });
});
