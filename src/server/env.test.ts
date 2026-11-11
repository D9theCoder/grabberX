import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PORT,
  appPort,
  envAppDir,
  envGalleryDl,
  envHome,
  envMediaRoot,
  isPackaged,
} from "@/server/env";

const NAMES = [
  "GATHER_PACKAGED",
  "GATHER_PORT",
  "GATHER_HOME",
  "GATHER_MEDIA_ROOT",
  "GATHER_GALLERY_DL",
  "GATHER_APP_DIR",
] as const;

afterEach(() => {
  for (const name of NAMES) delete process.env[name];
});

describe("appPort", () => {
  it("defaults to the dev port", () => {
    expect(appPort()).toBe(DEFAULT_PORT);
    process.env.GATHER_PORT = "  ";
    expect(appPort()).toBe(DEFAULT_PORT);
  });

  it("reads GATHER_PORT", () => {
    process.env.GATHER_PORT = "4501";
    expect(appPort()).toBe(4501);
  });

  it("rejects values that are not a port", () => {
    for (const value of ["abc", "0", "70000", "12.5", "-1"]) {
      process.env.GATHER_PORT = value;
      expect(() => appPort(), value).toThrow(/GATHER_PORT/);
    }
  });
});

describe("path variables in development", () => {
  it("returns undefined so callers use their dev fallback", () => {
    expect(isPackaged()).toBe(false);
    expect(envHome()).toBeUndefined();
    expect(envMediaRoot()).toBeUndefined();
    expect(envGalleryDl()).toBeUndefined();
    expect(envAppDir()).toBeUndefined();
  });

  it("returns a trimmed value when set", () => {
    process.env.GATHER_MEDIA_ROOT = "  D:\\Library  ";
    expect(envMediaRoot()).toBe("D:\\Library");
  });
});

describe("path variables when packaged", () => {
  it("fails loudly instead of falling back to the working directory", () => {
    process.env.GATHER_PACKAGED = "1";
    expect(() => envHome()).toThrow(/GATHER_HOME/);
    expect(() => envMediaRoot()).toThrow(/GATHER_MEDIA_ROOT/);
    expect(() => envGalleryDl()).toThrow(/GATHER_GALLERY_DL/);
  });

  it("accepts them once set", () => {
    process.env.GATHER_PACKAGED = "1";
    process.env.GATHER_HOME = "C:\\Users\\a\\AppData\\Roaming\\gather";
    process.env.GATHER_MEDIA_ROOT = "C:\\Users\\a\\Pictures\\Gather";
    process.env.GATHER_GALLERY_DL = "C:\\Users\\a\\AppData\\Roaming\\gather\\bin\\gallery-dl.exe";
    expect(envHome()).toContain("gather");
    expect(envMediaRoot()).toContain("Gather");
    expect(envGalleryDl()).toContain("gallery-dl.exe");
  });
});
