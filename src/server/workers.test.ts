import { describe, expect, it } from "vitest";
import type { ProcessHandle, ProcessResult } from "@/server/runner";
import { combineResults, startWorkers } from "@/server/workers";

function fakeProcess(log: string[], name: string) {
  let finish: (result: ProcessResult) => void = () => {};
  const done = new Promise<ProcessResult>((resolve) => {
    finish = resolve;
  });
  const handle: ProcessHandle = {
    pid: 1,
    done,
    async stop() {
      log.push(`stop ${name}`);
      finish({ exitCode: 1 });
    },
  };
  return { handle, finish, start: () => (log.push(`start ${name}`), handle) };
}

describe("combineResults", () => {
  it("reports a spawn error first, then the first failure, else success", () => {
    expect(combineResults([{ exitCode: 0 }, { exitCode: 0 }])).toEqual({ exitCode: 0 });
    expect(combineResults([{ exitCode: 0 }, { exitCode: 4 }, { exitCode: 1 }])).toEqual({ exitCode: 4 });
    expect(combineResults([{ exitCode: 4 }, { exitCode: null, spawnError: "ENOENT" }])).toEqual({
      exitCode: null,
      spawnError: "ENOENT",
    });
  });
});

describe("startWorkers", () => {
  it("starts every worker and settles once all have ended", async () => {
    const log: string[] = [];
    const workers = [fakeProcess(log, "a"), fakeProcess(log, "b"), fakeProcess(log, "c")];
    const step = startWorkers(
      workers.map((worker) => worker.start),
      10,
      () => Promise.resolve(),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(log).toEqual(["start a", "start b", "start c"]);
    workers[0]!.finish({ exitCode: 0 });
    workers[1]!.finish({ exitCode: 4 });
    workers[2]!.finish({ exitCode: 0 });
    expect(await step.done).toEqual({ exitCode: 4 });
  });

  it("stops the started workers and never starts the rest", async () => {
    const log: string[] = [];
    const workers = [fakeProcess(log, "a"), fakeProcess(log, "b"), fakeProcess(log, "c")];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const step = startWorkers(
      workers.map((worker) => worker.start),
      10,
      () => gate,
    );
    await Promise.resolve();
    expect(log).toEqual(["start a"]);
    await step.stop();
    release();
    await step.done;
    expect(log).toEqual(["start a", "stop a"]);
  });
});
