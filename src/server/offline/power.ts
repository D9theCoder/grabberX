import "server-only";
import { spawn } from "node:child_process";

const CACHE_TTL_MS = 60_000;
const CHECK_TIMEOUT_MS = 4_000;

interface PowerCacheState {
  checkedAt: number;
  pluggedIn: boolean;
  inFlight: Promise<boolean> | null;
}

const POWER_STATE_KEY = Symbol.for("gather.offline.power");

function powerState(): PowerCacheState {
  const holder = globalThis as unknown as Record<symbol, PowerCacheState | undefined>;
  return (holder[POWER_STATE_KEY] ??= {
    checkedAt: 0,
    pluggedIn: true,
    inFlight: null,
  });
}

/**
 * Parses `Win32_Battery.BatteryStatus` values (comma- or newline-separated integers).
 * Desktop PCs have no battery instance (empty output) and are always treated as plugged in.
 * BatteryStatus codes: 1=Discharging, 2=AC/Unknown, 3=Fully Charged, 4=Low, 5=Critical, 6-9=Charging.
 */
export function parseBatteryStatusOutput(stdout: string): boolean {
  const codes = stdout
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => Number(part))
    .filter((value) => Number.isInteger(value));

  if (codes.length === 0) return true;
  const onAc = codes.some((code) => code === 2 || code === 3 || (code >= 6 && code <= 9));
  if (onAc) return true;
  const discharging = codes.some((code) => code === 1 || code === 4 || code === 5);
  return !discharging;
}

function queryWindowsPluggedIn(): Promise<boolean> {
  if (process.platform !== "win32") return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    let child;
    try {
      child = spawn(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "(Get-CimInstance -ClassName Win32_Battery -ErrorAction SilentlyContinue | Select-Object -ExpandProperty BatteryStatus) -join ','",
        ],
        {
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
    } catch {
      finish(true);
      return;
    }

    const chunks: Buffer[] = [];
    timer = setTimeout(() => {
      child.kill();
      finish(true);
    }, CHECK_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", () => finish(true));
    child.on("close", (code) => {
      if (code !== 0) {
        finish(true);
        return;
      }
      finish(parseBatteryStatusOutput(Buffer.concat(chunks).toString("utf8")));
    });
  });
}

/**
 * Returns true if the PC is plugged into AC power (or is a desktop without a battery).
 * Cached for 60 s so background throttling never hammers WMI/CIM.
 */
export async function isPluggedIn(options?: { now?: number; forceRefresh?: boolean }): Promise<boolean> {
  const state = powerState();
  const now = options?.now ?? Date.now();
  if (!options?.forceRefresh && state.checkedAt > 0 && now - state.checkedAt < CACHE_TTL_MS) {
    return state.pluggedIn;
  }
  if (state.inFlight) return state.inFlight;
  const probe = queryWindowsPluggedIn()
    .then((result) => {
      state.pluggedIn = result;
      state.checkedAt = Date.now();
      return result;
    })
    .finally(() => {
      state.inFlight = null;
    });
  state.inFlight = probe;
  return probe;
}

export function resetPowerCache(): void {
  const state = powerState();
  state.checkedAt = 0;
  state.pluggedIn = true;
  state.inFlight = null;
}
