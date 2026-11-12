"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { ActionResult } from "@/lib/spec";
import { renameDevice, revokeAllDevices, revokeDevice } from "@/server/mobile/devices";
import {
  createPairingOffer,
  disableMobileAccess,
  enableMobileAccess,
  getMobileStatus,
} from "@/server/mobile/service";
import type { MobileStatus, PairingOffer } from "@/server/mobile/service";

const hoursInput = z.union([z.literal(0), z.literal(1), z.literal(8)]);

function failure(error: unknown, fallback: string): { ok: false; error: string } {
  if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EADDRINUSE") {
    return { ok: false, error: "Another program is using the mobile port. Set GATHER_MOBILE_PORT to a free port and restart gather." };
  }
  console.error(`gather: ${fallback}`, error);
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
