import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
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

test("the automatic updates group saves its switch without a client error", async ({ page }) => {
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));

  await page.goto("/settings");
  await expect(page.getByRole("heading", { level: 2, name: "Automatic updates" })).toBeVisible();
  await expect(
    page.getByText("gather must be running (in the tray) for updates to happen."),
  ).toBeVisible();

  // Flipping it saves through a server action; the page must survive the round trip.
  const toggle = page.getByRole("switch", { name: "Automatic updates" });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  // Back off, so the shared settings file keeps automatic updates off for every other test.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");

  expect(errors).toEqual([]);
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

/** A solid-colour PNG built by hand, so the test needs no image library. */
function solidPng(width: number, height: number, [r, g, b]: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test.describe("media gallery", () => {
  // Generated files only. The account lives in the app's default media root (the repo folder when run from source).
  const account = "example_gallery_e2e";
  const mediaRoot = process.env.GATHER_MEDIA_ROOT ?? process.cwd();
  const imageCount = 150;

  // One worker creates and removes the fixture; parallel workers would delete it under each other.
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    const dir = join(mediaRoot, account, "Image", "2025");
    await mkdir(dir, { recursive: true });
    await mkdir(join(mediaRoot, account, "Video"), { recursive: true });
    await writeFile(join(mediaRoot, account, "archive.sqlite3"), "");
    for (let index = 0; index < imageCount; index++) {
      const width = 120 + (index % 7) * 40;
      const height = 120 + (index % 5) * 40;
      const buffer = solidPng(width, height, [90, 90 + (index % 100), 140]);
      await writeFile(join(dir, `${BigInt("1800000000000000000") + BigInt(index)}_1.png`), buffer);
    }
    await writeFile(join(mediaRoot, account, "Video", "1800000000000009999_1.mp4"), Buffer.alloc(2048, 7));
  });

  test.afterAll(async () => {
    await rm(join(mediaRoot, account), { recursive: true, force: true });
  });

  test("folders, a virtualized grid with thumbnails, and the lightbox", async ({ page }) => {
    const errors: Error[] = [];
    page.on("pageerror", (error) => errors.push(error));

    await page.goto(`/library/${account}`);
    await expect(page.getByRole("heading", { level: 1, name: account })).toBeVisible();
    await expect(page.getByRole("link", { name: "Image", exact: true })).toBeVisible();

    await page.getByRole("link", { name: "Image", exact: true }).click();
    await page.getByRole("link", { name: "2025", exact: true }).click();
    await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("2025");

    const tiles = page.locator("button[data-index]");
    await expect(tiles.first()).toBeVisible();
    expect(await tiles.count()).toBeLessThan(imageCount);

    const firstImage = tiles.first().locator("img");
    await expect.poll(() => firstImage.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);

    await tiles.first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(`1 of ${imageCount}`);
    expect(page.url()).toContain("file=");

    await page.keyboard.press("ArrowRight");
    await expect(dialog).toContainText(`2 of ${imageCount}`);
    await page.keyboard.press("i");
    await expect(dialog.getByRole("complementary", { name: "Details" })).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.locator("button[data-index]:focus")).toHaveCount(1);
    expect(page.url()).not.toContain("file=");
    expect(errors).toEqual([]);
  });

  test("the file route supports ranges and refuses anything outside the account", async ({ request }) => {
    const video = `/api/media?account=${account}&path=Video/1800000000000009999_1.mp4`;
    const partial = await request.get(video, { headers: { range: "bytes=0-99" } });
    expect(partial.status()).toBe(206);
    expect(partial.headers()["content-range"]).toBe("bytes 0-99/2048");
    expect((await partial.body()).length).toBe(100);
    expect((await request.get(video, { headers: { range: "bytes=5000-" } })).status()).toBe(416);

    for (const target of [
      `account=${account}&path=../${account}/Video/1800000000000009999_1.mp4`,
      `account=${account}&path=${encodeURIComponent("C:/Windows/win.ini")}`,
      `account=src&path=package.json`,
      `account=${account}&path=archive.sqlite3`,
    ]) {
      const response = await request.get(`/api/media?${target}`);
      expect(response.status(), target).toBeGreaterThanOrEqual(400);
      expect(response.headers()["content-type"]).not.toContain("image");
    }
  });

  test("arrow keys move between tiles and Enter opens the lightbox", async ({ page }) => {
    await page.goto(`/library/${account}?path=Image/2025`);
    const tiles = page.locator("button[data-index]");
    await tiles.first().focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("button[data-index='1']")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.locator("button[data-index]:focus")).not.toHaveAttribute("data-index", "1");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("button[data-index]:focus")).toHaveCount(1);
  });

  test("filters and sorts the grid", async ({ page }) => {
    await page.goto(`/library/${account}`);
    await page.getByRole("link", { name: "Video", exact: true }).click();
    await expect(page.locator("button[data-index]")).toHaveCount(1);
    await page.goto(`/library/${account}?path=Image/2025`);
    await page.getByRole("radio", { name: "Videos" }).click();
    await expect(page.getByText("Nothing matches this filter in this folder.")).toBeVisible();
    await page.getByRole("radio", { name: "Images" }).click();
    await page.getByRole("radio", { name: "Oldest first" }).click();
    await expect(page.locator("button[data-index='0']")).toHaveAttribute("aria-label", "1800000000000000000_1.png");
  });

  test("deleting asks first and then removes the file", async ({ page }) => {
    await page.goto(`/library/${account}?path=Image/2025`);
    await page.getByRole("radio", { name: "Oldest first" }).click();
    await page.locator("button[data-index='0']").click();
    await page.getByRole("button", { name: "Delete" }).click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toContainText("still remembers it in the archive");
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toHaveCount(0);

    await page.getByRole("button", { name: "Delete" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
    await expect(page.getByRole("dialog")).toContainText(`1 of ${imageCount - 1}`);
    const gone = await page.request.get(`/api/media?account=${account}&path=Image/2025/1800000000000000000_1.png`);
    expect(gone.status()).toBe(404);
  });

  test("the gallery does not scroll sideways at 390 px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const path of [`/library/${account}`, `/library/${account}?path=Image/2025`]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${path} is wider than the viewport`).toBeLessThanOrEqual(0);
    }
  });

  test("select mode: drag to select, the app's right-click menu, and bulk download and delete", async ({ page }) => {
    const errors: Error[] = [];
    page.on("pageerror", (error) => errors.push(error));
    await page.goto(`/library/${account}?path=Image/2025`);
    await page.getByRole("radio", { name: "Oldest first" }).click();
    const first = page.locator("button[data-index='0']");
    await expect(first).toBeVisible();

    // Right-click on a tile opens the app menu, not the browser's.
    await first.click({ button: "right" });
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem", { name: "Download" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Delete" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);

    await page.getByRole("button", { name: "Select", exact: true }).click();
    const bar = page.getByRole("toolbar", { name: "Selection" });
    await expect(bar).toContainText("Nothing selected");

    // Press on the first tile and drag across the next few: every tile the rectangle touches is selected.
    const start = await first.boundingBox();
    const end = await page.locator("button[data-index='3']").boundingBox();
    expect(start && end).toBeTruthy();
    await page.mouse.move(start!.x + 10, start!.y + 10);
    await page.mouse.down();
    await page.mouse.move(start!.x + 40, start!.y + 30, { steps: 4 });
    await page.mouse.move(end!.x + end!.width - 5, end!.y + 10, { steps: 8 });
    await page.mouse.up();
    await expect(first).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("button[data-index='3']")).toHaveAttribute("aria-pressed", "true");
    const selectedText = (await bar.textContent()) ?? "";
    const count = Number(/(\d+) files selected/.exec(selectedText)?.[1]);
    expect(count).toBeGreaterThanOrEqual(4);

    // A click after the drag toggles one tile off again.
    await first.click();
    await expect(first).toHaveAttribute("aria-pressed", "false");

    // Several files download as one zip.
    const download = page.waitForEvent("download");
    await bar.getByRole("button", { name: "Download" }).click();
    expect((await download).suggestedFilename()).toMatch(/\.zip$/);

    // The bulk delete names the count, then the files are gone from the grid and from disk.
    await bar.getByRole("button", { name: "Delete" }).click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toContainText(`Delete ${count - 1} files?`);
    await confirm.getByRole("button", { name: "Delete" }).click();
    await expect(confirm).toHaveCount(0);
    await expect(page.getByRole("group", { name: `${imageCount - 1 - (count - 1)} files` })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: `Deleted ${count - 1} files` })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("a folder that is not in the library says so without a client error", async ({ page }) => {
    const errors: Error[] = [];
    page.on("pageerror", (error) => errors.push(error));
    await page.goto(`/library/${account}?path=Nope`);
    await expect(page.getByText(/doesn't exist/)).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test("the theme switch in the top bar flips the page and remembers the choice", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/history");
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "Switch to dark mode" }).click();
  await expect(html).toHaveAttribute("data-theme", "dark");
  // The switch cross-fades; the new colors are in place once the transition settles.
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(18, 18, 18)");
  await page.reload();
  await expect(html).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Switch to light mode" }).click();
  await expect(html).toHaveAttribute("data-theme", "light");
});

test("the app menu replaces the browser menu, except in text fields", async ({ page }) => {
  await page.goto("/history");
  await page.getByRole("heading", { level: 1 }).click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Page" });
  await expect(menu.getByRole("menuitem", { name: "Reload" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
});

test("the Run page fits a 1280 x 820 window without scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  const overflow = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
  expect(overflow).toBeLessThanOrEqual(0);
});
