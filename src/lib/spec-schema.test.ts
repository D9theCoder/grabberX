import { describe, expect, it } from "vitest";
import { parseJobSpec } from "@/lib/spec-schema";
import type { ActionResult, JobSpec } from "@/lib/spec";

function validInput(overrides: Record<string, unknown> = {}) {
  return {
    site: "x",
    account: "@username",
    media: "images",
    layout: { kind: "byType" },
    simulate: false,
    advanced: {
      imageSize: "orig",
      retweets: false,
      replies: false,
      writeMetadata: false,
      noSkip: false,
      cookies: { browser: "firefox" },
    },
    ...overrides,
  };
}

function parse(overrides: Record<string, unknown> = {}): ActionResult<JobSpec> {
  return parseJobSpec(validInput(overrides));
}

function error(overrides: Record<string, unknown>): string {
  const result = parse(overrides);
  if (result.ok) throw new Error("expected a rejection");
  return result.error;
}

function advanced(overrides: Record<string, unknown>) {
  return {
    advanced: {
      ...validInput().advanced,
      ...overrides,
    },
  };
}

describe("parseJobSpec: valid input", () => {
  it("normalizes the account and keeps the rest", () => {
    const result = parse();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.account).toBe("username");
    expect(result.data.site).toBe("x");
    expect(result.data.layout).toEqual({ kind: "byType" });
  });

  it("accepts a profile URL as the account", () => {
    const result = parse({ account: "https://x.com/username/media" });
    expect(result.ok && result.data.account).toBe("username");
  });

  it("accepts site url with a pasted URL", () => {
    const result = parse({ site: "url", account: "https://example.com/a/b" });
    expect(result.ok && result.data.account).toBe("https://example.com/a/b");
  });

  it("accepts a full custom template", () => {
    const result = parse({
      layout: {
        kind: "custom",
        template: ["{date:%Y}-{tweet_id}", "{author[name]}", "{user[name]}"],
      },
    });
    expect(result.ok).toBe(true);
  });

  it("accepts equal dates and a real leap day", () => {
    expect(
      parse({ dateFrom: "2024-02-29", dateTo: "2024-02-29" }).ok,
    ).toBe(true);
  });

  it("fills in the advanced defaults", () => {
    const result = parseJobSpec({
      site: "x",
      account: "username",
      media: "all",
      layout: { kind: "flat" },
      simulate: true,
      advanced: {},
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.advanced).toMatchObject({
      imageSize: "orig",
      retweets: false,
      replies: true,
      cookies: { browser: "firefox" },
    });
  });

  it("accepts socks and http proxies", () => {
    expect(
      parse(advanced({ proxy: "socks5h://127.0.0.1:9050" })).ok,
    ).toBe(true);
    expect(parse(advanced({ proxy: "https://proxy.test:8443" })).ok).toBe(true);
  });
});

describe("parseJobSpec: shape", () => {
  it("rejects non-objects", () => {
    for (const input of [null, undefined, 42, "spec", [], true]) {
      const result = parseJobSpec(input);
      expect(result.ok).toBe(false);
    }
  });

  it("rejects unknown top-level keys", () => {
    expect(error({ extra: 1 })).toBe("Unknown setting.");
  });

  it("rejects unknown keys inside advanced and layout", () => {
    expect(error(advanced({ wat: true }))).toBe("Unknown setting.");
    expect(error({ layout: { kind: "flat", template: [] } })).toBe(
      "Unknown setting.",
    );
  });

  it("rejects a missing or wrongly typed simulate", () => {
    expect(error({ simulate: undefined })).toBe(
      "Some settings are missing or invalid.",
    );
    expect(error({ simulate: "yes" })).toBe(
      "Some settings are missing or invalid.",
    );
  });

  it("rejects unknown enum values", () => {
    expect(error({ site: "tumblr" })).toBe("Pick a site.");
    expect(error({ media: "everything" })).toBe("Pick images, videos or both.");
    expect(error(advanced({ imageSize: "huge" }))).toBe("Pick an image size.");
    expect(
      error(advanced({ cookies: { browser: "safari" } })),
    ).toBe("Pick a browser.");
    expect(error({ layout: { kind: "byAuthor" } })).toBe("Pick a folder layout.");
  });
});

describe("parseJobSpec: account", () => {
  it("uses the site handle rule", () => {
    expect(error({ account: "this_handle_16ch" })).toBe(
      "X handles are 1–15 letters, numbers or _",
    );
    expect(error({ account: "" })).toBe("Enter an account.");
    expect(error({ site: "url", account: "example.com" })).toBe(
      "Enter the full URL, starting with http:// or https://",
    );
  });
});

describe("parseJobSpec: folder", () => {
  it("rejects separators, drive letters and traversal", () => {
    const message =
      "Use 1–64 letters, numbers, dots, dashes or _ for the folder name.";
    expect(error({ folder: "a/b" })).toBe(message);
    expect(error({ folder: "C:\\x" })).toBe(message);
    expect(error({ folder: "../x" })).toBe(message);
    expect(error({ folder: "a".repeat(65) })).toBe(message);
  });

  it("rejects . and ..", () => {
    expect(error({ folder: "." })).toBe("Folder names can't end with a dot.");
    expect(error({ folder: ".." })).toBe("Folder names can't end with a dot.");
    expect(error({ folder: "trailing." })).toBe(
      "Folder names can't end with a dot.",
    );
  });

  it("accepts a plain name", () => {
    const result = parse({ folder: "acct.main-2" });
    expect(result.ok && result.data.folder).toBe("acct.main-2");
  });
});

describe("parseJobSpec: dates", () => {
  it("rejects a malformed date", () => {
    expect(error({ dateFrom: "2025-2-3" })).toBe("Use dates like 2025-10-31.");
    expect(error({ dateTo: "31.10.2025" })).toBe("Use dates like 2025-10-31.");
  });

  it("rejects a date that does not exist", () => {
    expect(error({ dateFrom: "2025-02-30" })).toBe("That date doesn't exist.");
    expect(error({ dateTo: "2025-13-01" })).toBe("That date doesn't exist.");
    expect(error({ dateTo: "9999-12-31" })).toBe("Use a date before the year 9999.");
  });

  it("rejects a start date after the end date", () => {
    expect(error({ dateFrom: "2025-05-01", dateTo: "2025-04-30" })).toBe(
      "Start date is after end date.",
    );
  });
});

describe("parseJobSpec: custom template", () => {
  const shape =
    "Use letters, numbers, spaces, . - _ and {tokens} in folder segments, and no / or \\.";

  it("rejects empty and oversized templates", () => {
    expect(error({ layout: { kind: "custom", template: [] } })).toBe(
      "Use 1 to 6 folder segments.",
    );
    expect(
      error({
        layout: {
          kind: "custom",
          template: ["{date:%Y}", "a", "b", "c", "d", "e", "f"],
        },
      }),
    ).toBe("Use 1 to 6 folder segments.");
    expect(error({ layout: { kind: "custom", template: [""] } })).toBe(
      "A folder segment can't be empty.",
    );
  });

  it("rejects path separators, drive letters and traversal", () => {
    expect(error({ layout: { kind: "custom", template: ["a/b"] } })).toBe(shape);
    expect(error({ layout: { kind: "custom", template: ["C:\\x"] } })).toBe(shape);
    expect(error({ layout: { kind: "custom", template: ["{date}/../x"] } })).toBe(
      shape,
    );
    expect(error({ layout: { kind: "custom", template: [".."] } })).toBe(
      "A folder segment can't contain ..",
    );
    expect(error({ layout: { kind: "custom", template: ["a/../../b"] } })).toBe(
      shape,
    );
  });

  it("rejects unknown placeholders", () => {
    expect(error({ layout: { kind: "custom", template: ["{nope}"] } })).toBe(
      "{nope} can't be used in a folder segment.",
    );
  });

  it("accepts formats and sub-keys", () => {
    const result = parse({
      layout: {
        kind: "custom",
        template: ["{date:%Y-%m}", "{tweet_id}-{num}", "{author[name]}"],
      },
    });
    expect(result.ok).toBe(true);
  });
});

describe("parseJobSpec: advanced numbers", () => {
  it("bounds sleeps", () => {
    expect(error(advanced({ sleepRequest: 601 }))).toBe("Use 0 to 600 seconds.");
    expect(error(advanced({ sleep: -1 }))).toBe("Use 0 to 600 seconds.");
    expect(parse(advanced({ sleep: 2.5 })).ok).toBe(true);
  });

  it("bounds counts", () => {
    expect(error(advanced({ retries: 21 }))).toBe("Use 0 to 20 retries.");
    expect(error(advanced({ retries: 1.5 }))).toBe("Use 0 to 20 retries.");
    expect(error(advanced({ abortAfterSkipped: 0 }))).toBe("Use 1 to 1000 files.");
    expect(error(advanced({ range: 0 }))).toBe("Use 1 to 100000 files.");
    expect(error(advanced({ range: 100_001 }))).toBe("Use 1 to 100000 files.");
  });

  it("checks size strings and proxy URLs", () => {
    expect(error(advanced({ limitRate: "abc" }))).toBe("Use a size like 200k or 5M.");
    expect(error(advanced({ filesizeMin: "2 MB" }))).toBe(
      "Use a size like 200k or 5M.",
    );
    expect(error(advanced({ proxy: "ftp://x" }))).toBe(
      "Use a proxy URL like http://127.0.0.1:8080.",
    );
  });

  it("rejects a bad cookie profile", () => {
    expect(
      error(advanced({ cookies: { browser: "firefox", profile: "a/b" } })),
    ).toBe("Profile names use letters, numbers, spaces, dots, - or _.");
  });
});
