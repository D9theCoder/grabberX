import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * Drives the mobile gallery end to end: turn sharing on in Settings, pair a "phone" (a second browser
 * context with its own cookies) through the pairing link, browse, and check that the gateway answers 404
 * for every desktop route. It turns sharing off and removes the phone afterwards.
 *
 * It runs through `npm run test:e2e:mobile` (see playwright.mobile.config.ts): a production build on spare
 * ports with its own state and media folders, so nothing here touches the real library.
 */
const MOBILE_PORT = process.env.GATHER_MOBILE_PORT ?? "3411";
const GATEWAY = `http://127.0.0.1:${MOBILE_PORT}`;
const ACCOUNT = "example_mobile_e2e";
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

async function sharingSwitch(page: Page) {
  return page.getByRole("switch", { name: "Share the gallery on my network" });
}

async function cleanUp(page: Page) {
  await page.goto("/settings");
  const toggle = await sharingSwitch(page);
  if ((await toggle.getAttribute("aria-checked")) === "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  const remove = page.getByRole("button", { name: "Remove", exact: true });
  while ((await remove.count()) > 0) {
    await remove.first().click();
    await page.waitForTimeout(300);
  }
  await expect(page.getByRole("button", { name: "Remove all" })).toHaveCount(0);
}

test.describe("mobile gallery", () => {
  test.describe.configure({ mode: "serial" });
  const mediaRoot = process.env.GATHER_MEDIA_ROOT ?? process.cwd();

  test.beforeAll(async () => {
    const dir = join(mediaRoot, ACCOUNT, "Image", "2025");
    await mkdir(dir, { recursive: true });
    await mkdir(join(mediaRoot, ACCOUNT, "Video"), { recursive: true });
    await writeFile(join(mediaRoot, ACCOUNT, "archive.sqlite3"), "");
    for (let index = 0; index < 5; index++) await writeFile(join(dir, `180000000000000000${index}_1.png`), PNG_1X1);
    await writeFile(join(mediaRoot, ACCOUNT, "Video", "1800000000000009999_1.mp4"), Buffer.alloc(2048, 7));
  });

  test.afterAll(async () => {
    await rm(join(mediaRoot, ACCOUNT), { recursive: true, force: true });
  });

  test("pairs a phone, browses read only, and refuses desktop routes", async ({ page, browser }) => {
    // A run that was cut short can leave a phone behind in the temp state; start from none.
    await cleanUp(page);
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");
    const toggle = await sharingSwitch(page);
    try {
      if ((await toggle.getAttribute("aria-checked")) !== "true") await toggle.click();
      await expect(toggle).toHaveAttribute("aria-checked", "true");

      const noNetwork = page.getByText("No network found");
      const pairButton = page.getByRole("button", { name: /Pair a phone|Make a new code/ });
      await expect(pairButton.or(noNetwork)).toBeVisible();
      test.skip(await noNetwork.isVisible(), "this machine has no private network address");

      await pairButton.click();
      await page.getByText("Can't scan? Use the link instead").click();
      const link = (await page.getByTestId("pairing-link").textContent()) ?? "";
      expect(link).toMatch(new RegExp(`^http://[0-9.]+:${MOBILE_PORT}/m/pair#[a-z2-7]{26}$`));
      const hash = new URL(link).hash;

      const phone = await browser.newContext({ viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true });
      const mobile = await phone.newPage();
      const errors: Error[] = [];
      mobile.on("pageerror", (error) => errors.push(error));

      expect((await phone.request.get(`${GATEWAY}/m`)).status()).toBe(401);
      expect((await phone.request.get(`${GATEWAY}/api/media?account=${ACCOUNT}&path=Video/1800000000000009999_1.mp4`)).status()).toBe(401);

      await mobile.goto(`${GATEWAY}/m/pair${hash}`);
      await expect(mobile.getByRole("heading", { level: 1, name: "Library" })).toBeVisible();
      expect(mobile.url()).toBe(`${GATEWAY}/m`);

      // The code is spent.
      expect((await phone.request.post(`${GATEWAY}/m/api/pair`, { data: { token: hash.slice(1) } })).status()).toBe(401);

      // Browse: account, folders, the grid, and the viewer.
      await mobile.getByRole("link", { name: ACCOUNT }).click();
      await mobile.getByRole("link", { name: "Image", exact: true }).click();
      await mobile.getByRole("link", { name: "2025", exact: true }).click();
      const tiles = mobile.getByRole("button", { name: /^Open / });
      await expect(tiles).toHaveCount(5);
      await expect
        .poll(() => tiles.first().locator("img").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
        .toBe(true);

      await tiles.first().click();
      const viewer = mobile.getByRole("dialog");
      await expect(viewer).toContainText("1 / 5");
      await mobile.getByRole("button", { name: "Next" }).click();
      await expect(viewer).toContainText("2 / 5");
      await mobile.goBack();
      await expect(viewer).toHaveCount(0);
      expect(mobile.url()).toContain(`/m/${ACCOUNT}/Image/2025`);

      // Sort and filter.
      await mobile.getByLabel("Sort").selectOption("oldest");
      await expect(tiles.first()).toHaveAttribute("aria-label", "Open 1800000000000000000_1.png");
      await mobile.getByLabel("Show").selectOption("video");
      await expect(mobile.getByText("Nothing matches this filter in this folder.")).toBeVisible();
      await mobile.getByLabel("Show").selectOption("all");

      // One file downloads from the viewer, with its details.
      await tiles.first().click();
      await mobile.getByRole("button", { name: "Details" }).click();
      await expect(viewer).toContainText("1800000000000000000_1.png");
      const [single] = await Promise.all([mobile.waitForEvent("download"), mobile.getByRole("button", { name: "Download" }).click()]);
      expect(single.suggestedFilename()).toBe("1800000000000000000_1.png");
      await mobile.goBack();
      await expect(viewer).toHaveCount(0);

      // Select several and download them as one zip.
      const cells = mobile.locator("button[aria-label$='.png']");
      await mobile.getByRole("button", { name: "Select", exact: true }).click();
      await cells.nth(0).click();
      await cells.nth(1).click();
      await expect(mobile.getByRole("toolbar", { name: "Selection" })).toContainText("2 selected");
      await expect(viewer).toHaveCount(0);
      await mobile.getByRole("button", { name: "All", exact: true }).click();
      await expect(mobile.getByRole("toolbar", { name: "Selection" })).toContainText("5 selected");
      await mobile.getByRole("button", { name: "None", exact: true }).click();
      await cells.nth(2).click();
      await cells.nth(3).click();
      const [zip] = await Promise.all([mobile.waitForEvent("download"), mobile.getByRole("button", { name: "Download", exact: true }).click()]);
      expect(zip.suggestedFilename()).toMatch(/\.zip$/);
      await mobile.getByRole("button", { name: "Done" }).click();
      await expect(mobile.getByRole("toolbar", { name: "Selection" })).toHaveCount(0);

      // The zip request is read only, needs the session and the phone's own page, and cannot leave the library.
      const zipForm = { account: ACCOUNT, path: "Image/2025", name: "1800000000000000000_1.png" };
      const okZip = await phone.request.post(`${GATEWAY}/api/media/zip`, { form: zipForm });
      expect(okZip.status()).toBe(200);
      expect(okZip.headers()["content-type"]).toBe("application/zip");
      expect((await phone.request.post(`${GATEWAY}/api/media/zip`, { form: zipForm, headers: { origin: "http://evil.example" } })).status()).toBe(403);
      expect((await phone.request.post(`${GATEWAY}/api/media/zip`, { form: { account: ACCOUNT, path: "..", name: "package.json" } })).status()).toBeGreaterThanOrEqual(400);
      expect((await phone.request.post(`${GATEWAY}/api/media/zip`, { form: { account: "src", path: "", name: "package.json" } })).status()).toBeGreaterThanOrEqual(400);

      // Range requests pass through; anything outside the library does not.
      const video = `${GATEWAY}/api/media?account=${ACCOUNT}&path=Video/1800000000000009999_1.mp4`;
      const partial = await phone.request.get(video, { headers: { range: "bytes=0-99" } });
      expect(partial.status()).toBe(206);
      expect(partial.headers()["content-range"]).toBe("bytes 0-99/2048");
      for (const target of [`account=src&path=package.json`, `account=${ACCOUNT}&path=archive.sqlite3`]) {
        expect((await phone.request.get(`${GATEWAY}/api/media?${target}`)).status(), target).toBeGreaterThanOrEqual(400);
      }

      // Everything on the desktop is closed to the phone, writes included.
      for (const path of ["/", "/settings", "/library", "/history", "/api/runs", "/api/open-folder", "/api/health", "/api/media/zip", "/api/media/dims"]) {
        expect((await phone.request.get(`${GATEWAY}${path}`)).status(), path).toBe(404);
      }
      expect((await phone.request.post(`${GATEWAY}/m`, { data: {} })).status()).toBe(404);
      expect((await phone.request.post(`${GATEWAY}/api/media/poster?account=a&path=b.mp4`, { data: "x" })).status()).toBe(404);
      expect(errors).toEqual([]);

      // The desktop lists the phone; forgetting it ends the session.
      await page.reload();
      await expect(page.getByLabel("Phone name")).toHaveCount(1);
      await mobile.goto(`${GATEWAY}/m`);
      mobile.on("dialog", (dialog) => void dialog.accept());
      await mobile.getByRole("button", { name: "Forget this phone" }).click();
      await expect.poll(async () => (await phone.request.get(`${GATEWAY}/m`)).status()).toBe(401);
      await phone.close();
    } finally {
      await cleanUp(page);
    }
  });
});

test("the desktop pages do not show the phone UI", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByRole("link", { name: "Run" })).toBeVisible();
});
