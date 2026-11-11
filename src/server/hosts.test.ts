import { describe, expect, it } from "vitest";
import { isAllowedHost, isAllowedOrigin } from "@/server/hosts";

describe("isAllowedHost", () => {
  it("accepts the two loopback hosts the app serves", () => {
    expect(isAllowedHost("127.0.0.1:3210")).toBe(true);
    expect(isAllowedHost("localhost:3210")).toBe(true);
    expect(isAllowedHost("LocalHost:3210")).toBe(true);
  });

  it("rejects anything else, including look-alikes", () => {
    const bad = [
      null,
      undefined,
      "",
      "localhost:3000",
      "127.0.0.1",
      "127.0.0.1:3210.evil.com",
      "evil.com",
      "evil.com:3210",
      "localhost:3210.evil.com",
      "192.168.1.10:3210",
    ];
    for (const host of bad) {
      expect(isAllowedHost(host), String(host)).toBe(false);
    }
  });
});

describe("isAllowedOrigin", () => {
  it("allows a missing origin and the two loopback origins", () => {
    expect(isAllowedOrigin(null)).toBe(true);
    expect(isAllowedOrigin(undefined)).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:3210")).toBe(true);
    expect(isAllowedOrigin("http://localhost:3210")).toBe(true);
  });

  it("rejects every other origin", () => {
    for (const origin of ["http://evil.com", "null", "https://localhost:3210", ""]) {
      expect(isAllowedOrigin(origin), origin).toBe(false);
    }
  });
});
