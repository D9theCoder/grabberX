import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import type { RunEvent } from "@/lib/spec";
import { startProcess } from "@/server/runner";

// No parser mock here: this is the seam between the real parser and the real spawn path.
const fixture = fileURLToPath(new URL("./__fixtures__/fake-gallery-dl.mjs", import.meta.url));
let sandbox = "";

afterAll(async () => {
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
});

it("turns gallery-dl's real output shape into file and log events", async () => {
  sandbox = await mkdtemp(join(tmpdir(), "gather-parser-"));
  const events: RunEvent[] = [];
  const handle = startProcess({
    exe: process.execPath,
    argv: [fixture, "--mode=lines"],
    cwd: sandbox,
    onEvent: (event) => events.push(event),
    onRaw: () => {},
  });

  expect(await handle.done).toEqual({ exitCode: 0 });

  expect(events).toContainEqual({
    t: "file",
    kind: "skipped",
    path: "/media/username/Image/1834220145_2.jpg",
  });
  expect(events).toContainEqual({
    t: "log",
    level: "warning",
    line: "[twitter][warning] 1834220146_1.jpg already exists",
  });
  expect(events.some((event) => event.t === "file" && event.kind === "saved")).toBe(true);
});
