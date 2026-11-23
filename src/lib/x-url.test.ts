import { describe, expect, it } from "vitest";
import {
  extractXAccountFromShare,
  extractXPostFromShare,
  extractXPostFromText,
  interpretDownloadInput,
  parseXHandle,
  parseXPostUrl,
} from "@/lib/x-url";

describe("parseXHandle", () => {
  it("accepts valid 1-15 char handles with optional leading @", () => {
    expect(parseXHandle("alice")).toBe("alice");
    expect(parseXHandle("  @Alice_123  ")).toBe("Alice_123");
    expect(parseXHandle("a".repeat(15))).toBe("a".repeat(15));
  });

  it("rejects invalid handles", () => {
    for (const bad of ["", "@", "@@alice", "bad-handle", "a".repeat(16), "alice/media", "https://x.com/alice"]) {
      expect(parseXHandle(bad), bad).toBeNull();
    }
  });
});

describe("parseXPostUrl", () => {
  it("parses x.com, twitter.com, and mobile/www variants with query params and rebuilds canonical URL", () => {
    const cases: Array<[string, string, string]> = [
      ["https://x.com/alice_art/status/1834220145123456789", "alice_art", "1834220145123456789"],
      ["http://twitter.com/Bob/status/999?s=20&t=abc", "Bob", "999"],
      ["https://mobile.twitter.com/carol_1/status/123456/photo/1", "carol_1", "123456"],
      ["https://www.x.com/dave/status/77777#m", "dave", "77777"],
      ["https://m.twitter.com/eve/status/42/", "eve", "42"],
    ];
    for (const [raw, handle, postId] of cases) {
      expect(parseXPostUrl(raw), raw).toEqual({
        handle,
        postId,
        canonicalUrl: `https://x.com/${handle}/status/${postId}`,
      });
    }
  });

  it("rejects non-X hosts, non-status URLs, /i/status, and malformed handles or ids", () => {
    for (const bad of [
      "",
      "alice",
      "x.com/alice/status/123",
      "https://evil.com/alice/status/123",
      "https://evil.x.com/alice/status/123",
      "https://x.com/i/status/123",
      "https://x.com/i/web/status/123",
      "https://x.com/alice/media",
      "https://x.com/bad-handle/status/123",
      "https://x.com/too_long_handle_1/status/123",
      "https://x.com/alice/status/not_digits",
      "https://x.com/alice/status/",
      "https://user:pass@x.com/alice/status/123",
      "https://x.com:8443/alice/status/123",
      "javascript:https://x.com/alice/status/123",
    ]) {
      expect(parseXPostUrl(bad), bad).toBeNull();
    }
  });
});

describe("extractXPostFromText & extractXPostFromShare", () => {
  it("extracts the first X status URL from Android share text with surrounding copy and punctuation", () => {
    expect(
      extractXPostFromText("Look at this drawing! https://x.com/artist_1/status/1834220145123?s=20 #art"),
    ).toEqual({
      handle: "artist_1",
      postId: "1834220145123",
      canonicalUrl: "https://x.com/artist_1/status/1834220145123",
    });

    expect(
      extractXPostFromText("Check https://example.com/other then (https://mobile.twitter.com/bob/status/555?t=1)."),
    ).toEqual({
      handle: "bob",
      postId: "555",
      canonicalUrl: "https://x.com/bob/status/555",
    });
  });

  it("reads Android X shares when the link is inside text rather than url", () => {
    expect(
      extractXPostFromShare({
        title: "Artist on X",
        text: "New sketch\nhttps://x.com/artist_1/status/1900000000001?s=19",
        url: "",
      }),
    ).toEqual({
      handle: "artist_1",
      postId: "1900000000001",
      canonicalUrl: "https://x.com/artist_1/status/1900000000001",
    });
  });

  it("prefers url when present and falls back to title", () => {
    expect(
      extractXPostFromShare({
        url: "https://twitter.com/from_url/status/111?s=20",
        text: "https://x.com/from_text/status/222",
      })?.handle,
    ).toBe("from_url");

    expect(
      extractXPostFromShare({
        title: "https://x.com/from_title/status/333",
      })?.postId,
    ).toBe("333");

    expect(extractXPostFromShare({ text: "hello world https://example.com/post/1" })).toBeNull();
  });

  it("falls back to extracting a profile handle when no status URL is present", () => {
    expect(extractXAccountFromShare({ text: "Follow https://x.com/alice_art?s=20" })).toBe("alice_art");
    expect(extractXAccountFromShare({ text: "https://x.com/i/bookmarks" })).toBeNull();
  });
});

describe("interpretDownloadInput", () => {
  it("classifies empty, post URLs, bare/URL accounts, and invalid strings", () => {
    expect(interpretDownloadInput("   ")).toEqual({ kind: "empty" });
    expect(interpretDownloadInput("x.com/alice/status/12345?s=20")).toEqual({
      kind: "post",
      post: { handle: "alice", postId: "12345", canonicalUrl: "https://x.com/alice/status/12345" },
    });
    expect(interpretDownloadInput("@alice")).toEqual({ kind: "account", handle: "alice" });
    expect(interpretDownloadInput("https://x.com/alice/media")).toEqual({ kind: "account", handle: "alice" });
    expect(interpretDownloadInput("https://example.com/not-x")).toEqual({ kind: "invalid" });
  });
});
