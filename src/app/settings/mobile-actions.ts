"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { offlineSettingsPatchSchema } from "@/lib/offline";
import type { OfflineEncoderStatus, OfflineEstimate, OfflineSettings } from "@/lib/offline";
import type { ActionResult } from "@/lib/spec";
import { renameDevice, revokeAllDevices, revokeDevice, setDeviceCanDownload } from "@/server/mobile/devices";
import {
  createPairingOffer,
  disableMobileAccess,
  enableMobileAccess,
  getMobileStatus,
} from "@/server/mobile/service";
import type { MobileStatus, PairingOffer } from "@/server/mobile/service";
import { getOfflineEncoderStatus } from "@/server/offline/encoder";
import { getOfflineEstimate, invalidateOfflineSettingsView } from "@/server/offline/index";
import { handleOfflineSettingsChanged } from "@/server/offline/preloader";
import { saveOfflineSettings } from "@/server/offline/settings";

const hoursInput = z.union([z.literal(0), z.literal(1), z.literal(8)]);

function failure(error: unknown, fallback: string): { ok: false; error: string } {
  if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EADDRINUSE") {
    return { ok: false, error: "Another program is using the mobile port. Set GATHER_MOBILE_PORT to a free port and restart grabberX." };
  }
  console.error(`grabberX: ${fallback}`, error);
  return { ok: false, error: fallback };
}

export async function mobileStatusAction(): Promise<MobileStatus> {
  return getMobileStatus();
}

export async function setMobileAccessAction(input: unknown): Promise<ActionResult<MobileStatus>> {
  const parsed = z.object({ enabled: z.boolean(), autoOffHours: hoursInput.optional(), forget: z.boolean().optional() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "That choice isn't valid." };
  try {
    if (parsed.data.enabled) await enableMobileAccess(parsed.data.autoOffHours ?? 0);
    else await disableMobileAccess({ forget: parsed.data.forget === true });
    revalidatePath("/settings");
    return { ok: true, data: await getMobileStatus() };
  } catch (error) {
    return failure(error, "Sharing couldn't be changed.");
  }
}

export async function createPairingOfferAction(address?: unknown): Promise<ActionResult<PairingOffer>> {
  try {
    const offer = await createPairingOffer(typeof address === "string" ? address : undefined);
    if (!offer) return { ok: false, error: "Turn on sharing first, and check that this PC is on a network." };
    return { ok: true, data: offer };
  } catch (error) {
    return failure(error, "The code couldn't be made.");
  }
}

export async function revokeDeviceAction(id: unknown): Promise<ActionResult<MobileStatus>> {
  if (typeof id !== "string") return { ok: false, error: "That phone isn't valid." };
  try {
    await revokeDevice(id);
    return { ok: true, data: await getMobileStatus() };
  } catch (error) {
    return failure(error, "That phone couldn't be removed.");
  }
}

export async function revokeAllDevicesAction(): Promise<ActionResult<MobileStatus>> {
  try {
    await revokeAllDevices();
    return { ok: true, data: await getMobileStatus() };
  } catch (error) {
    return failure(error, "The phones couldn't be removed.");
  }
}

export async function renameDeviceAction(id: unknown, label: unknown): Promise<ActionResult<MobileStatus>> {
  if (typeof id !== "string" || typeof label !== "string") return { ok: false, error: "That name isn't valid." };
  try {
    if (!(await renameDevice(id, label))) return { ok: false, error: "Enter a name." };
    return { ok: true, data: await getMobileStatus() };
  } catch (error) {
    return failure(error, "That name couldn't be saved.");
  }
}

export async function setDeviceDownloadPermissionAction(
  id: unknown,
  canDownload: unknown,
): Promise<ActionResult<MobileStatus>> {
  if (typeof id !== "string" || typeof canDownload !== "boolean") {
    return { ok: false, error: "That permission isn't valid." };
  }
  try {
    if (!(await setDeviceCanDownload(id, canDownload))) {
      return { ok: false, error: "That phone isn't paired anymore." };
    }
    revalidatePath("/settings");
    return { ok: true, data: await getMobileStatus() };
  } catch (error) {
    return failure(error, "That permission couldn't be saved.");
  }
}

export interface OfflineSettingsSaveResult {
  settings: OfflineSettings;
  estimate: OfflineEstimate;
  encoderStatus: OfflineEncoderStatus;
}

export async function saveOfflineSettingsAction(
  input: unknown,
): Promise<ActionResult<OfflineSettingsSaveResult>> {
  const parsed = offlineSettingsPatchSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "That offline setting isn't valid." };
  }
  try {
    const settings = await saveOfflineSettings(parsed.data);
    invalidateOfflineSettingsView();
    await handleOfflineSettingsChanged();
    const [estimate, encoderStatus] = await Promise.all([
      getOfflineEstimate(settings),
      getOfflineEncoderStatus(settings.video.encoder),
    ]);
    revalidatePath("/settings");
    return { ok: true, data: { settings, estimate, encoderStatus } };
  } catch (error) {
    return failure(error, "Offline settings couldn't be saved.");
  }
}
