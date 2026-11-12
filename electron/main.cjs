const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, Menu, Notification, Tray, dialog, ipcMain, nativeImage, nativeTheme, shell, utilityProcess } = require("electron");
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
// gather lives in the tray for days; a check at start alone would miss every release after it.
const UPDATE_CHECK_MS = 6 * 60 * 60 * 1000;
// A downloaded update that had to wait (the user was busy) is looked at again this often.
const UPDATE_RETRY_MS = 5 * 60 * 1000;
// The installer restarts gather; a marker this fresh means "come back in the tray, not as a window".
const START_HIDDEN_MS = 10 * 60 * 1000;
const bootedAt = Date.now();

let log;
let win = null;
let tray = null;
let server = null;
let serverExited = false;
let origin = null;
let quitting = false;
let trayHintShown = false;
let updater = null;
let updateState = { state: "idle" };
/** Set when the tray asked for the check, so its result comes back as a balloon. */
let trayCheckPending = false;
let updateNotice = null;
let updateNoticeVersion = "";
/** Windows drops a notification whose object is garbage-collected before it is clicked. */
let scheduledNotice = null;

function pageHtml(title, body) {
  const html = `<!doctype html><meta charset="utf-8"><title>gather</title>
<body style="font:16px system-ui,sans-serif;margin:0;display:grid;place-items:center;height:100vh;background:#fafafa;color:#161616">
<main style="max-width:34rem;padding:2rem"><h1 style="font-size:1.25rem;margin:0 0 .75rem">${title}</h1>${body}</main></body>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, "settings.json"), "utf8"));
  } catch {
    return {};
  }
}

const themeFile = () => path.join(app.getPath("userData"), "theme.txt");
const updateAttemptFile = () => path.join(app.getPath("userData"), "update-attempt.json");
const startHiddenFile = () => path.join(app.getPath("userData"), "start-hidden");

/** True once after an update that was installed while gather sat in the tray. */
function consumeStartHidden() {
  try {
    const age = Date.now() - fs.statSync(startHiddenFile()).mtimeMs;
    fs.rmSync(startHiddenFile(), { force: true });
    return age < START_HIDDEN_MS;
  } catch {
    return false;
  }
}

function readUpdateAttempt() {
  try {
    return JSON.parse(fs.readFileSync(updateAttemptFile(), "utf8"));
  } catch {
    return null;
  }
}

/** The page's last theme, so the window never flashes light before a dark page loads. */
function windowBackground() {
  let theme = "";
  try {
    theme = fs.readFileSync(themeFile(), "utf8").trim();
  } catch {
    /* first run */
  }
  const dark = theme === "dark" || (theme !== "light" && nativeTheme.shouldUseDarkColors);
  return dark ? "#121212" : "#fcfcfc";
}

/** Only a media file inside the library folder, whatever the page asks for. */
function libraryMediaPath(filePath) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) return null;
  if (!/\.(jpe?g|png|webp|gif|mp4|webm|mov|m4v)$/i.test(filePath)) return null;
  const settings = readSettings();
  const rootDir = typeof settings.mediaRoot === "string" ? settings.mediaRoot : process.env.GATHER_MEDIA_ROOT;
  if (!rootDir) return null;
  const target = path.resolve(filePath);
  const inside = path.relative(path.resolve(rootDir), target);
  if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside)) return null;
  return target;
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** The scheduled pass that just finished, as the server described it. Clicking opens History. */
function showScheduledNotice(body) {
  log.line(`automatic updates: ${body}`);
  if (!Notification.isSupported()) return;
  scheduledNotice = new Notification({ title: "gather", body, icon: iconPath });
  scheduledNotice.on("click", () => {
    showWindow();
    if (win && origin) void win.loadURL(`${origin}/history`);
  });
  scheduledNotice.show();
}

function handleServerMessage(message) {
  const event = lib.parseServerMessage(message);
  if (!event) return;
  if (event.kind === "scheduled-pass") showScheduledNotice(event.body);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: windowBackground(),
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
  const startHidden = consumeStartHidden();
  if (startHidden) log.line("updated while in the tray; starting hidden");
  win.once("ready-to-show", () => {
    if (!startHidden) win.show();
  });
  win.on("close", async (event) => {
    if (quitting) return;
    event.preventDefault();
    // Without a tray (the server never started) there is nothing to hide into.
    if (tray && lib.closesToTray(readSettings())) {
      win.hide();
      log.line("window closed; the app keeps running in the tray");
      if (!trayHintShown) {
        trayHintShown = true;
        tray.displayBalloon?.({
          title: "gather",
          content: "gather is still running in the tray, so updates and automatic runs keep working. Change this in Settings.",
        });
      }
      void maybeAutoInstall();
      return;
    }
    if (await confirmQuit()) app.quit();
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
    // Thumbnails, image headers and file reads all share libuv's pool; the default 4 lets a big folder starve page loads.
    UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE || "16",
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
  child.on("message", handleServerMessage);
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
  refreshTrayMenu();
  tray.on("click", showWindow);
}

function refreshTrayMenu() {
  if (!tray) return;
  const updateItem =
    updateState.state === "ready"
      ? { label: `Restart to update to ${updateState.version}`, click: () => void installUpdate() }
      : {
          label: updateState.state === "downloading" ? `Downloading update… ${updateState.percent}%` : "Check for updates",
          enabled: updater !== null && updateState.state !== "checking" && updateState.state !== "downloading",
          click: () => {
            trayCheckPending = true;
            checkForUpdates();
          },
        };
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open gather", click: showWindow },
      updateItem,
      { type: "separator" },
      {
        label: "Quit",
        click: async () => {
          if (await confirmQuit()) app.quit();
        },
      },
    ]),
  );
}

function setUpdateState(next) {
  if (next === updateState) return;
  const changedState = next.state !== updateState.state;
  updateState = next;
  if (win && !win.isDestroyed()) win.webContents.send("gather:update-state", updateState);
  if (changedState) refreshTrayMenu();
  if (trayCheckPending && ["current", "downloading", "error"].includes(next.state)) {
    trayCheckPending = false;
    const content =
      next.state === "current"
        ? `gather ${app.getVersion()} is up to date.`
        : next.state === "downloading"
          ? `gather ${next.version} is downloading. It installs when gather is idle.`
          : `Could not check for updates: ${next.message}`;
    tray?.displayBalloon?.({ title: "gather", content });
  }
}

function checkForUpdates() {
  if (!updater) return updateState;
  if (updateState.state === "checking" || updateState.state === "downloading" || updateState.state === "ready") {
    return updateState;
  }
  setUpdateState({ state: "checking" });
  // Failures arrive through the "error" event as well; this catch only keeps the rejection handled.
  updater.checkForUpdates().catch((error) => {
    log.line(`update check failed: ${error.message}`);
    setUpdateState(lib.nextUpdateState(updateState, "error", error));
  });
  return updateState;
}

/**
 * Installs the downloaded update: stops the server's runs, then runs the installer silently and restarts gather.
 * `automatic` skips the "downloads are still running" question (the caller already checked there are none);
 * `hidden` brings gather back in the tray.
 */
async function installUpdate({ automatic = false, hidden = false } = {}) {
  if (!updater || updateState.state !== "ready" || quitting) return false;
  if (!automatic && !(await confirmQuit())) return false;
  const { version } = updateState;
  log.line(`restarting to install ${version} (${automatic ? (hidden ? "automatic, in the tray" : "automatic, at start") : "asked"})`);
  try {
    fs.writeFileSync(updateAttemptFile(), JSON.stringify({ version, at: new Date().toISOString() }));
    if (hidden) fs.writeFileSync(startHiddenFile(), version);
  } catch (error) {
    log.line(`could not record the update attempt: ${error.message}`);
  }
  quitting = true;
  if (win && !win.isDestroyed() && win.isVisible()) {
    await win.loadURL(pageHtml(`Updating gather to ${version}…`, "<p>gather restarts by itself in a moment.</p>")).catch(() => {});
  }
  await stopServer();
  updater.quitAndInstall(true, true);
  return true;
}

function showUpdateNotice(version) {
  if (updateNoticeVersion === version || !Notification.isSupported()) return;
  updateNoticeVersion = version;
  updateNotice = new Notification({ title: "gather", body: `gather ${version} is ready. Click to restart and update.`, icon: iconPath });
  updateNotice.on("click", () => {
    showWindow();
    void installUpdate();
  });
  updateNotice.show();
}

/** Installs a downloaded update when nobody is using gather; otherwise asks once with a notification. */
async function maybeAutoInstall() {
  if (updateState.state !== "ready" || quitting) return;
  const { version } = updateState;
  const activeRuns = origin ? await lib.activeRuns(origin) : 0;
  if (updateState.state !== "ready" || quitting) return;
  const decision = lib.autoInstallDecision({
    version,
    sinceBootMs: Date.now() - bootedAt,
    windowVisible: Boolean(win && !win.isDestroyed() && win.isVisible()),
    activeRuns,
    lastAttempt: readUpdateAttempt(),
    now: Date.now(),
  });
  if (decision === "visible" || decision === "hidden") {
    await installUpdate({ automatic: true, hidden: decision === "hidden" });
    return;
  }
  if (decision === "blocked" && updateNoticeVersion !== version) {
    log.line(`installing ${version} was already tried and gather is still on ${app.getVersion()}; waiting for the user`);
  }
  showUpdateNotice(version);
}

function setupUpdater() {
  if (!app.isPackaged || process.env.GATHER_NO_UPDATE === "1") {
    updateState = { state: "unavailable" };
    return;
  }
  try {
    const { autoUpdater } = require("electron-updater");
    const note = (level) => (message) => log.line(`updater ${level}: ${message}`);
    autoUpdater.logger = { info: note("info"), warn: note("warn"), error: note("error"), debug() {} };
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.disableWebInstaller = true;
    for (const event of ["checking-for-update", "update-not-available", "update-available", "download-progress", "update-downloaded"]) {
      autoUpdater.on(event, (payload) => setUpdateState(lib.nextUpdateState(updateState, event, payload)));
    }
    autoUpdater.on("update-downloaded", () => void maybeAutoInstall());
    autoUpdater.on("error", (error) => {
      log.line(`updater error: ${error?.message ?? error}`);
      setUpdateState(lib.nextUpdateState(updateState, "error", error));
    });
    updater = autoUpdater;
    refreshTrayMenu();
    // Without a publish target in the build there is no app-update.yml and this fails; that is not fatal.
    checkForUpdates();
    setInterval(checkForUpdates, UPDATE_CHECK_MS).unref();
    setInterval(() => void maybeAutoInstall(), UPDATE_RETRY_MS).unref();
  } catch (error) {
    updateState = { state: "unavailable" };
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

  ipcMain.handle("gather:trash-item", async (event, filePath) => {
    const target = fromApp(event) ? libraryMediaPath(filePath) : null;
    if (!target) return false;
    try {
      await shell.trashItem(target);
      return true;
    } catch (error) {
      log.line(`could not move a file to the Recycle Bin: ${error.message}`);
      return false;
    }
  });

  ipcMain.handle("gather:show-item", (event, filePath) => {
    const target = fromApp(event) ? libraryMediaPath(filePath) : null;
    if (!target) return false;
    shell.showItemInFolder(target);
    return true;
  });

  ipcMain.handle("gather:open-item", async (event, filePath) => {
    const target = fromApp(event) ? libraryMediaPath(filePath) : null;
    if (!target) return false;
    // openPath resolves to an error message, empty on success.
    return (await shell.openPath(target)) === "";
  });

  ipcMain.handle("gather:update-state", (event) => (fromApp(event) ? updateState : null));

  ipcMain.handle("gather:check-update", (event) => (fromApp(event) ? checkForUpdates() : null));

  ipcMain.handle("gather:install-update", (event) => (fromApp(event) ? installUpdate() : false));

  ipcMain.handle("gather:set-theme", (event, theme) => {
    if (!fromApp(event) || (theme !== "light" && theme !== "dark")) return;
    if (win) win.setBackgroundColor(theme === "dark" ? "#121212" : "#fcfcfc");
    try {
      fs.writeFileSync(themeFile(), theme);
    } catch {
      /* only a startup color */
    }
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
