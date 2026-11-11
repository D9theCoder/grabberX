import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isReserved, isValidFolderName, RESERVED, resolveAccountDir } from "@/server/paths";

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
