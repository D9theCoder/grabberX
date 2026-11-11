import { describe, expect, it } from "vitest";
import { retryTransient } from "@/server/fs-retry";

function failure(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe("retryTransient", () => {
  it("retries a busy file until it succeeds", async () => {
    let calls = 0;
    const result = await retryTransient(
      async () => {
        calls += 1;
        if (calls < 3) throw failure("EPERM");
        return "done";
      },
      { delayMs: 1 },
    );
    expect(result).toBe("done");
    expect(calls).toBe(3);
  });

  it("gives up after the last attempt and throws the original error", async () => {
    let calls = 0;
    await expect(
      retryTransient(
        async () => {
          calls += 1;
          throw failure("EBUSY");
        },
        { attempts: 3, delayMs: 1 },
      ),
    ).rejects.toMatchObject({ code: "EBUSY" });
    expect(calls).toBe(3);
  });

  it("does not retry other errors", async () => {
    let calls = 0;
    await expect(
      retryTransient(async () => {
        calls += 1;
        throw failure("ENOENT");
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(calls).toBe(1);
  });
});
