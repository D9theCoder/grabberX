import { expect, test } from "@playwright/test";

/** Regression checks for the design-handoff fixes. */

test("secondary buttons keep their hairline border", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByRole("button", { name: "Check" })).toHaveCSS(
    "border-top-color",
    "rgb(201, 201, 201)",
  );
});

test("segmented controls hug their options", async ({ page }) => {
  await page.goto("/");
  const group = page.getByRole("radiogroup", { name: "Media" });
  const width = (await group.boundingBox())?.width ?? 0;
  const parentWidth = await group.evaluate((el) => el.parentElement?.getBoundingClientRect().width ?? 0);
  expect(width).toBeGreaterThan(0);
  expect(width).toBeLessThan(parentWidth - 40);
});

test("advanced switches offer Changed · Reset and warn in danger", async ({ page }) => {
  await page.goto("/");
  await page.getByText("Advanced", { exact: true }).click();
  await page.getByRole("switch", { name: "Include retweets" }).click();

  await expect(page.getByRole("button", { name: "Reset" }).first()).toBeVisible();
  await expect(page.getByText("Downloads everything again and replaces what is on disk. Use with care.")).toHaveCSS(
    "color",
    "rgb(179, 38, 30)",
  );
});

test("the Settings button aligns with its field", async ({ page }) => {
  await page.goto("/settings");
  const field = page.getByLabel("gallery-dl path");
  const button = page.getByRole("button", { name: "Check" });
  const fieldBox = await field.boundingBox();
  const buttonBox = await button.boundingBox();
  expect(Math.abs((fieldBox?.y ?? 0) - (buttonBox?.y ?? 0))).toBeLessThanOrEqual(1);
});

test("library hides Use as new run behind the overflow menu", async ({ page }) => {
  await page.goto("/library");
  const menu = page.getByRole("button", { name: /More actions for/ }).first();
  test.skip((await menu.count()) === 0, "this media root has no accounts yet");

  await expect(page.getByRole("menuitem", { name: "Use as new run" })).toHaveCount(0);
  await menu.click();
  await expect(page.getByRole("menuitem", { name: "Use as new run" })).toBeVisible();
});

test.describe("mobile", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("library and history stack without horizontal page scroll", async ({ page }) => {
    for (const path of ["/library", "/history"]) {
      await page.goto(path);
      await expect(page.getByRole("table")).toBeHidden();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    }
  });

  test("the library overflow menu holds every row action", async ({ page }) => {
    await page.goto("/library");
    const menu = page.getByRole("button", { name: /Actions for/ }).first();
    test.skip((await menu.count()) === 0, "this media root has no accounts yet");

    await menu.click();
    await expect(page.getByRole("menuitem", { name: "Update" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Open folder" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Use as new run" })).toBeVisible();
  });
});
