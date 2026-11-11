import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertSafeMediaRoot,
  isReserved,
  isValidFolderName,
  RESERVED,
  resolveAccountDir,
} from "@/server/paths";

const root = process.platform === "win32" ? "C:\\media" : "/media";

describe("isValidFolderName", () => {
  it("accepts handles and dotted folder names", () => {
    for (const name of ["username", "yearacct", "a.b-c_1", "A1", "a".repeat(64)]) {
      expect(isValidFolderName(name), name).toBe(true);
    }
  });

  it("rejects the names Windows reserves for devices, with or without an extension", () => {
    for (const name of ["con", "NUL", "aux.txt", "COM1", "lpt9.log", "prn"]) {
      expect(isValidFolderName(name), name).toBe(false);
    }
    for (const name of ["console", "com10", "auxiliary", "nullable"]) {
      expect(isValidFolderName(name), name).toBe(true);
    }
  });

  it("rejects traversal, separators, whitespace and over-long names", () => {
    const bad = [
      "",
      ".",
      "..",
      "a/b",
      "a\\b",
      "../x",
      "..\\x",
      "C:\\Windows",
      "/etc",
      "a b",
      "a:b",
      "trail.",
      "a".repeat(65),
      "über",
    ];
    for (const name of bad) {
      expect(isValidFolderName(name), name).toBe(false);
    }
  });
});

describe("isReserved", () => {
  it("knows the app folders, case-insensitively", () => {
    for (const name of ["src", "SRC", "Public", "NODE_MODULES", ".next", ".GATHER", ".git"]) {
      expect(isReserved(name), name).toBe(true);
    }
  });

  it("reserves every dot-folder, not only the listed ones", () => {
    expect(isReserved(".cache")).toBe(true);
    expect(RESERVED.has(".gather")).toBe(true);
  });

  it("lets real accounts through", () => {
    for (const name of ["username", "yearacct", "second_account", "docs2"]) {
      expect(isReserved(name), name).toBe(false);
    }
  });
});

describe("resolveAccountDir", () => {
  it("resolves inside the media root", () => {
    expect(resolveAccountDir(root, "username")).toBe(join(root, "username"));
    expect(resolveAccountDir(`${root}${process.platform === "win32" ? "\\" : "/"}`, "a.b")).toBe(
      join(root, "a.b"),
    );
  });

  it("throws for names that try to leave the root", () => {
    const bad = ["..", "../..", "a/../../b", "a\\..\\..\\b", "C:\\Windows", "/etc", "a/b"];
    for (const name of bad) {
      expect(() => resolveAccountDir(root, name), name).toThrow();
    }
  });

  it("keeps a name that merely looks like the root", () => {
    const dir = resolveAccountDir(root, "media");
    expect(dir).toBe(join(root, "media"));
  });
});

describe("assertSafeMediaRoot", () => {
  const app = join(root, "app");
  const state = join(root, "state");

  it("accepts a folder outside every protected directory", () => {
    expect(() => assertSafeMediaRoot(join(root, "library"), [app, state])).not.toThrow();
    expect(() => assertSafeMediaRoot(join(root, "library"), [])).not.toThrow();
  });

  it("rejects the protected directory itself and anything inside it", () => {
    expect(() => assertSafeMediaRoot(app, [app])).toThrow(/inside the app's own folder/);
    expect(() => assertSafeMediaRoot(join(app, "media"), [app])).toThrow(/inside the app's own folder/);
    expect(() => assertSafeMediaRoot(join(state, "runs"), [app, state])).toThrow(/inside/);
  });

  it("rejects a folder that contains a protected directory", () => {
    expect(() => assertSafeMediaRoot(root, [app])).toThrow(/contain the app's own folder/);
  });

  it("does not treat a look-alike sibling as inside", () => {
    expect(() => assertSafeMediaRoot(join(root, "app-media"), [app])).not.toThrow();
  });

  it.runIf(process.platform === "win32")("compares Windows paths case-insensitively", () => {
    expect(() => assertSafeMediaRoot(join(root.toUpperCase(), "APP", "x"), [app])).toThrow(/inside/);
  });
});
