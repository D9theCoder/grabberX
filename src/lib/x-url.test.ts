import { describe, expect, it } from "vitest";
import { parseXPostUrl } from "@/lib/x-url";

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
