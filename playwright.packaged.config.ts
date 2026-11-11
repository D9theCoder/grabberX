import { defineConfig } from "@playwright/test";

/**
 * Drives the real Electron app. By default it launches `electron electron/main.cjs` against
 * `.next/standalone`; set GATHER_EXE to the installed or unpacked Gather.exe to test the packaged build.
 */
export default defineConfig({
  testDir: "./e2e/packaged",
  timeout: 180_000,
  expect: { timeout: 20_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: "list",
});
