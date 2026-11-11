export async function register(): Promise<void> {
  // Node-only code lives in its own module so the Edge build of this file never sees process.exit.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { listenForShutdown } = await import("@/server/shutdown-hook");
  listenForShutdown();
}
