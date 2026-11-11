export async function register(): Promise<void> {
  // Node-only code lives in its own module so the Edge build of this file never sees process.exit.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const [{ listenForShutdown }, { startScheduler }] = await Promise.all([
    import("@/server/shutdown-hook"),
    import("@/server/scheduler"),
  ]);
  listenForShutdown();
  // The same Node-only hook starts the automatic updates timer. It does nothing while they are off.
  startScheduler();
}
