import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * The mobile gallery needs a production build (the gateway does not proxy the dev server's hot-reload socket),
 * and the test pairs phones and writes media files. So it runs its own server on spare ports with its own state
 * and media folders under the temp directory, and never touches the real `.gather` or library.
 * Build first: `npm run build`, then `npm run test:e2e:mobile`.
 */
const root = join(tmpdir(), "gather-mobile-e2e");
const home = join(root, "home");
const media = join(root, "media");
mkdirSync(home, { recursive: true });
mkdirSync(media, { recursive: true });

const APP_PORT = "3410";
const MOBILE_PORT = "3411";
Object.assign(process.env, {
  GATHER_HOME: home,
  GATHER_MEDIA_ROOT: media,
  GATHER_PORT: APP_PORT,
  GATHER_MOBILE_PORT: MOBILE_PORT,
});

export default defineConfig({
  testDir: "./e2e",
  testMatch: "mobile.spec.ts",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  workers: 1,
  reporter: "list",
  use: { baseURL: `http://127.0.0.1:${APP_PORT}`, trace: "on-first-retry" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx next start -H 127.0.0.1 -p ${APP_PORT}`,
    url: `http://127.0.0.1:${APP_PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { GATHER_HOME: home, GATHER_MEDIA_ROOT: media, GATHER_PORT: APP_PORT, GATHER_MOBILE_PORT: MOBILE_PORT },
  },
});
