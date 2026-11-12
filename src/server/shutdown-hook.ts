import "server-only";

interface ParentPort {
  on(event: "message", listener: (message: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

/**
 * The Electron shell starts this server as a utility process. Windows has no SIGTERM, so it asks for a
 * clean stop by message: active downloads get the same Stop treatment as the Stop button.
 */
export function listenForShutdown(): void {
  const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;
  if (!parentPort) return;

  parentPort.on("message", async (message) => {
    if (message.data !== "shutdown") return;
    try {
      // No new pass may start while the app is quitting.
      const { stopScheduler } = await import("@/server/scheduler");
      await stopScheduler();
      const { runQueue } = await import("@/server/run-queue");
      await runQueue.shutdown();
    } catch (error) {
      console.error("grabberX: shutdown could not stop every run.", error);
    }
    parentPort.postMessage("shutdown-done");
    process.exit(0);
  });
}
