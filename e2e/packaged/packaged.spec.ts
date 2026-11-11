import { createServer, request } from "node:http";
import type { Server } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";

// 1x1 transparent PNG, served by a local server so the real gallery-dl.exe downloads something without the internet.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const executablePath = process.env.GATHER_EXE;

let sandbox = "";
let app: ElectronApplication;
let page: Page;
let origin = "";
let imageServer: Server;
let imageUrl = "";
const pageErrors: Error[] = [];

async function filesUnder(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await filesUnder(path)));
    else found.push(path);
  }
  return found;
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "gather-packaged-"));
  imageServer = createServer((_request, response) => {
    response.setHeader("content-type", "image/png");
    response.end(PNG);
  });
  await new Promise<void>((resolve) => imageServer.listen(0, "127.0.0.1", resolve));
  const address = imageServer.address();
  imageUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/sample.png`;

  const env = {
    ...(process.env as Record<string, string>),
    GATHER_HOME: join(sandbox, "home"),
    GATHER_MEDIA_ROOT: join(sandbox, "library"),
    GATHER_NO_UPDATE: "1",
  };
  app = await electron.launch(executablePath ? { executablePath, env } : { args: ["electron/main.cjs"], env });
  page = await app.firstWindow();
  page.on("pageerror", (error) => pageErrors.push(error));
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 120_000 });
  origin = new URL(page.url()).origin;
});

test.afterAll(async () => {
  await app?.close().catch(() => {});
  await new Promise((resolve) => imageServer?.close(resolve));
  // KEEP_SANDBOX=1 leaves the temp home (with logs/gather.log) behind for debugging a failure.
  if (process.env.KEEP_SANDBOX !== "1") await rm(sandbox, { recursive: true, force: true }).catch(() => {});
  else console.log(`sandbox kept at ${sandbox}`);
});

test("a new install lands on the welcome screen with gallery-dl found", async () => {
  await expect(page.getByRole("heading", { level: 1, name: "Welcome to gather" })).toBeVisible();
  await expect(page.getByText(/Found gallery-dl/)).toBeVisible();
  expect(await page.evaluate(() => typeof window.gatherShell?.pickFolder)).toBe("function");
});

test("finishing setup creates the library folder and settings", async () => {
  await expect(page.getByLabel("Library folder")).toHaveValue(join(sandbox, "library"));
  await page.getByRole("button", { name: "Get started" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Run" })).toBeVisible();

  const settings = JSON.parse(await readFile(join(sandbox, "home", "settings.json"), "utf8"));
  expect(settings.mediaRoot).toBe(join(sandbox, "library"));
  expect(settings.galleryDlPath).toBe(join(sandbox, "home", "bin", "gallery-dl.exe"));
  expect((await stat(join(sandbox, "library"))).isDirectory()).toBe(true);
  expect(existsSync(join(sandbox, "home", "bin", "gallery-dl.exe"))).toBe(true);
});

test("every page renders without a client error", async () => {
  for (const [path, heading] of [
    ["/", "Run"],
    ["/library", "Library"],
    ["/history", "History"],
    ["/settings", "Settings"],
  ] as const) {
    await page.goto(`${origin}${path}`);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    await expect(page.locator("html#__next_error__")).toHaveCount(0);
  }
  expect(pageErrors).toEqual([]);
});

test("the server refuses a request for another host", async () => {
  // fetch() ignores a custom Host header, so this uses http.request.
  const status = await new Promise<number>((resolve, reject) => {
    const outgoing = request(origin, { headers: { host: "evil.example" } }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
  expect(status).toBe(403);
});

test("Settings shows the app version and the gallery-dl copy in the user's folder", async () => {
  await page.goto(`${origin}/settings`);
  await expect(page.getByText(/^gather \d+\.\d+\.\d+/)).toBeVisible();
  await expect(page.getByLabel("gallery-dl path")).toHaveValue(join(sandbox, "home", "bin", "gallery-dl.exe"));
  await page.getByRole("button", { name: "Check", exact: true }).click();
  await expect(page.getByText(/Found gallery-dl/)).toBeVisible();
});

test("Browse saves the picked folder and refuses one inside the app's own state", async () => {
  const picked = join(sandbox, "other-library");
  await mkdir(picked, { recursive: true });
  const savedRoot = async () => JSON.parse(await readFile(join(sandbox, "home", "settings.json"), "utf8")).mediaRoot;

  await page.goto(`${origin}/settings`);
  const pickNext = (folder: string) =>
    app.evaluate(({ dialog }, folderPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folderPath] });
    }, folder);

  await pickNext(join(sandbox, "home"));
  await page.getByRole("button", { name: "Browse…" }).click();
  await expect(page.getByText(/can't be inside the app's own folder/)).toBeVisible();
  expect(await savedRoot()).toBe(join(sandbox, "library"));

  await pickNext(picked);
  await page.getByRole("button", { name: "Browse…" }).click();
  await expect.poll(savedRoot).toBe(picked);

  // Put it back: the download test below expects files in the original library.
  await pickNext(join(sandbox, "library"));
  await page.getByRole("button", { name: "Browse…" }).click();
  await expect.poll(savedRoot).toBe(join(sandbox, "library"));
});

test("a download runs end to end with the bundled gallery-dl", async () => {
  await page.goto(origin);
  await page.getByRole("radio", { name: /Other URL/ }).click();
  await page.getByLabel("Page URL").fill(imageUrl);
  await page.getByRole("button", { name: "Download" }).click();

  await expect
    .poll(async () => (await filesUnder(join(sandbox, "library"))).filter((file) => file.endsWith(".png")).length, {
      timeout: 90_000,
    })
    .toBeGreaterThan(0);
  const files = await filesUnder(join(sandbox, "library"));
  expect(files.some((file) => file.endsWith("archive.sqlite3"))).toBe(true);
});

test("automatic updates run a pass that History marks as scheduled", async () => {
  await page.goto(`${origin}/settings`);
  const toggle = page.getByRole("switch", { name: "Automatic updates" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");

  // The app has planned the next pass for tonight. Move that moment into the past, the way a pass
  // missed while gather was closed looks, then save the same frequency so it replans at once
  // instead of waiting for its heartbeat.
  const settings = JSON.parse(await readFile(join(sandbox, "home", "settings.json"), "utf8"));
  const { enabled, frequency } = settings.schedule;
  expect(enabled).toBe(true);
  const key =
    frequency.kind === "daily" ? `daily:${frequency.time}` : `every:${frequency.hours}`;
  await writeFile(
    join(sandbox, "home", "schedule.json"),
    JSON.stringify({ nextDueAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), frequency: key }),
    "utf8",
  );
  await page.getByRole("radio", { name: "Every day" }).click();

  // History is a snapshot, and the pass starts after a short launch-style delay, so reload until the
  // run it queued has finished.
  await page.goto(`${origin}/history`);
  const scheduledRow = page.getByRole("row").filter({ hasText: "Scheduled" });
  await expect
    .poll(
      async () => {
        await page.reload();
        return scheduledRow.filter({ hasText: "Done" }).count();
      },
      { timeout: 120_000, intervals: [2_000] },
    )
    .toBeGreaterThan(0);
  await expect(scheduledRow.first()).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("quitting leaves no server running", async () => {
  await app.close();
  await expect
    .poll(async () => fetch(`${origin}/api/health`).then(() => "up", () => "down"), { timeout: 20_000 })
    .toBe("down");
  const log = await readFile(join(sandbox, "home", "logs", "gather.log"), "utf8");
  expect(log).toContain("starting the server");
  expect(log).toMatch(/server exited with code 0/);
});
