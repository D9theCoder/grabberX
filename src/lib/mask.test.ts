import { describe, expect, it } from "vitest";
import { maskSecrets } from "@/lib/mask";

describe("maskSecrets", () => {
  it("hides the value after known cookie names", () => {
    expect(maskSecrets("cookie: auth_token=abc123def; ct0=zzz999")).toBe("cookie: auth_token=••••; ct0=••••");
  });

  it("is case-insensitive on the name", () => {
    expect(maskSecrets("Auth_Token=secret")).toBe("Auth_Token=••••");
  });

  it("leaves other text alone", () => {
    expect(maskSecrets("[twitter][info] saved 3 files")).toBe("[twitter][info] saved 3 files");
  });

  it("does not touch names that merely contain the word", () => {
    expect(maskSecrets("not_auth_token=keep")).toBe("not_auth_token=keep");
  });
});
