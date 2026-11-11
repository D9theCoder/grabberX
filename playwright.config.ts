import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests drive the real app on 127.0.0.1:3210. They exist because a page can render
 * fine on the server and still crash in the browser (e.g. a bad promise prop), which neither
 * `npm test` nor `curl` would catch.
 */
// Point E2E_BASE_URL at an already-running server (for example the packaged app) to skip the dev server.
const externalBaseURL = process.env.E2E_BASE_URL;
const baseURL = externalBaseURL ?? "http://127.0.0.1:3210";

export default defineConfig({
  testDir: "./e2e",
  // e2e/packaged drives the Electron app and has its own config (playwright.packaged.config.ts).
  testIgnore: "**/packaged/**",
  // A cold Turbopack dev server compiles each route on first request; give that room before failing.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: 4,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: externalBaseURL
    ? undefined
    : {
        command: "npm run dev",
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
