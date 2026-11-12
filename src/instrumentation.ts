export async function register(): Promise<void> {
  // Node-only code lives in its own module so the Edge build of this file never sees process.exit.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const [{ listenForShutdown }, { startScheduler }, { startThumbWarmer }, { startMobileIfEnabled }] = await Promise.all([
    import("@/server/shutdown-hook"),
    import("@/server/scheduler"),
    import("@/server/thumb-warmer"),
    import("@/server/mobile/service"),
  ]);
  listenForShutdown();
  // The same Node-only hook starts the automatic updates timer. It does nothing while they are off.
  startScheduler();
  // Builds thumbnails in the background so a gallery opens with them cached.
  startThumbWarmer();
  // Off unless the user turned on sharing in Settings; then it listens again after a restart.
  void startMobileIfEnabled();
}
