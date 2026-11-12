import "server-only";
import { createHash, randomBytes } from "node:crypto";

export const PAIRING_TTL_MS = 5 * 60_000;
export const MAX_OPEN_TOKENS = 5;
const IP_FAILURES_PER_MINUTE = 5;
const IP_BLOCK_MS = 10 * 60_000;
const GLOBAL_FAILURES_PER_MINUTE = 30;
const WINDOW_MS = 60_000;

// 32 symbols, so a random byte maps onto them without bias (256 is a multiple of 32).
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const TOKEN_LENGTH = 26; // 130 bits
const TOKEN_FORMAT = /^[a-z2-7]{26}$/;

interface Pending {
  expiresAt: number;
}

interface FailureWindow {
  count: number;
  windowStart: number;
  blockedUntil: number;
}

interface PairingState {
  pending: Map<string, Pending>;
  byIp: Map<string, FailureWindow>;
  global: { count: number; windowStart: number };
}

const globalKey = Symbol.for("gather.mobile.pairing");
type WithState = typeof globalThis & { [globalKey]?: PairingState };

function state(): PairingState {
  const holder = globalThis as WithState;
  holder[globalKey] ??= { pending: new Map(), byIp: new Map(), global: { count: 0, windowStart: 0 } };
  return holder[globalKey];
}

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

function generateToken(): string {
  const bytes = randomBytes(TOKEN_LENGTH);
  let token = "";
  for (const byte of bytes) token += ALPHABET[byte % 32];
  return token;
}

function prune(current: PairingState, now: number): void {
  for (const [key, entry] of current.pending) if (entry.expiresAt <= now) current.pending.delete(key);
  for (const [ip, window] of current.byIp) {
    if (window.blockedUntil <= now && now - window.windowStart > WINDOW_MS) current.byIp.delete(ip);
  }
}

export function createPairingToken(now: number = Date.now()): { token: string; expiresAt: number } {
  const current = state();
  prune(current, now);
  // Oldest first; a new QR code replaces the oldest unused one instead of piling up valid secrets.
  while (current.pending.size >= MAX_OPEN_TOKENS) {
    const oldest = current.pending.keys().next().value;
    if (oldest === undefined) break;
    current.pending.delete(oldest);
  }
  const token = generateToken();
  const expiresAt = now + PAIRING_TTL_MS;
  current.pending.set(hash(token), { expiresAt });
  return { token, expiresAt };
}

export function cancelPairingTokens(): void {
  state().pending.clear();
}

/** Forgets open codes and every failure count. The settings page uses it when mobile access is turned off. */
export function resetPairingState(): void {
  const current = state();
  current.pending.clear();
  current.byIp.clear();
  current.global = { count: 0, windowStart: 0 };
}

export function openPairingTokens(now: number = Date.now()): number {
  const current = state();
  prune(current, now);
  return current.pending.size;
}

export type ConsumeResult = { ok: true } | { ok: false; reason: "invalid" } | { ok: false; reason: "limited"; retryAfterSeconds: number };

function recordFailure(current: PairingState, ip: string, now: number): void {
  let window = current.byIp.get(ip);
  if (!window || now - window.windowStart > WINDOW_MS) {
    window = { count: 0, windowStart: now, blockedUntil: window?.blockedUntil ?? 0 };
    current.byIp.set(ip, window);
  }
  window.count += 1;
  if (window.count >= IP_FAILURES_PER_MINUTE) window.blockedUntil = now + IP_BLOCK_MS;
  if (now - current.global.windowStart > WINDOW_MS) current.global = { count: 0, windowStart: now };
  current.global.count += 1;
}

/** Spends the token if it is valid. A valid token is refused while the caller or the whole app is rate limited. */
export function consumePairingToken(token: unknown, ip: string, now: number = Date.now()): ConsumeResult {
  const current = state();
  prune(current, now);

  const window = current.byIp.get(ip);
  if (window && window.blockedUntil > now) {
    return { ok: false, reason: "limited", retryAfterSeconds: Math.ceil((window.blockedUntil - now) / 1000) };
  }
  if (now - current.global.windowStart <= WINDOW_MS && current.global.count >= GLOBAL_FAILURES_PER_MINUTE) {
    return { ok: false, reason: "limited", retryAfterSeconds: Math.ceil((current.global.windowStart + WINDOW_MS - now) / 1000) };
  }

  if (typeof token === "string" && TOKEN_FORMAT.test(token)) {
    const key = hash(token);
    const entry = current.pending.get(key);
    if (entry && entry.expiresAt > now) {
      current.pending.delete(key);
      return { ok: true };
    }
  }
  recordFailure(current, ip, now);
  return { ok: false, reason: "invalid" };
}
