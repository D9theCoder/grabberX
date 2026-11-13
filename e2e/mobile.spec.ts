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
      await page.getByRole("radiogroup", { name: "Connection mode" }).getByRole("radio", { name: "HTTPS (installable PWA)" }).click();
      const httpsLink = (await page.getByTestId("pairing-link").textContent()) ?? "";
      expect(httpsLink).toMatch(new RegExp(`^https://[0-9.]+:${MOBILE_PORT}/m/pair#[a-z2-7]{26}$`));
      const hash = new URL(link).hash;

      const phone = await browser.newContext({ viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true, ignoreHTTPSErrors: true });
      const mobile = await phone.newPage();
      const errors: Error[] = [];
      mobile.on("pageerror", (error) => errors.push(error));

      const caCertRes = await phone.request.get(`${GATEWAY}/m/ca.crt`);
      expect(caCertRes.status()).toBe(200);
      expect(caCertRes.headers()["content-type"]).toBe("application/x-x509-ca-cert");

      expect((await phone.request.get(`${GATEWAY}/m`)).status()).toBe(401);
      expect((await phone.request.get(`${GATEWAY}/api/media?account=${ACCOUNT}&path=Video/1800000000000009999_1.mp4`)).status()).toBe(401);

      await mobile.goto(`https://127.0.0.1:${MOBILE_PORT}/m/pair${hash}`);
      await expect(mobile.getByRole("heading", { level: 1, name: "Library" })).toBeVisible();
      await mobile.goto(`${GATEWAY}/m`);
      await expect(mobile.getByRole("heading", { level: 1, name: "Library" })).toBeVisible();
      expect(mobile.url()).toBe(`${GATEWAY}/m`);

      // The code is spent.
      expect((await phone.request.post(`${GATEWAY}/m/api/pair`, { data: { token: hash.slice(1) } })).status()).toBe(401);

      // Browse: account, folders, the grid, and the viewer.
      await mobile.getByRole("link", { name: ACCOUNT }).click();
      await mobile.getByRole("link", { name: "Image", exact: true }).click();
      await mobile.getByRole("link", { name: "2025", exact: true }).click();
      await expect(mobile.getByRole("navigation", { name: "Breadcrumb" })).toContainText("2025");
      const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);

      const tiles = mobile.locator("button[data-index]");
      await expect(tiles).toHaveCount(5);
      await expect
        .poll(() => tiles.first().locator("img").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
        .toBe(true);

      await tiles.first().click();
      const viewer = mobile.getByRole("dialog");
      await expect(viewer).toContainText("1 / 5");
      await expect(viewer.getByRole("button", { name: "Previous" })).toHaveCount(0);
      await expect(viewer.getByRole("button", { name: "Next" })).toHaveCount(0);
      await expect(viewer.getByRole("button", { name: "Details" })).toBeVisible();
      await expect(viewer.getByRole("button", { name: "Download" })).toBeVisible();
      await expect(viewer.getByRole("button", { name: "Close" })).toBeVisible();

      const cdp = await phone.newCDPSession(mobile);
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: 320, y: 450, id: 1 }],
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: 260, y: 450, id: 1 }],
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: 90, y: 450, id: 1 }],
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await expect(viewer).toContainText("2 / 5");

      // Pinch-to-zoom scales the media element directly rather than zooming the web page viewport.
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [
          { x: 170, y: 450, id: 1 },
          { x: 250, y: 450, id: 2 },
        ],
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          { x: 110, y: 450, id: 1 },
          { x: 310, y: 450, id: 2 },
        ],
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      const resetZoom = viewer.getByRole("button", { name: "Reset zoom" });
      await expect(resetZoom).toBeVisible();
      expect(await mobile.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(1);
      expect(await viewer.locator('img[alt]:not([alt=""])').evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).a)).toBeGreaterThan(1.1);
      await resetZoom.click();
      await expect(resetZoom).toHaveCount(0);

      await mobile.goBack();
      await expect(viewer).toHaveCount(0);
      expect(mobile.url()).toContain(`/m/${ACCOUNT}/Image/2025`);

      // Sort and filter.
      await mobile.getByRole("radio", { name: "Oldest first" }).click();
      await expect(tiles.first()).toHaveAttribute("aria-label", "1800000000000000000_1.png");
      await mobile.getByRole("radio", { name: "Videos" }).click();
      await expect(mobile.getByText("Nothing matches this filter in this folder.")).toBeVisible();
      await mobile.getByRole("radio", { name: "All" }).click();

      // One file downloads from the viewer, with its details.
      await tiles.first().click();
      await mobile.getByRole("button", { name: "Details" }).click();
      await expect(viewer).toContainText("1800000000000000000_1.png");
      const [single] = await Promise.all([mobile.waitForEvent("download"), mobile.getByRole("button", { name: "Download" }).click()]);
      expect(single.suggestedFilename()).toBe("1800000000000000000_1.png");
      await mobile.goBack();
      await expect(viewer).toHaveCount(0);

      // No separate Select button; hold on an image and drag to select a block, then download as one zip.
      await expect(mobile.getByRole("button", { name: "Select", exact: true })).toHaveCount(0);
      const startBox = await tiles.nth(0).boundingBox();
      const endBox = await tiles.nth(2).boundingBox();
      expect(startBox && endBox).toBeTruthy();
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: startBox!.x + startBox!.width / 2, y: startBox!.y + startBox!.height / 2, id: 1 }],
      });
      await mobile.waitForTimeout(480);
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: endBox!.x + endBox!.width / 2, y: endBox!.y + endBox!.height / 2, id: 1 }],
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });

      const bar = mobile.getByRole("toolbar", { name: "Selection" });
      await expect(bar).toContainText("3 files selected");
      await expect(viewer).toHaveCount(0);
      await expect(tiles.nth(0)).toHaveAttribute("aria-pressed", "true");
      await expect(tiles.nth(1)).toHaveAttribute("aria-pressed", "true");
      await expect(tiles.nth(2)).toHaveAttribute("aria-pressed", "true");

      // Bottom bar puts the X cancel button on the left and the selection count in the center.
      const cancelButton = bar.getByRole("button", { name: "Cancel selection" });
      const countText = bar.getByText("3 files selected");
      const downloadButton = bar.getByRole("button", { name: "Download", exact: true });
      const cancelBox = await cancelButton.boundingBox();
      const countBox = await countText.boundingBox();
      const downloadBox = await downloadButton.boundingBox();
      const barBox = await bar.boundingBox();
      expect(cancelBox && countBox && downloadBox && barBox).toBeTruthy();
      expect(cancelBox!.x).toBeLessThan(countBox!.x);
      expect(countBox!.x).toBeLessThan(downloadBox!.x);
      expect(Math.abs(cancelBox!.y + cancelBox!.height / 2 - (downloadBox!.y + downloadBox!.height / 2))).toBeLessThanOrEqual(2);
      expect(barBox!.height).toBeLessThanOrEqual(52);
      expect(Math.abs(countBox!.x + countBox!.width / 2 - (barBox!.x + barBox!.width / 2))).toBeLessThan(20);

      await bar.getByRole("button", { name: "All", exact: true }).click();
      await expect(bar).toContainText("5 files selected");
      await bar.getByRole("button", { name: "Clear", exact: true }).click();
      await expect(bar).toContainText("Nothing selected");
      await tiles.nth(2).click();
      await tiles.nth(3).click();
      await expect(bar).toContainText("2 files selected");
      const [zip] = await Promise.all([mobile.waitForEvent("download"), bar.getByRole("button", { name: "Download", exact: true }).click()]);
      expect(zip.suggestedFilename()).toMatch(/\.zip$/);
      await cancelButton.click();
      await expect(bar).toHaveCount(0);

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

      // A video with no captured poster still shows a first frame on the phone: the tile falls back to a muted
      // preview instead of staying blank, and never uploads a poster through the read-only gateway.
      expect((await phone.request.get(`${video}&thumb=480`)).status()).toBe(404);
      await mobile.goto(`${GATEWAY}/m/${ACCOUNT}/Video`);
      const videoTile = mobile.getByRole("button", { name: "1800000000000009999_1.mp4" });
      await expect(videoTile.locator("video")).toHaveCount(1);
      await expect(videoTile.locator("video")).toHaveAttribute("preload", "metadata");
      await videoTile.click();
      const loopBtn = viewer.getByRole("button", { name: "Loop" });
      const autoplayBtn = viewer.getByRole("button", { name: "Autoplay" });
      await expect(loopBtn).toHaveAttribute("aria-pressed", "false");
      await expect(autoplayBtn).toHaveAttribute("aria-pressed", "false");
      await loopBtn.click();
      await autoplayBtn.click();
      await expect(loopBtn).toHaveAttribute("aria-pressed", "true");
      await expect(autoplayBtn).toHaveAttribute("aria-pressed", "true");
      await expect(viewer.locator("video")).toHaveAttribute("loop", "");
      await mobile.keyboard.press("+");
      const videoReset = viewer.getByRole("button", { name: "Reset zoom" });
      await expect(videoReset).toBeVisible();
      await expect
        .poll(() => viewer.locator("video").evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).a))
        .toBeGreaterThan(1.4);
      await videoReset.click();
      await expect(videoReset).toHaveCount(0);
      await viewer.getByRole("button", { name: "Close" }).click();
      await expect(viewer).toHaveCount(0);

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

      // PWA: manifest, active service worker controlling /m, in-app install prompt, and offline fallback.
      const manifestRes = await phone.request.get(`${GATEWAY}/manifest.webmanifest`);
      expect(manifestRes.status()).toBe(200);
      expect(await manifestRes.json()).toMatchObject({
        id: "/m",
        name: "grabberX gallery",
        start_url: "/m",
        scope: "/m",
        display: "standalone",
      });
      await expect
        .poll(() =>
          mobile.evaluate(async () => {
            if (!("serviceWorker" in navigator)) return null;
            const reg = await navigator.serviceWorker.ready;
            return {
              scope: new URL(reg.scope).pathname,
              controlled: Boolean(navigator.serviceWorker.controller),
            };
          }),
        )
        .toEqual({ scope: "/m", controlled: true });

      await mobile.evaluate(() => {
        const event = new Event("beforeinstallprompt", { cancelable: true }) as Event & {
          prompt: () => Promise<void>;
          userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
        };
        (window as unknown as { __promptCalled?: boolean }).__promptCalled = false;
        event.prompt = async () => {
          (window as unknown as { __promptCalled?: boolean }).__promptCalled = true;
        };
        event.userChoice = Promise.resolve({ outcome: "accepted", platform: "web" });
        window.dispatchEvent(event);
      });
      const installRegion = mobile.getByRole("region", { name: "Install app" });
      await expect(installRegion).toBeVisible();
      await installRegion.getByRole("button", { name: "Install app" }).click();
      await expect(installRegion).toHaveCount(0);
      expect(await mobile.evaluate(() => (window as unknown as { __promptCalled?: boolean }).__promptCalled)).toBe(true);

      await phone.setOffline(true);
      await mobile.reload();
      await expect(mobile.getByRole("heading", { level: 1, name: /Can.t reach your PC/ })).toBeVisible();
      await phone.setOffline(false);
      await mobile.getByRole("button", { name: "Try again" }).click();
      await expect(mobile.getByRole("heading", { level: 1, name: "Library" })).toBeVisible();

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
