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
import { ensureMobileTls } from "@/server/mobile/tls";
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
  autoOffAt: number | null;
  certHosts: Set<string>;
}

// The Settings Server Action and instrumentation.ts can be bundled separately; one listener and one lock must exist.
const globalKey = Symbol.for("gather.mobile.service");
const lockKey = Symbol.for("gather.mobile.service.lock");
type WithRunning = typeof globalThis & { [globalKey]?: Running | null; [lockKey]?: Promise<void> };

const running = (): Running | null => (globalThis as WithRunning)[globalKey] ?? null;
const setRunning = (value: Running | null) => {
  (globalThis as WithRunning)[globalKey] = value;
};

/** Serializes listener start/stop transitions so overlapping calls never race on the gateway port. */
function withTransitionLock<T>(fn: () => Promise<T>): Promise<T> {
  const holder = globalThis as WithRunning;
  const previous = holder[lockKey] ?? Promise.resolve();
  const next = previous.catch(() => {}).then(fn);
  holder[lockKey] = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

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

/** Closes the mobile gateway on server shutdown without altering saved settings or paired devices. */
export function stopMobileGateway(): Promise<void> {
  return withTransitionLock(() => stopListener());
}

async function startListener(autoOffAt: number | null): Promise<void> {
  if (running()) return;
  const hosts = lanAddresses().map((entry) => entry.address);
  const tls = await ensureMobileTls(hosts).catch((error) => {
    console.error("grabberX: could not generate a local TLS certificate for the mobile gallery.", error);
    return null;
  });
  const handle = await startGateway({
    port: mobilePort(),
    upstreamPort: appPort(),
    ...createMobileHooks(),
    ...(tls ? { tls: { key: tls.leafKeyPem, cert: tls.leafCertPem, caCertDer: tls.caCertDer } } : {}),
  });
  let timer: NodeJS.Timeout | null = null;
  if (autoOffAt !== null) {
    const wait = Math.max(0, autoOffAt - Date.now());
    // setTimeout cannot hold more than about 24 days; the longest choice here is 8 hours.
    timer = setTimeout(() => void disableMobileAccess({ forget: false }), wait);
    timer.unref();
  }
  setRunning({ handle, timer, autoOffAt, certHosts: new Set(hosts) });
}

/** Called once from instrumentation.ts. Does nothing unless the user turned sharing on and it has not run out. */
export function startMobileIfEnabled(): Promise<void> {
  return withTransitionLock(async () => {
    const saved = await readSaved();
    if (!saved.enabled) return;
    if (saved.autoOffAt !== null && saved.autoOffAt <= Date.now()) {
      await writeSaved({ enabled: false, autoOffAt: null });
      return;
    }
    await startListener(saved.autoOffAt).catch((error) => {
      console.error("grabberX: could not start the mobile gallery.", error);
    });
  });
}

export function enableMobileAccess(hours: AutoOffHours): Promise<void> {
  return withTransitionLock(async () => {
    const autoOffAt = hours === 0 ? null : Date.now() + hours * 3600_000;
    await stopListener();
    await startListener(autoOffAt);
    await writeSaved({ enabled: true, autoOffAt });
  });
}

export function disableMobileAccess({ forget }: { forget: boolean }): Promise<void> {
  return withTransitionLock(async () => {
    await stopListener();
    resetPairingState();
    await writeSaved({ enabled: false, autoOffAt: null });
    if (forget) await revokeAllDevices();
  });
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
  httpsUrl: string;
  caCertUrl: string;
  svg: string;
  httpsSvg: string;
  caCertSvg: string;
  expiresAt: number;
  addressKind: LanAddress["kind"];
}

/** The pairing secret goes after the "#", which a browser never sends in a request. */
export async function createPairingOffer(address?: string): Promise<PairingOffer | null> {
  let current = running();
  if (!current) return null;
  const options = lanAddresses();
  // Only an address this PC really has may be put into a QR code; the caller picks among them.
  const chosen = options.find((entry) => entry.address === address) ?? options[0];
  if (!chosen) return null;
  // If the PC gained a new LAN or Tailscale IP after the gateway started, refresh the leaf cert SANs
  // so HTTPS pairing doesn't fail with ERR_CERT_COMMON_NAME_INVALID.
  if (!current.certHosts.has(chosen.address)) {
    const autoOffAt = current.autoOffAt;
    await withTransitionLock(async () => {
      if (!running()) return;
      await stopListener();
      await startListener(autoOffAt);
    });
    current = running();
    if (!current) return null;
  }
  const { token, expiresAt } = createPairingToken();
  const hostPort = `${chosen.address}:${current.handle.port}`;
  const url = `http://${hostPort}/m/pair#${token}`;
  const httpsUrl = `https://${hostPort}/m/pair#${token}`;
  const caCertUrl = `http://${hostPort}/m/ca.crt`;
  const [svg, httpsSvg, caCertSvg] = await Promise.all([
    QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M" }),
    QRCode.toString(httpsUrl, { type: "svg", margin: 1, errorCorrectionLevel: "M" }),
    QRCode.toString(caCertUrl, { type: "svg", margin: 1, errorCorrectionLevel: "M" }),
  ]);
  return { url, httpsUrl, caCertUrl, svg, httpsSvg, caCertSvg, expiresAt, addressKind: chosen.kind };
}

