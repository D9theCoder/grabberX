import "server-only";
import { redirect } from "next/navigation";
import { isPackaged } from "@/server/env";
import { isConfigured } from "@/server/store";

/** Sends a new user of the packaged app to the first-run screen. From source there is no such step. */
export async function requireSetup(): Promise<void> {
  if (isPackaged() && !(await isConfigured())) redirect("/welcome");
}
