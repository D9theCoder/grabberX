import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gatherHome, writeAtomic } from "@/server/store";

export interface DeviceInfo {
  id: string;
  label: string;
  userAgent: string;
  createdAt: string;
  lastSeenAt: string;
  lastIp: string;
}

interface StoredDevice extends DeviceInfo {
  tokenHash: string;
}

interface DeviceState {
  file: string;
  byHash: Map<string, StoredDevice>;
  lastSaved: number;
  writing: Promise<void>;
}

export const MAX_DEVICES = 20;
const SEEN_WRITE_INTERVAL_MS = 60_000;

// Next can load this module once for the gateway and again for a Server Action; the paired phones must be one list.
const globalKey = Symbol.for("gather.mobile.devices");
type WithState = typeof globalThis & { [globalKey]?: DeviceState };

function devicesFile(): string {
  return join(gatherHome(), "devices.json");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function loadFromDisk(file: string): Map<string, StoredDevice> {
  const byHash = new Map<string, StoredDevice>();
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return byHash;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const list = Array.isArray((parsed as { devices?: unknown })?.devices) ? (parsed as { devices: unknown[] }).devices : [];
    for (const item of list) {
      const d = item as Partial<StoredDevice>;
      if (typeof d.tokenHash !== "string" || typeof d.id !== "string") continue;
      byHash.set(d.tokenHash, {
        id: d.id,
        tokenHash: d.tokenHash,
        label: typeof d.label === "string" ? d.label : "Phone",
        userAgent: typeof d.userAgent === "string" ? d.userAgent : "",
        createdAt: typeof d.createdAt === "string" ? d.createdAt : new Date(0).toISOString(),
        lastSeenAt: typeof d.lastSeenAt === "string" ? d.lastSeenAt : new Date(0).toISOString(),
        lastIp: typeof d.lastIp === "string" ? d.lastIp : "",
      });
    }
  } catch {
    // A damaged file means no phone is paired; the user pairs again. Keeping the bad file would block saving.
  }
  return byHash;
}

function state(): DeviceState {
  const holder = globalThis as WithState;
  const file = devicesFile();
  let current = holder[globalKey];
  if (!current || current.file !== file) {
    current = { file, byHash: loadFromDisk(file), lastSaved: 0, writing: Promise.resolve() };
    holder[globalKey] = current;
  }
  return current;
}

function persist(current: DeviceState): Promise<void> {
  const snapshot = JSON.stringify({ devices: [...current.byHash.values()] }, null, 2);
  current.lastSaved = Date.now();
  current.writing = current.writing.catch(() => {}).then(() => writeAtomic(current.file, snapshot));
  return current.writing;
}

function publicInfo(device: StoredDevice): DeviceInfo {
  const { tokenHash: _hash, ...info } = device;
  return info;
}

export function describeUserAgent(userAgent: string): string {
  const platform = /Android/i.test(userAgent)
    ? "Android"
    : /iPhone|iPad/i.test(userAgent)
      ? "iPhone or iPad"
      : /Windows/i.test(userAgent)
        ? "Windows"
        : /Macintosh/i.test(userAgent)
          ? "Mac"
          : "Device";
  const browser = /Firefox\//.test(userAgent) ? "Firefox" : /Edg\//.test(userAgent) ? "Edge" : /Chrome\//.test(userAgent) ? "Chrome" : /Safari\//.test(userAgent) ? "Safari" : "";
  return browser ? `${platform} · ${browser}` : platform;
}

export class DeviceLimitError extends Error {
  constructor() {
    super(`${MAX_DEVICES} phones are already paired. Revoke one in Settings first.`);
  }
}

export async function createDevice(input: { userAgent: string; ip: string; now?: Date }): Promise<{ token: string; device: DeviceInfo }> {
  const current = state();
  if (current.byHash.size >= MAX_DEVICES) throw new DeviceLimitError();
  const token = randomBytes(32).toString("base64url");
  const stamp = (input.now ?? new Date()).toISOString();
  const userAgent = input.userAgent.slice(0, 300);
  const stored: StoredDevice = {
    id: randomUUID(),
    tokenHash: hashToken(token),
    label: describeUserAgent(userAgent),
    userAgent,
    createdAt: stamp,
    lastSeenAt: stamp,
    lastIp: input.ip.slice(0, 64),
  };
  current.byHash.set(stored.tokenHash, stored);
  await persist(current);
  return { token, device: publicInfo(stored) };
}

/**
 * Synchronous so the gateway can call it on every request. The lookup is by SHA-256 of the cookie, so the
 * comparison never sees the secret itself and gives a guesser nothing to time.
 */
export function authorizeSession(token: string | null, ip?: string, now: number = Date.now()): boolean {
  if (!token || token.length > 100) return false;
  const current = state();
  const device = current.byHash.get(hashToken(token));
  if (!device) return false;
  device.lastSeenAt = new Date(now).toISOString();
  if (ip) device.lastIp = ip.slice(0, 64);
  if (now - current.lastSaved > SEEN_WRITE_INTERVAL_MS) void persist(current).catch(() => {});
  return true;
}

export function listDevices(): DeviceInfo[] {
  return [...state().byHash.values()].map(publicInfo).sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}

export async function renameDevice(id: string, label: string): Promise<boolean> {
  const current = state();
  const clean = label.trim().slice(0, 40);
  if (clean === "") return false;
  for (const device of current.byHash.values()) {
    if (device.id === id) {
      device.label = clean;
      await persist(current);
      return true;
    }
  }
  return false;
}

export async function revokeDevice(id: string): Promise<boolean> {
  const current = state();
  for (const [hash, device] of current.byHash) {
    if (device.id === id) {
      current.byHash.delete(hash);
      await persist(current);
      return true;
    }
  }
  return false;
}

export async function revokeSession(token: string | null): Promise<boolean> {
  if (!token) return false;
  const current = state();
  if (!current.byHash.delete(hashToken(token))) return false;
  await persist(current);
  return true;
}

export async function revokeAllDevices(): Promise<number> {
  const current = state();
  const count = current.byHash.size;
  if (count === 0) return 0;
  current.byHash.clear();
  await persist(current);
  return count;
}
