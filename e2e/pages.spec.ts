import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

/**
 * Every page must render without the client-side error boundary. Next's built-in fallback says
 * "This page couldn't load" and replaces <html> with id="__next_error__", so checking both catches
 * crashes that never show up in the server-rendered HTML.
 */
const ERROR_TEXT = "This page couldn’t load";

/** Waits past hydration so a crash thrown from a client effect has actually happened. */
async function expectHealthy(page: Page, path: string, heading: string) {
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));

  await page.goto(path);
  await page.waitForLoadState("networkidle");

  await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
  await expect(page.locator("html#__next_error__")).toHaveCount(0);
  await expect(page.getByText(ERROR_TEXT)).toHaveCount(0);
  expect(errors).toEqual([]);
}

for (const { path, heading } of [
  { path: "/", heading: "Run" },
  { path: "/library", heading: "Library" },
  { path: "/history", heading: "History" },
  { path: "/settings", heading: "Settings" },
] as const) {
  test(`${path} renders without a client error`, async ({ page }) => {
    await expectHealthy(page, path, heading);
  });
}

test("no page scrolls sideways at 390 px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });

  for (const path of ["/", "/library", "/history", "/settings"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    // A single wide element (the old top-bar link, a segmented control) pushes the whole page
    // sideways on a phone; nothing should ever be wider than the viewport.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow, `${path} is wider than the viewport`).toBeLessThanOrEqual(0);
  }
});

test("library rows fill in their stats instead of staying on the spinner", async ({ page }) => {
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));

  await page.goto("/library");
  await expect(page.getByRole("heading", { level: 1, name: "Library" })).toBeVisible();

  // With accounts present, every size cell resolves from "…" to a formatted size once the
  // streamed promise settles. With none, the empty state is the correct outcome.
  const empty = page.getByText("No accounts yet. Your first download will show up here.");
  if (await empty.isVisible()) return;

  await expect(page.getByRole("cell", { name: "…" })).toHaveCount(0, { timeout: 30_000 });
  expect(errors).toEqual([]);
});

test("the cookie warning renders without a client error", async ({ page }) => {
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));

  await page.goto("/settings");
  const check = page.getByRole("button", { name: "Check cookies" });
  test.skip((await check.count()) === 0, "cookies are turned off in this profile");

  // The probe is a server action; wait for its POST and for the button to leave its busy state,
  // otherwise the notice may not have rendered yet.
  const replied = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().includes("/settings"),
  );
  await check.click();
  await replied;
  await expect(check).not.toHaveAttribute("aria-busy", "true");

  // A readable browser with a signed-in site shows no warning at all; either outcome is healthy.
  const warning = page.getByText(/can't read .*cookies|look signed out/);
  if ((await warning.count()) === 0) {
    test.skip(true, "this browser's cookies are readable and signed in");
  }

  await expect(warning.first()).toBeVisible();
  expect(errors).toEqual([]);
});
