import { describe, expect, it } from "vitest";
import { extractSharedLink } from "@/lib/share-link";

describe("extractSharedLink", () => {
  it("reads an X post the Android X app puts inside text, and keeps its account", () => {
    const link = extractSharedLink({
      title: "Artist on X",
      text: "New sketch\nhttps://x.com/artist_1/status/1900000000001?s=19",
      url: "",
    });
    expect(link?.site?.id).toBe("x");
    expect(link?.account).toBe("artist_1");
    expect(link?.post).toEqual({
      handle: "artist_1",
      postId: "1900000000001",
      canonicalUrl: "https://x.com/artist_1/status/1900000000001",
    });
  });

  it("prefers an X post over other links in the same text, and trims punctuation", () => {
    const link = extractSharedLink({
      text: "Check https://example.com/other then (https://mobile.twitter.com/bob/status/555?t=1).",
    });
    expect(link?.post?.canonicalUrl).toBe("https://x.com/bob/status/555");
  });

  it("prefers url, then text, then title", () => {
    expect(
      extractSharedLink({ url: "https://twitter.com/from_url/status/111", text: "https://x.com/from_text/status/222" })
        ?.post?.handle,
    ).toBe("from_url");
    expect(extractSharedLink({ title: "https://x.com/from_title/status/333" })?.post?.postId).toBe("333");
  });

  it("recognises profiles on every named site", () => {
    expect(extractSharedLink({ url: "https://www.instagram.com/some.artist/" })).toMatchObject({
      site: { id: "instagram" },
      account: "some.artist",
      post: null,
    });
    expect(extractSharedLink({ text: "https://bsky.app/profile/name.bsky.social/post/3k" })).toMatchObject({
      site: { id: "bluesky" },
      account: "name.bsky.social",
    });
    expect(extractSharedLink({ url: "https://www.pixiv.net/en/users/12345" })).toMatchObject({
      site: { id: "pixiv" },
      account: "12345",
    });
    expect(extractSharedLink({ url: "https://www.reddit.com/user/someone/" })).toMatchObject({
      site: { id: "reddit" },
      account: "someone",
    });
  });

  it("keeps a post link of a named site without an account when its rules can't read one", () => {
    expect(extractSharedLink({ url: "https://www.instagram.com/p/AbC123/" })).toMatchObject({
      site: { id: "instagram" },
      account: null,
      post: null,
    });
  });

  it("falls back to any other web link, and ignores text without one", () => {
    expect(extractSharedLink({ text: "look https://example.com/gallery/42" })).toEqual({
      url: "https://example.com/gallery/42",
      site: null,
      account: null,
      post: null,
    });
    expect(extractSharedLink({ text: "no link here", title: "ftp://example.com/file" })).toBeNull();
  });
});
