import { describe, expect, it } from "vitest";
import { THEME_INIT_SCRIPT, resolveTheme } from "@/lib/theme";

describe("resolveTheme", () => {
  it("follows the system only while nothing was chosen", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("ships an init script that parses on its own", () => {
    expect(() => new Function(THEME_INIT_SCRIPT)).not.toThrow();
  });
});
