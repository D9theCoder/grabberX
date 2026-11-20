import { describe, expect, it } from "vitest";
import {
  minPostId,
  parseTwitterArchiveEntry,
  snowflakeIdFromIso,
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

describe("twitterArchiveTip", () => {
  it("compares 64-bit snowflake IDs numerically rather than lexicographically", () => {
    const tip = twitterArchiveTip([
      "twitter999_0_1",
      "twitter2120165612320411776_0_1",
      "twitter2120165612320411775_0_4",
      "twitter2120165612320411777_0_1",
      "instagram9999999999999999999",
    ]);
    expect(tip).toEqual({
      tweetId: "2120165612320411777",
      timelineId: "2120165612320411777",
    });
  });

  it("separates own posts from retweets while tracking the newest timeline id", () => {
    const tip = twitterArchiveTip([
      "twitter2000000000000000000_0_1",
      "twitter1500000000000000000_2100000000000000000_1",
    ]);
    expect(tip).toEqual({
      tweetId: "2000000000000000000",
      timelineId: "2100000000000000000",
    });
  });

  it("returns undefined when no Twitter entries are present", () => {
    expect(twitterArchiveTip([])).toBeUndefined();
    expect(twitterArchiveTip(["instagram123", "fapellophoto_a_1"])).toBeUndefined();
  });
});

describe("snowflakeIdFromIso", () => {
  it("converts an ISO timestamp into a Twitter snowflake floor with buffer", () => {
    // 2120165612320411776 decodes to 2026-11-10T14:44:07.xxxZ; with 0 buffer it matches the ms prefix.
    const exact = snowflakeIdFromIso("2026-11-10T14:44:07.000Z", 0);
    expect(exact).toBeDefined();
    expect(BigInt(exact!) <= BigInt("2120165612320411776")).toBe(true);

    const buffered = snowflakeIdFromIso("2026-11-10T14:44:07.000Z");
    expect(buffered).toBeDefined();
    expect(BigInt(buffered!) < BigInt(exact!)).toBe(true);
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
