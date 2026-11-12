import { afterEach, describe, expect, it } from "vitest";
import {
  consumePairingToken,
  createPairingToken,
  MAX_OPEN_TOKENS,
  openPairingTokens,
  PAIRING_TTL_MS,
  resetPairingState,
} from "@/server/mobile/pairing";

const T0 = 1_800_000_000_000;

afterEach(() => {
  resetPairingState();
});

describe("createPairingToken", () => {
  it("makes a 26 character lowercase base32 token that expires in five minutes", () => {
    const { token, expiresAt } = createPairingToken(T0);
    expect(token).toMatch(/^[a-z2-7]{26}$/);
    expect(expiresAt).toBe(T0 + PAIRING_TTL_MS);
  });

  it("makes a different token every time", () => {
    const seen = new Set(Array.from({ length: 200 }, () => createPairingToken(T0).token));
    expect(seen.size).toBe(200);
  });

  it("keeps at most five open tokens by dropping the oldest", () => {
    const first = createPairingToken(T0).token;
    for (let i = 0; i < MAX_OPEN_TOKENS; i += 1) createPairingToken(T0);
    expect(openPairingTokens(T0)).toBe(MAX_OPEN_TOKENS);
    expect(consumePairingToken(first, "10.0.0.1", T0).ok).toBe(false);
  });
});

describe("consumePairingToken", () => {
  it("accepts a fresh token once", () => {
    const { token } = createPairingToken(T0);
    expect(consumePairingToken(token, "10.0.0.2", T0 + 1000)).toEqual({ ok: true });
    expect(consumePairingToken(token, "10.0.0.2", T0 + 2000)).toEqual({ ok: false, reason: "invalid" });
  });

  it("refuses a token after five minutes", () => {
    const { token } = createPairingToken(T0);
    expect(consumePairingToken(token, "10.0.0.3", T0 + PAIRING_TTL_MS)).toEqual({ ok: false, reason: "invalid" });
  });

  it("refuses malformed input without throwing", () => {
    const inputs = [undefined, null, 5, {}, "", "short", "A".repeat(26), "a".repeat(27), "a".repeat(25) + "1"];
    inputs.forEach((bad, index) => {
      expect(consumePairingToken(bad, `10.0.1.${index}`, T0)).toEqual({ ok: false, reason: "invalid" });
    });
  });

  it("blocks an address after five failures, even for a valid token", () => {
    const { token } = createPairingToken(T0);
    for (let i = 0; i < 5; i += 1) consumePairingToken("a".repeat(26), "10.0.0.5", T0 + i);
    const blocked = consumePairingToken(token, "10.0.0.5", T0 + 10);
    expect(blocked.ok).toBe(false);
    expect(blocked).toMatchObject({ reason: "limited" });
    if (!blocked.ok && blocked.reason === "limited") expect(blocked.retryAfterSeconds).toBeGreaterThan(500);
    // Another phone is not affected and the token was not spent.
    expect(consumePairingToken(token, "10.0.0.6", T0 + 20)).toEqual({ ok: true });
  });

  it("lets the address try again after the block ends", () => {
    const { token } = createPairingToken(T0);
    for (let i = 0; i < 5; i += 1) consumePairingToken("a".repeat(26), "10.0.0.7", T0 + i);
    const later = T0 + 11 * 60_000;
    const fresh = createPairingToken(later);
    expect(consumePairingToken(fresh.token, "10.0.0.7", later)).toEqual({ ok: true });
    expect(token).not.toBe(fresh.token);
  });

  it("pauses everyone after thirty failures in a minute", () => {
    for (let i = 0; i < 30; i += 1) consumePairingToken("a".repeat(26), `10.1.0.${i}`, T0 + i);
    const { token } = createPairingToken(T0 + 100);
    expect(consumePairingToken(token, "10.2.0.1", T0 + 200)).toMatchObject({ ok: false, reason: "limited" });
    expect(consumePairingToken(token, "10.2.0.1", T0 + 61_000)).toEqual({ ok: true });
  });
});
