import { describe, expect, it } from "vitest";
import {
  DEFAULT_PREFS,
  formatSpeed,
  parsePrefs,
  PLAYBACK_SPEEDS,
  skipTarget,
  speedIndex,
  tapRegion,
} from "@/components/gallery/video-player";

describe("playback speeds", () => {
  it("steps from 0.1x to 3x and always includes normal speed", () => {
    expect(PLAYBACK_SPEEDS[0]).toBe(0.1);
    expect(PLAYBACK_SPEEDS.at(-1)).toBe(3);
    expect(PLAYBACK_SPEEDS).toContain(1);
    expect([...PLAYBACK_SPEEDS]).toEqual([...PLAYBACK_SPEEDS].sort((a, b) => a - b));
  });

  it("moves in quarter steps from 0.25x upward", () => {
    const quarter = PLAYBACK_SPEEDS.slice(1);
    for (let index = 1; index < quarter.length; index++) expect(quarter[index]! - quarter[index - 1]!).toBe(0.25);
  });

  it("snaps any rate to the nearest step", () => {
    expect(speedIndex(1)).toBe(PLAYBACK_SPEEDS.indexOf(1));
    expect(speedIndex(0.2)).toBe(PLAYBACK_SPEEDS.indexOf(0.25));
    expect(speedIndex(0.01)).toBe(0);
    expect(speedIndex(16)).toBe(PLAYBACK_SPEEDS.length - 1);
    expect(speedIndex(Number.NaN)).toBe(PLAYBACK_SPEEDS.indexOf(1));
  });

  it("writes a rate the way people say it", () => {
    expect(formatSpeed(1)).toBe("1×");
    expect(formatSpeed(0.25)).toBe("0.25×");
    expect(formatSpeed(1.5)).toBe("1.5×");
  });
});

describe("skipTarget", () => {
  it("moves by the delta", () => {
    expect(skipTarget(20, 60, 5)).toBe(25);
    expect(skipTarget(20, 60, -5)).toBe(15);
  });

  it("stays inside the video", () => {
    expect(skipTarget(2, 60, -5)).toBe(0);
    expect(skipTarget(58, 60, 5)).toBe(60);
  });

  it("does not clamp the end while the length is unknown", () => {
    expect(skipTarget(10, Number.NaN, 5)).toBe(15);
    expect(skipTarget(10, Number.POSITIVE_INFINITY, 5)).toBe(15);
  });
});

describe("tapRegion", () => {
  it("splits the stage into thirds", () => {
    expect(tapRegion(100, 0, 900)).toBe("back");
    expect(tapRegion(450, 0, 900)).toBe("middle");
    expect(tapRegion(800, 0, 900)).toBe("forward");
  });

  it("measures from the stage's left edge", () => {
    expect(tapRegion(1050, 1000, 900)).toBe("back");
    expect(tapRegion(1450, 1000, 900)).toBe("middle");
    expect(tapRegion(1850, 1000, 900)).toBe("forward");
  });

  it("falls back to the middle when the stage has no width", () => {
    expect(tapRegion(10, 0, 0)).toBe("middle");
  });
});

describe("parsePrefs", () => {
  it("uses the defaults when nothing is stored or the text is not JSON", () => {
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(parsePrefs("not json")).toEqual(DEFAULT_PREFS);
    expect(parsePrefs("12")).toEqual(DEFAULT_PREFS);
  });

  it("keeps stored values and never restores a speed", () => {
    expect(parsePrefs('{"autoplay":true,"speed":0.1,"volume":0.4,"muted":true}')).toEqual({
      autoplay: true,
      volume: 0.4,
      muted: true,
    });
  });

  it("clamps volume and ignores values of the wrong type", () => {
    expect(parsePrefs('{"volume":7}').volume).toBe(1);
    expect(parsePrefs('{"volume":-1}').volume).toBe(0);
    expect(parsePrefs('{"autoplay":"yes","volume":"loud","muted":1}')).toEqual(DEFAULT_PREFS);
  });
});
