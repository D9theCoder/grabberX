import { describe, expect, it } from "vitest";
import { FOLDER_PATTERN, folderNameFor, SITES, siteDef, validateAccount } from "@/lib/sites";

const X_INVALID = "X handles are 1–15 letters, numbers or _";

describe("validateAccount: x", () => {
  it("accepts a bare handle and an @ handle", () => {
    expect(validateAccount("x", "username")).toEqual({ ok: true, account: "username" });
    expect(validateAccount("x", "@username")).toEqual({ ok: true, account: "username" });
  });

  it("keeps the casing the user typed", () => {
    expect(validateAccount("x", "@Username")).toEqual({ ok: true, account: "Username" });
  });

  it("parses profile links with or without www, mobile and trailing paths", () => {
    for (const link of [
      "https://x.com/username/media",
      "https://www.x.com/username/",
      "https://x.com/username/with_replies",
      "https://mobile.twitter.com/username",
      "https://twitter.com/username",
      "http://x.com/@username",
      "x.com/username",
      "twitter.com/username/media",
    ]) {
      expect(validateAccount("x", link)).toEqual({ ok: true, account: "username" });
    }
  });

  it("rejects handles that break the 1-15 rule", () => {
    expect(validateAccount("x", "this_handle_16ch")).toEqual({
      ok: false,
      message: X_INVALID,
    });
    expect(validateAccount("x", "bad-handle")).toEqual({
      ok: false,
      message: X_INVALID,
    });
    expect(validateAccount("x", "")).toEqual({ ok: false, message: "Enter an account." });
  });

  it("rejects links to another site", () => {
    expect(validateAccount("x", "https://instagram.com/username")).toEqual({
      ok: false,
      message: siteDef("x").linkError,
    });
    expect(validateAccount("x", "https://x.com/i/bookmarks")).toEqual({
      ok: false,
      message: siteDef("x").linkError,
    });
  });
});

describe("validateAccount: beta sites", () => {
  it("accepts handles and profile links", () => {
    expect(validateAccount("instagram", "https://www.instagram.com/user.name/")).toEqual({
      ok: true,
      account: "user.name",
    });
    expect(validateAccount("bluesky", "https://bsky.app/profile/name.bsky.social")).toEqual({
      ok: true,
      account: "name.bsky.social",
    });
    expect(validateAccount("pixiv", "https://www.pixiv.net/en/users/12345/artworks")).toEqual({
      ok: true,
      account: "12345",
    });
    expect(validateAccount("reddit", "https://www.reddit.com/user/some_one/submitted/")).toEqual({
      ok: true,
      account: "some_one",
    });
  });

  it("rejects a handle that does not match the site", () => {
    expect(validateAccount("pixiv", "not-a-number").ok).toBe(false);
    expect(validateAccount("bluesky", "name.bsky.social!").ok).toBe(false);
  });
});

describe("validateAccount: url", () => {
  it("keeps the pasted URL as it is", () => {
    expect(validateAccount("url", "https://example.com/gallery/abc")).toEqual({
      ok: true,
      account: "https://example.com/gallery/abc",
    });
  });

  it("requires a scheme", () => {
    expect(validateAccount("url", "example.com/abc").ok).toBe(false);
    expect(validateAccount("url", "").ok).toBe(false);
  });
});

describe("SITES", () => {
  it("builds a URL per site", () => {
    expect(siteDef("x").urlFor("username")).toBe("https://x.com/username/media");
    expect(siteDef("instagram").urlFor("a")).toBe("https://www.instagram.com/a/");
    expect(siteDef("bluesky").urlFor("a")).toBe("https://bsky.app/profile/a");
    expect(siteDef("pixiv").urlFor("1")).toBe("https://www.pixiv.net/en/users/1");
    expect(siteDef("reddit").urlFor("a")).toBe(
      "https://www.reddit.com/user/a/submitted/",
    );
    expect(siteDef("url").urlFor("https://x.test/a")).toBe("https://x.test/a");
  });

  it("gives X the twitter media flags", () => {
    expect(siteDef("x").mediaOptions("images")).toEqual([
      "-o",
      "twitter.videos=false",
      "-o",
      "twitter.gifs=false",
      "--filter",
      "extension in ('jpg','jpeg','png','webp')",
    ]);
    expect(siteDef("x").mediaOptions("videos")).toEqual([
      "-o",
      "twitter.videos=true",
      "-o",
      "twitter.gifs=true",
      "--filter",
      "extension in ('mp4','webm','mov','m4v')",
    ]);
    expect(siteDef("instagram").mediaOptions("images")).toEqual([
      "--filter",
      "extension in ('jpg','jpeg','png','webp')",
    ]);
  });

  it("keeps X out of beta, with a size option", () => {
    expect(SITES.filter((site) => !site.beta).map((site) => site.id)).toEqual(["x"]);
    expect(SITES.filter((site) => site.supportsSize).map((site) => site.id)).toEqual(["x"]);
  });
});

describe("folderNameFor", () => {
  it("prefers the folder override", () => {
    expect(folderNameFor({ site: "x", account: "username", folder: "renamed" })).toBe("renamed");
  });

  it("uses the account otherwise", () => {
    expect(folderNameFor({ site: "x", account: "@username" })).toBe("username");
  });

  it("derives a folder from a URL host and last path segment", () => {
    expect(folderNameFor({ site: "url", account: "https://example.com/gallery/abc" })).toBe(
      "example.com_abc",
    );
    expect(folderNameFor({ site: "url", account: "https://example.com/" })).toBe("example.com");
  });

  it("always returns a safe folder name", () => {
    for (const account of [
      "https://example.com/a b",
      "https://example.com/a/../b",
      "https://example.com/../../etc",
    ]) {
      expect(folderNameFor({ site: "url", account })).toMatch(FOLDER_PATTERN);
    }
    expect(folderNameFor({ site: "x", account: "." })).toBe("account");
    expect(folderNameFor({ site: "x", account: "a".repeat(80) })).toHaveLength(64);
  });
});
