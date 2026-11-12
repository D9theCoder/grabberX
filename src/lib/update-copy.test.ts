import { describe, expect, it } from "vitest";
import { updateCopy } from "@/lib/update-copy";

const now = new Date("2026-11-12T10:00:00.000Z");

describe("updateCopy", () => {
  it("names each updater state", () => {
    expect(updateCopy({ state: "current", checkedAt: "2026-11-12T09:58:00.000Z" }, now).text).toBe(
      "grabberX is up to date. Checked 2 minutes ago.",
    );
    expect(updateCopy({ state: "downloading", version: "0.2.0", percent: 42 }, now).text).toBe(
      "Downloading grabberX 0.2.0 · 42%",
    );
    expect(updateCopy({ state: "ready", version: "0.2.0" }, now).text).toContain("installs by itself");
    expect(updateCopy({ state: "error", message: "offline", checkedAt: now.toISOString() }, now)).toEqual({
      tone: "danger",
      text: "Couldn't check for updates: offline",
    });
  });
});
