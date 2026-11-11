const path = require("node:path");
const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, shell, utilityProcess } = require("electron");
const lib = require("./lib.cjs");

const repoRoot = path.join(__dirname, "..");
// State and settings live here, never in the install folder, so an update or uninstall cannot touch them.
const home = process.env.GATHER_HOME || path.join(app.getPath("appData"), "gather");
app.setPath("userData", path.join(home, "electron"));

const serverDir = app.isPackaged ? path.join(process.resourcesPath, "server") : path.join(repoRoot, ".next", "standalone");
const seedGalleryDlPath =
  process.env.GATHER_GALLERY_DL_SEED ||
  (app.isPackaged
    ? path.join(process.resourcesPath, "gallery-dl", "gallery-dl.exe")
    : path.join(repoRoot, "build", "gallery-dl", "gallery-dl.exe"));
const galleryDlPath = process.env.GATHER_GALLERY_DL || path.join(home, "bin", "gallery-dl.exe");
const iconPath = path.join(__dirname, "icon.png");

const SHUTDOWN_GRACE_MS = 10000;
const SERVER_START_ATTEMPTS = 3;

let log;
let win = null;
let tray = null;
let server = null;
let serverExited = false;
let origin = null;
let quitting = false;

function pageHtml(title, body) {
  const html = `<!doctype html><meta charset="utf-8"><title>gather</title>
<body style="font:16px system-ui,sans-serif;margin:0;display:grid;place-items:center;height:100vh;background:#fafafa;color:#161616">
<main style="max-width:34rem;padding:2rem"><h1 style="font-size:1.25rem;margin:0 0 .75rem">${title}</h1>${body}</main></body>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: "#fafafa",
    title: "gather",
    icon: iconPath,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.once("ready-to-show", () => win.show());
  win.on("close", async (event) => {
    if (quitting) return;
    event.preventDefault();
    const active = origin ? await lib.activeRuns(origin) : 0;
    if (active > 0) {
      win.hide();
      log.line(`window closed with ${active} active run(s); the app keeps running in the tray`);
      if (tray) tray.displayBalloon?.({ title: "gather", content: "Downloads keep running. Use the tray icon to open or quit." });
    } else {
      app.quit();
    }
  });
  win.on("closed", () => {
    win = null;
  });
}

function guardNavigation() {
  const contents = win.webContents;
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    if (lib.isOwnOrigin(url, origin) || url.startsWith("data:")) return;
    event.preventDefault();
    if (/^https?:/.test(url)) shell.openExternal(url);
  });
}

function startServerProcess(port) {
  const env = {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    GATHER_PACKAGED: "1",
    GATHER_PORT: String(port),
    GATHER_HOME: home,
    GATHER_MEDIA_ROOT: process.env.GATHER_MEDIA_ROOT || path.join(app.getPath("pictures"), "Gather"),
    GATHER_GALLERY_DL: galleryDlPath,
    GATHER_APP_VERSION: app.getVersion(),
    GATHER_APP_DIR: app.isPackaged ? path.dirname(process.execPath) : repoRoot,
  };
  delete env.ELECTRON_RUN_AS_NODE;

  serverExited = false;
  const child = utilityProcess.fork(path.join(serverDir, "server.js"), [], {
    env,
    cwd: serverDir,
    stdio: "pipe",
    serviceName: "gather-server",
  });
  child.stdout?.on("data", (chunk) => log.write(chunk.toString()));
  child.stderr?.on("data", (chunk) => log.write(chunk.toString()));
  child.on("exit", (code) => {
    serverExited = true;
    log.line(`server exited with code ${code}`);
    if (!quitting && win && origin) {
      win.loadURL(pageHtml("gather stopped", `<p>The local server exited unexpectedly (code ${code}).</p><p>Close and reopen gather. Details are in <code>${log.file}</code>.</p>`));
    }
  });
  return child;
}

async function startServer() {
  let lastError;
  for (let attempt = 1; attempt <= SERVER_START_ATTEMPTS; attempt += 1) {
    const port = await lib.findFreePort();
    log.line(`starting the server on port ${port} (attempt ${attempt})`);
    server = startServerProcess(port);
    try {
      await lib.waitForHealth(`http://127.0.0.1:${port}`, { shouldGiveUp: () => serverExited });
      origin = `http://127.0.0.1:${port}`;
      return;
    } catch (error) {
      lastError = error;
      log.line(`the server did not come up: ${error.message}`);
      if (!serverExited) server.kill();
    }
  }
  throw lastError;
}

function stopServer() {
  return new Promise((resolve) => {
    if (!server || serverExited) return resolve();
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      log.line("the server did not stop in time; killing it");
      server.kill();
      done();
    }, SHUTDOWN_GRACE_MS);
    server.once("exit", done);
    server.on("message", (message) => {
      if (message === "shutdown-done") log.line("the server stopped its runs and is exiting");
    });
    server.postMessage("shutdown");
  });
}

async function confirmQuit() {
  const active = origin ? await lib.activeRuns(origin) : 0;
  if (active === 0) return true;
  const { response } = await dialog.showMessageBox({
    type: "warning",
    buttons: ["Stop downloads and quit", "Keep running"],
    defaultId: 1,
    cancelId: 1,
    title: "gather",
    message: `${active} download${active === 1 ? " is" : "s are"} still running.`,
    detail: "Quitting stops them. Files already saved are kept, and the next run continues where it left off.",
  });
  return response === 0;
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(iconPath));
  tray.setToolTip("gather");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open gather", click: showWindow },
      {
        label: "Quit",
        click: async () => {
          if (await confirmQuit()) app.quit();
        },
      },
    ]),
  );
  tray.on("click", showWindow);
}

function setupUpdater() {
  if (!app.isPackaged || process.env.GATHER_NO_UPDATE === "1") return;
  try {
    const { autoUpdater } = require("electron-updater");
    const note = (level) => (message) => log.line(`updater ${level}: ${message}`);
    autoUpdater.logger = { info: note("info"), warn: note("warn"), error: note("error"), debug() {} };
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on("error", (error) => log.line(`updater error: ${error?.message ?? error}`));
    // Without a publish target in the build there is no app-update.yml and this rejects; that is not fatal.
    autoUpdater.checkForUpdates().catch((error) => log.line(`update check skipped: ${error.message}`));
  } catch (error) {
    log.line(`updater unavailable: ${error.message}`);
  }
}

function registerIpc() {
  const fromApp = (event) => origin !== null && lib.isOwnOrigin(event.senderFrame?.url ?? "", origin);

  ipcMain.handle("gather:pick-folder", async (event, defaultPath) => {
    if (!fromApp(event)) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ["openDirectory", "createDirectory"],
      defaultPath: typeof defaultPath === "string" && defaultPath ? defaultPath : undefined,
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle("gather:open-logs", async (event) => {
    if (!fromApp(event)) return;
    await shell.openPath(path.dirname(log.file));
  });
}

async function boot() {
  Menu.setApplicationMenu(null);
  log = lib.createLog(path.join(home, "logs"));
  log.line(`gather ${app.getVersion()} starting (packaged=${app.isPackaged}, home=${home})`);

  const seeded = lib.seedGalleryDl(seedGalleryDlPath, galleryDlPath);
  log.line(`gallery-dl seed: ${seeded} (${galleryDlPath})`);

  registerIpc();
  createWindow();
  win.loadURL(pageHtml("Starting gather…", "<p>Just a moment.</p>"));

  try {
    await startServer();
  } catch (error) {
    log.line(`could not start: ${error.message}`);
    if (win) await win.loadURL(pageHtml("gather could not start", `<p>${error.message}</p><p>Details are in <code>${log.file}</code>.</p>`));
    return;
  }

  guardNavigation();
  createTray();
  setupUpdater();
  if (win) await win.loadURL(origin);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.on("window-all-closed", () => {
    // Closing the last window quits through the "close" handler above; with a hidden window the tray keeps the app alive.
  });
  app.on("before-quit", (event) => {
    if (quitting) return;
    quitting = true;
    if (!server || serverExited) return;
    event.preventDefault();
    stopServer().finally(() => app.quit());
  });
  app.whenReady().then(boot);
}
