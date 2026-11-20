import { describe, expect, it } from "vitest";
import { DEFAULT_ADVANCED } from "@/lib/spec";
import {
  archiveTipFromEntries,
  checkpointFromIso,
  cutoffSiteOf,
  minPostId,
  parseTwitterArchiveEntry,
  postFilterFlagsFor,
  snowflakeIdFromIso,
  tipForSpec,
  twitterArchiveTip,
} from "@/lib/twitter-id";

describe("parseTwitterArchiveEntry", () => {
  it("parses standard and retweet gallery-dl archive keys", () => {
    expect(parseTwitterArchiveEntry("twitter2120165612320411776_0_2")).toEqual({
      tweetId: BigInt("2120165612320411776"),
      retweetId: BigInt(0),
    });
    expect(parseTwitterArchiveEntry("twitter1500000000000000000_2120165612320411776_1")).toEqual({
      tweetId: BigInt("1500000000000000000"),
      retweetId: BigInt("2120165612320411776"),
    });
  });

  it("ignores non-Twitter and malformed archive keys", () => {
    expect(parseTwitterArchiveEntry("instagram4028604394690902491")).toBeNull();
    expect(parseTwitterArchiveEntry("bunkrAhgsJLvT_V9lN3nO8")).toBeNull();
    expect(parseTwitterArchiveEntry("twitter_bad")).toBeNull();
  });
});

describe("archiveTipFromEntries", () => {
  it("compares 64-bit snowflake IDs numerically rather than lexicographically", () => {
    const tip = twitterArchiveTip([
      "twitter999_0_1",
      "twitter2120165612320411776_0_1",
      "twitter2120165612320411775_0_4",
      "twitter2120165612320411777_0_1",
    ]);
    expect(tip).toEqual({
      tweetId: "2120165612320411777",
      timelineId: "2120165612320411777",
    });
  });

  it("tracks X, Instagram, Fapello, and Pixiv tips independently in one archive", () => {
    const tip = archiveTipFromEntries([
      "twitter2000000000000000000_0_1",
      "twitter1500000000000000000_2100000000000000000_1",
      "instagram999",
      "instagram4033139353696657192",
      "fapellophoto_takomayuyi_999",
      "fapellovideo_takomayuyi_2466",
      "pixiv987654321_p0.jpg",
      "pixiv999_p0.jpg",
      "bunkrAhgsJLvT_V9lN3nO8",
    ]);
    expect(tip).toEqual({
      tweetId: "2000000000000000000",
      timelineId: "2100000000000000000",
      instagramId: "4033139353696657192",
      fapelloId: "2466",
      pixivId: "987654321",
    });
  });

  it("returns undefined when no cutoff-capable entries are present", () => {
    expect(archiveTipFromEntries([])).toBeUndefined();
    expect(archiveTipFromEntries(["bunkrAhgsJLvT_V9lN3nO8"])).toBeUndefined();
  });
});

describe("cutoffSiteOf and tipForSpec", () => {
  const tip = {
    tweetId: "2100",
    timelineId: "2200",
    instagramId: "4033",
    fapelloId: "2466",
    pixivId: "9876",
  };

  it("detects named sites and pasted URLs", () => {
    expect(cutoffSiteOf({ site: "x", account: "alice" })).toBe("x");
    expect(cutoffSiteOf({ site: "instagram", account: "alice" })).toBe("instagram");
    expect(cutoffSiteOf({ site: "pixiv", account: "12345" })).toBe("pixiv");
    expect(cutoffSiteOf({ site: "url", account: "https://fapello.com/takomayuyi/" })).toBe("fapello");
    expect(cutoffSiteOf({ site: "url", account: "https://www.instagram.com/alice/" })).toBe("instagram");
    expect(cutoffSiteOf({ site: "url", account: "https://x.com/alice/media" })).toBe("x");
    expect(cutoffSiteOf({ site: "url", account: "https://bunkr.cr/a/AhgsJLvT" })).toBeNull();
    expect(cutoffSiteOf({ site: "bluesky", account: "a.bsky.social" })).toBeNull();
    expect(cutoffSiteOf({ site: "reddit", account: "alice" })).toBeNull();
  });

  it("selects the right site id from a mixed archive tip", () => {
    expect(tipForSpec({ site: "x", account: "a", advanced: DEFAULT_ADVANCED }, tip)).toBe("2100");
    expect(
      tipForSpec({ site: "x", account: "a", advanced: { ...DEFAULT_ADVANCED, retweets: true } }, tip),
    ).toBe("2200");
    expect(tipForSpec({ site: "instagram", account: "a", advanced: DEFAULT_ADVANCED }, tip)).toBe("4033");
    expect(
      tipForSpec({ site: "url", account: "https://fapello.com/a/", advanced: DEFAULT_ADVANCED }, tip),
    ).toBe("2466");
    expect(tipForSpec({ site: "pixiv", account: "12", advanced: DEFAULT_ADVANCED }, tip)).toBe("9876");
    expect(tipForSpec({ site: "reddit", account: "a", advanced: DEFAULT_ADVANCED }, tip)).toBeUndefined();
  });
});

describe("postFilterFlagsFor", () => {
  it("builds site-appropriate post-level abort/terminate expressions", () => {
    expect(postFilterFlagsFor("x", "123")).toEqual([
      "-o",
      "twitter.pinned=false",
      "--post-filter",
      "int(retweet_id or tweet_id) > 123 or abort()",
    ]);
    expect(postFilterFlagsFor("instagram", "456")).toEqual([
      "--post-filter",
      "locals().get('pinned') or int(locals().get('post_id') or media_id) > 456 or abort()",
    ]);
    expect(postFilterFlagsFor("fapello", "2466")).toEqual([
      "--post-filter",
      "int(id) > 2466 or terminate()",
    ]);
    expect(postFilterFlagsFor("pixiv", "999")).toEqual([
      "--post-filter",
      "int(id) > 999 or abort()",
    ]);
  });
});

describe("snowflakeIdFromIso and checkpointFromIso", () => {
  it("converts an ISO timestamp into a Twitter or Instagram snowflake floor with buffer", () => {
    const exact = snowflakeIdFromIso("2026-11-10T14:44:07.000Z", 0);
    expect(exact).toBeDefined();
    expect(BigInt(exact!) <= BigInt("2120165612320411776")).toBe(true);

    const buffered = snowflakeIdFromIso("2026-11-10T14:44:07.000Z");
    expect(buffered).toBeDefined();
    expect(BigInt(buffered!) < BigInt(exact!)).toBe(true);

    const ig = checkpointFromIso("instagram", "2026-11-10T14:44:07.000Z");
    expect(ig).toBeDefined();
    expect(BigInt(ig!) > BigInt(0)).toBe(true);
    expect(checkpointFromIso("fapello", "2026-11-10T14:44:07.000Z")).toBeUndefined();
    expect(checkpointFromIso("pixiv", "2026-11-10T14:44:07.000Z")).toBeUndefined();
  });

  it("returns undefined for invalid or pre-epoch dates", () => {
    expect(snowflakeIdFromIso("not-a-date")).toBeUndefined();
    expect(snowflakeIdFromIso("2010-01-01T00:00:00.000Z")).toBeUndefined();
  });
});

describe("minPostId", () => {
  it("picks the smaller numeric post id using BigInt", () => {
    expect(minPostId("2120165612320411777", "2120165612320411776")).toBe("2120165612320411776");
    expect(minPostId("999", "2120165612320411776")).toBe("999");
    expect(minPostId(undefined, "123")).toBe("123");
    expect(minPostId("123", undefined)).toBe("123");
    expect(minPostId(undefined, undefined)).toBeUndefined();
  });
});
