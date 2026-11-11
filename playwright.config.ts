import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests drive the real app on 127.0.0.1:3210. They exist because a page can render
 * fine on the server and still crash in the browser (e.g. a bad promise prop), which neither
 * `npm test` nor `curl` would catch.
 */
export default defineConfig({
  testDir: "./e2e",
  // A cold Turbopack dev server compiles each route on first request; give that room before failing.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: 4,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3210",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:3210",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
