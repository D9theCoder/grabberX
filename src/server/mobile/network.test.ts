import { describe, expect, it } from "vitest";
import { classifyPeer, isPrivatePeer, normalizeAddress } from "@/server/mobile/network";

describe("normalizeAddress", () => {
  it("unwraps an IPv4 address that arrived on a dual-stack socket", () => {
    expect(normalizeAddress("::ffff:192.168.1.20")).toBe("192.168.1.20");
    expect(normalizeAddress("::FFFF:10.0.0.5")).toBe("10.0.0.5");
  });
});

describe("classifyPeer", () => {
  it.each([
    ["127.0.0.1", "loopback"],
    ["::1", "loopback"],
    ["::ffff:127.0.0.1", "loopback"],
    ["10.1.2.3", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.168.0.10", "private"],
    ["fe80::1", "private"],
    ["fd7a:115c:a1e0::1", "private"],
    ["100.64.0.1", "tailnet"],
    ["100.127.255.254", "tailnet"],
  ])("serves %s as %s", (address, kind) => {
    expect(classifyPeer(address)).toBe(kind);
    expect(isPrivatePeer(address)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "172.15.0.1",
    "172.32.0.1",
    "100.63.255.255",
    "100.128.0.1",
    "192.169.0.1",
    "11.0.0.1",
    "2001:db8::1",
    "999.1.1.1",
    "10.0.0",
    "",
    "not-an-ip",
  ])("closes %s", (address) => {
    expect(isPrivatePeer(address)).toBe(false);
  });

  it("closes a missing address", () => {
    expect(isPrivatePeer(undefined)).toBe(false);
    expect(isPrivatePeer(null)).toBe(false);
  });
});
