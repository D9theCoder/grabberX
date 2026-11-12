import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  authorizeSession,
  createDevice,
  DeviceLimitError,
  describeUserAgent,
  hashToken,
  listDevices,
  MAX_DEVICES,
  renameDevice,
  revokeAllDevices,
  revokeDevice,
  revokeSession,
} from "@/server/mobile/devices";

let sandbox = "";
let home = "";

beforeEach(async () => {
  if (sandbox === "") sandbox = await mkdtemp(join(tmpdir(), "gather-devices-"));
  home = await mkdtemp(join(sandbox, "home-"));
  process.env.GATHER_HOME = home;
});

afterAll(async () => {
  delete process.env.GATHER_HOME;
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
});

const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36";

describe("describeUserAgent", () => {
  it("names the platform and browser", () => {
    expect(describeUserAgent(ANDROID)).toBe("Android · Chrome");
    expect(describeUserAgent("Mozilla/5.0 (Windows NT 10.0) Firefox/130.0")).toBe("Windows · Firefox");
    expect(describeUserAgent("")).toBe("Device");
  });
});

describe("devices", () => {
  it("pairs a phone and accepts its token", async () => {
    const { token, device } = await createDevice({ userAgent: ANDROID, ip: "192.168.1.20" });
    expect(device.label).toBe("Android · Chrome");
    expect(authorizeSession(token, "192.168.1.20")).toBe(true);
    expect(authorizeSession(token + "x")).toBe(false);
    expect(authorizeSession(null)).toBe(false);
    expect(authorizeSession("")).toBe(false);
  });

  it("stores only a hash, never the token", async () => {
    const { token } = await createDevice({ userAgent: ANDROID, ip: "192.168.1.20" });
    const file = await readFile(join(home, "devices.json"), "utf8");
    expect(file).not.toContain(token);
    expect(file).toContain(hashToken(token));
  });

  it("never lists the hash", async () => {
    await createDevice({ userAgent: ANDROID, ip: "192.168.1.20" });
    const listed = JSON.stringify(listDevices());
    expect(listed).not.toContain("tokenHash");
  });

  it("revokes one phone and keeps the others", async () => {
    const a = await createDevice({ userAgent: ANDROID, ip: "192.168.1.20" });
    const b = await createDevice({ userAgent: ANDROID, ip: "192.168.1.21" });
    expect(await revokeDevice(a.device.id)).toBe(true);
    expect(authorizeSession(a.token)).toBe(false);
    expect(authorizeSession(b.token)).toBe(true);
    expect(await revokeDevice(a.device.id)).toBe(false);
  });

  it("revokes every phone", async () => {
    const a = await createDevice({ userAgent: ANDROID, ip: "192.168.1.20" });
    const b = await createDevice({ userAgent: ANDROID, ip: "192.168.1.21" });
    expect(await revokeAllDevices()).toBe(2);
    expect(authorizeSession(a.token)).toBe(false);
    expect(authorizeSession(b.token)).toBe(false);
    expect(listDevices()).toEqual([]);
  });

  it("logs out by token", async () => {
    const { token } = await createDevice({ userAgent: ANDROID, ip: "192.168.1.20" });
    expect(await revokeSession(token)).toBe(true);
    expect(authorizeSession(token)).toBe(false);
    expect(await revokeSession(token)).toBe(false);
    expect(await revokeSession(null)).toBe(false);
  });

  it("renames a phone and rejects an empty name", async () => {
    const { device } = await createDevice({ userAgent: ANDROID, ip: "192.168.1.20" });
    expect(await renameDevice(device.id, "  My phone  ")).toBe(true);
    expect(listDevices()[0].label).toBe("My phone");
    expect(await renameDevice(device.id, "   ")).toBe(false);
  });

  it("refuses more than the limit", async () => {
    for (let i = 0; i < MAX_DEVICES; i += 1) await createDevice({ userAgent: ANDROID, ip: "192.168.1.20" });
    await expect(createDevice({ userAgent: ANDROID, ip: "192.168.1.20" })).rejects.toBeInstanceOf(DeviceLimitError);
  });

  it("keeps phones paired across a reload from disk", async () => {
    const { token } = await createDevice({ userAgent: ANDROID, ip: "192.168.1.20" });
    const holder = globalThis as Record<symbol, unknown>;
    delete holder[Symbol.for("gather.mobile.devices")];
    expect(authorizeSession(token)).toBe(true);
  });

  it("starts empty when the file is damaged", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(home, "devices.json"), "{not json", "utf8");
    const holder = globalThis as Record<symbol, unknown>;
    delete holder[Symbol.for("gather.mobile.devices")];
    expect(listDevices()).toEqual([]);
  });
});
