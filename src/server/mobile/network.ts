import "server-only";
import { networkInterfaces } from "node:os";

function ipv4Octets(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  return octets.every((n) => n >= 0 && n <= 255) ? octets : null;
}

/** Node reports an IPv4 client on a dual-stack socket as `::ffff:a.b.c.d`. */
export function normalizeAddress(address: string): string {
  const lower = address.trim().toLowerCase();
  return lower.startsWith("::ffff:") ? lower.slice(7) : lower;
}

export type PeerKind = "loopback" | "private" | "tailnet" | "public";

export function classifyPeer(raw: string | undefined | null): PeerKind {
  if (!raw) return "public";
  const address = normalizeAddress(raw);
  const v4 = ipv4Octets(address);
  if (v4) {
    const [a, b] = v4;
    if (a === 127) return "loopback";
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "private";
    // 100.64.0.0/10 is shared by Tailscale and other carrier-grade NAT users; either way it is not the public internet.
    if (a === 100 && b >= 64 && b <= 127) return "tailnet";
    return "public";
  }
  if (address === "::1") return "loopback";
  if (/^f[cd][0-9a-f]{2}:/.test(address)) return "private";
  if (/^fe[89ab][0-9a-f]:/.test(address)) return "private";
  return "public";
}

/** A peer the gateway may serve. This is a coarse filter, not a firewall: a port-forwarding router looks private. */
export function isPrivatePeer(address: string | undefined | null): boolean {
  return classifyPeer(address) !== "public";
}

export interface LanAddress {
  address: string;
  kind: "private" | "tailnet";
}

const VIRTUAL_ADAPTER_NAME = /^vEthernet\b|virtualbox|vmware|hyper-v|docker|wsl/i;
const VIRTUAL_MAC_PREFIXES = ["08:00:27", "0a:00:27", "00:15:5d", "00:50:56", "00:05:69", "00:0c:29", "00:1c:14"];

/**
 * A private address on a virtual adapter (Hyper-V, WSL, VirtualBox, VMware) only reaches this PC, so a phone
 * cannot use it. Tailscale addresses are not private and are not filtered here.
 */
export function isVirtualAdapter(name: string, mac: string): boolean {
  return VIRTUAL_ADAPTER_NAME.test(name) || VIRTUAL_MAC_PREFIXES.includes(mac.toLowerCase().slice(0, 8));
}

export function lanAddresses(): LanAddress[] {
  const found: LanAddress[] = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== "IPv4") continue;
      const kind = classifyPeer(entry.address);
      if (kind === "private" && isVirtualAdapter(name, entry.mac)) continue;
      if (kind === "private" || kind === "tailnet") found.push({ address: entry.address, kind });
    }
  }
  return found;
}

export function advertisedUrls(port: number): string[] {
  return lanAddresses().map(({ address }) => `http://${address}:${port}`);
}
