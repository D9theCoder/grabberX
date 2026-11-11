import { describe, expect, it } from "vitest";
import { isUnchangedFolderName, updateAccountMessage, updateAllMessage } from "@/lib/update-messages";

describe("updateAllMessage", () => {
  it("counts the queued updates and names the folders that are already running", () => {
    const message = updateAllMessage({
      started: 3,
      skipped: [{ folder: "username", reason: "already running" }],
      assumed: [],
    });

    expect(message).toEqual({
      tone: "info",
      text: "3 updates queued. Skipped: username (already running).",
    });
  });

  it("names the folders whose site was assumed to be X", () => {
    const message = updateAllMessage({
      started: 2,
      skipped: [],
      assumed: ["alice", "bob"],
    });

    expect(message).toEqual({
      tone: "info",
      text: "2 updates queued. Assumed X for alice, bob.",
    });
  });

  it("uses the danger tone only for a real refusal", () => {
    const message = updateAllMessage({
      started: 1,
      skipped: [
        {
          folder: "john.doe",
          reason: "gather doesn't know which site john.doe came from. Run it once from the Run page first.",
        },
      ],
      assumed: [],
    });

    expect(message.tone).toBe("danger");
    expect(message.text).toBe(
      "1 update queued. Skipped john.doe: gather doesn't know which site john.doe came from. " +
        "Run it once from the Run page first.",
    );
  });

  it("keeps the info tone when everything was already queued or running", () => {
    const message = updateAllMessage({
      started: 0,
      skipped: [
        { folder: "username", reason: "already running" },
        { folder: "bob", reason: "already queued" },
      ],
      assumed: [],
    });

    expect(message).toEqual({
      tone: "info",
      text: "No updates queued. Skipped: username (already running), bob (already queued).",
    });
  });

  it("uses the singular for one update and never shouts", () => {
    const message = updateAllMessage({ started: 1, skipped: [], assumed: [] });

    expect(message.text).toBe("1 update queued.");
    expect(message.text).not.toContain("!");
  });
});

describe("updateAccountMessage", () => {
  it("says when the X site was assumed for the folder", () => {
    const message = updateAccountMessage("alice", { runId: "run-1", assumedSite: "x" });

    expect(message).toEqual({
      tone: "info",
      text: "Assumed X for alice. Update for alice is queued. Follow it on the Run page.",
    });
  });

  it("stays quiet about the site when the history already knew it", () => {
    const message = updateAccountMessage("username", { runId: "run-1" });

    expect(message).toEqual({
      tone: "info",
      text: "Update for username is queued. Follow it on the Run page.",
    });
  });
});

describe("isUnchangedFolderName", () => {
  it("lets a case-only rename through to the server", () => {
    expect(isUnchangedFolderName("username", "Username")).toBe(false);
  });

  it("flags only an identical name as unchanged", () => {
    expect(isUnchangedFolderName("username", "username")).toBe(true);
    expect(isUnchangedFolderName("username", "other")).toBe(false);
  });
});
