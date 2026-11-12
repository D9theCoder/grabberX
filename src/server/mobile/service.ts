import "server-only";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import QRCode from "qrcode";
import { appPort, mobilePort } from "@/server/env";
import { startGateway } from "@/server/mobile/gateway";
import type { GatewayHandle } from "@/server/mobile/gateway";
import { createMobileHooks } from "@/server/mobile/hooks";
import { lanAddresses } from "@/server/mobile/network";
import type { LanAddress } from "@/server/mobile/network";
import { createPairingToken, resetPairingState } from "@/server/mobile/pairing";
import { listDevices, revokeAllDevices } from "@/server/mobile/devices";
import type { DeviceInfo } from "@/server/mobile/devices";
import { gatherHome, writeAtomic } from "@/server/store";

export const AUTO_OFF_CHOICES = [0, 1, 8] as const;
export type AutoOffHours = (typeof AUTO_OFF_CHOICES)[number];

interface SavedMobile {
  enabled: boolean;
  autoOffAt: number | null;
}

interface Running {
  handle: GatewayHandle;
  timer: NodeJS.Timeout | null;
  starting?: Promise<void>;
}

// The Settings Server Action and instrumentation.ts can be bundled separately; one listener must exist.
const globalKey = Symbol.for("gather.mobile.service");
type WithRunning = typeof globalThis & { [globalKey]?: Running | null };

const running = (): Running | null => (globalThis as WithRunning)[globalKey] ?? null;
const setRunning = (value: Running | null) => {
  (globalThis as WithRunning)[globalKey] = value;
};

function mobileFile(): string {
  return join(gatherHome(), "mobile.json");
}

async function readSaved(): Promise<SavedMobile> {
  try {
    const json = JSON.parse(await readFile(mobileFile(), "utf8")) as Partial<SavedMobile>;
    return {
      enabled: json.enabled === true,
      autoOffAt: typeof json.autoOffAt === "number" ? json.autoOffAt : null,
    };
  } catch {
    return { enabled: false, autoOffAt: null };
  }
}

async function writeSaved(saved: SavedMobile): Promise<void> {
  await mkdir(gatherHome(), { recursive: true });
  await writeAtomic(mobileFile(), JSON.stringify(saved, null, 2));
}

function stopListener(): Promise<void> {
  const current = running();
  if (!current) return Promise.resolve();
  if (current.timer) clearTimeout(current.timer);
  setRunning(null);
  return current.handle.close();
}

async function startListener(autoOffAt: number | null): Promise<void> {
  if (running()) return;
  const handle = await startGateway({ port: mobilePort(), upstreamPort: appPort(), ...createMobileHooks() });
  let timer: NodeJS.Timeout | null = null;
  if (autoOffAt !== null) {
    const wait = Math.max(0, autoOffAt - Date.now());
    // setTimeout cannot hold more than about 24 days; the longest choice here is 8 hours.
    timer = setTimeout(() => void disableMobileAccess({ forget: false }), wait);
    timer.unref();
  }
  setRunning({ handle, timer });
}

/** Called once from instrumentation.ts. Does nothing unless the user turned sharing on and it has not run out. */
export async function startMobileIfEnabled(): Promise<void> {
  const saved = await readSaved();
  if (!saved.enabled) return;
  if (saved.autoOffAt !== null && saved.autoOffAt <= Date.now()) {
    await writeSaved({ enabled: false, autoOffAt: null });
    return;
  }
  await startListener(saved.autoOffAt).catch((error) => {
    console.error("gather: could not start the mobile gallery.", error);
  });
}

export async function enableMobileAccess(hours: AutoOffHours): Promise<void> {
  const autoOffAt = hours === 0 ? null : Date.now() + hours * 3600_000;
  await stopListener();
  await startListener(autoOffAt);
  await writeSaved({ enabled: true, autoOffAt });
}

export async function disableMobileAccess({ forget }: { forget: boolean }): Promise<void> {
  await stopListener();
  resetPairingState();
  await writeSaved({ enabled: false, autoOffAt: null });
  if (forget) await revokeAllDevices();
}

export interface MobileStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  addresses: LanAddress[];
  autoOffAt: number | null;
  devices: DeviceInfo[];
}

export async function getMobileStatus(): Promise<MobileStatus> {
  const saved = await readSaved();
  return {
    enabled: saved.enabled,
    running: running() !== null,
    port: running()?.handle.port ?? mobilePort(),
    addresses: lanAddresses(),
    autoOffAt: saved.autoOffAt,
    devices: listDevices(),
  };
}

export interface PairingOffer {
  url: string;
  svg: string;
  expiresAt: number;
  addressKind: LanAddress["kind"];
}

/** The pairing secret goes after the "#", which a browser never sends in a request. */
export async function createPairingOffer(address?: string): Promise<PairingOffer | null> {
  const current = running();
  if (!current) return null;
  const options = lanAddresses();
  // Only an address this PC really has may be put into a QR code; the caller picks among them.
  const chosen = options.find((entry) => entry.address === address) ?? options[0];
  if (!chosen) return null;
  const { token, expiresAt } = createPairingToken();
  const url = `http://${chosen.address}:${current.handle.port}/m/pair#${token}`;
  const svg = await QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
  return { url, svg, expiresAt, addressKind: chosen.kind };
}
