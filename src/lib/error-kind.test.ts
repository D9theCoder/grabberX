import { describe, expect, it } from "vitest";
import { errorKindFor } from "@/lib/error-kind";

describe("errorKindFor", () => {
  it("names the cause that sign-in cannot fix, even when a generic auth line came first", () => {
    expect(
      errorKindFor([
        "[twitter][error] AuthRequired: authenticated cookies needed to access this timeline",
        "[twitter][error] NotFoundError: Requested user could not be found",
      ]),
    ).toBe("notFound");
  });

  it("prefers a full disk over everything else", () => {
    expect(errorKindFor(["[twitter][error] 429 Too Many Requests", "OSError: no space left on device"])).toBe(
      "diskFull",
    );
  });

  it("reads a lone auth line as auth", () => {
    expect(errorKindFor(["[twitter][error] AuthRequired: cookies needed"])).toBe("auth");
  });

  it("falls back to unknown when no line classifies", () => {
    expect(errorKindFor(["something odd", "[twitter][error] boom"])).toBe("unknown");
    expect(errorKindFor([])).toBe("unknown");
  });
});
