// Helpers for main.cjs that do not need Electron, so vitest can run them.
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

/** Asks the OS for a free loopback port. Another process could grab it before the server does, so callers retry. */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function getJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => {
        if (response.statusCode !== 200) return reject(new Error(`HTTP ${response.statusCode}`));
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", reject);
  });
}

/** Polls /api/health until it answers. `shouldGiveUp` lets the caller stop early when the server process died. */
async function waitForHealth(baseUrl, { timeoutMs = 60000, intervalMs = 250, shouldGiveUp = () => false } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = new Error("not started");
  while (Date.now() < deadline) {
    if (shouldGiveUp()) throw new Error("The server stopped before it was ready.");
    try {
      return await getJson(`${baseUrl}/api/health`, 2000);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`The server did not answer within ${Math.round(timeoutMs / 1000)}s (${lastError.message}).`);
}

/** The number of running downloads, or null when the server did not answer (busy or down), which means "unknown". */
async function activeRuns(baseUrl) {
  try {
    const health = await getJson(`${baseUrl}/api/health`, 2000);
    return Number(health.activeRuns) || 0;
  } catch {
    return null;
  }
}

/** Appends to `<dir>/gather.log` and keeps one older file, so logs never grow without bound. */
function createLog(dir, maxBytes = 1024 * 1024) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "gather.log");
  const rotate = () => {
    try {
      if (fs.statSync(file).size >= maxBytes) fs.renameSync(file, path.join(dir, "gather.1.log"));
    } catch {
      /* no log yet */
    }
  };
  rotate();
  let written = 0;
  return {
    file,
    write(text) {
      try {
        fs.appendFileSync(file, text);
        written += Buffer.byteLength(text);
        if (written >= maxBytes) {
          written = 0;
          rotate();
        }
      } catch {
        /* logging must never take the app down */
      }
    },
    line(message) {
      this.write(`${new Date().toISOString()} [shell] ${message}\n`);
    },
  };
}

/** Copies the bundled gallery-dl next to the user's state on first run; never overwrites an updated copy. */
function seedGalleryDl(seedPath, targetPath) {
  if (fs.existsSync(targetPath)) return "present";
  if (!fs.existsSync(seedPath)) return "no-seed";
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(seedPath, targetPath);
  return "copied";
}

/** True when `url` is on the app's own origin; everything else opens in the user's browser. */
function isOwnOrigin(url, origin) {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/**
 * A message the server sends up from the utility process. Only the finished scheduled pass is used,
 * and anything else (a shutdown reply, a malformed payload) is ignored rather than shown.
 */
function parseServerMessage(message) {
  if (!message || typeof message !== "object") return null;
  if (message.kind !== "scheduled-pass") return null;
  const body = typeof message.body === "string" ? message.body.trim() : "";
  if (!body) return null;
  return { kind: "scheduled-pass", body: body.slice(0, 300) };
}

/** Closing the window hides grabberX in the tray unless the user turned that off in Settings. */
function closesToTray(settings) {
  return !(settings && typeof settings === "object" && settings.closeToTray === false);
}

/**
 * The updater's state as the page and the tray show it, from one electron-updater event.
 * States: idle, checking, current, downloading, ready, error, unavailable.
 */
function nextUpdateState(previous, event, payload) {
  const now = new Date().toISOString();
  switch (event) {
    case "checking-for-update":
      // A check while a download runs or waits must not hide it.
      return previous.state === "downloading" || previous.state === "ready" ? previous : { state: "checking" };
    case "update-not-available":
      return { state: "current", checkedAt: now };
    case "update-available":
      return { state: "downloading", version: String(payload?.version ?? ""), percent: 0 };
    case "download-progress": {
      const percent = Math.max(0, Math.min(100, Math.floor(Number(payload?.percent) || 0)));
      if (previous.state === "downloading" && previous.percent === percent) return previous;
      return { state: "downloading", version: previous.version ?? "", percent };
    }
    case "update-downloaded":
      return { state: "ready", version: String(payload?.version ?? previous.version ?? "") };
    case "error": {
      if (previous.state === "ready") return previous;
      const message = String(payload?.message ?? payload ?? "Unknown error").split(/\r?\n/)[0].slice(0, 200);
      return { state: "error", message, checkedAt: now };
    }
    default:
      return previous;
  }
}

/** How long after launch a downloaded update still counts as "found at start". */
const STARTUP_INSTALL_MS = 2 * 60 * 1000;
/** A failed silent install must not turn every launch into another install. */
const RETRY_INSTALL_MS = 6 * 60 * 60 * 1000;

/**
 * Whether to install a downloaded update now, without the user pressing anything.
 * - "visible": right after launch, before the user has started any work, restart into the new version.
 * - "hidden": the window is hidden in the tray, so restart quietly and stay in the tray.
 * - "wait": the user is using the app or a download runs; ask with a notification instead.
 * - "blocked": the same version was already tried recently, so the silent install failed; ask instead.
 */
function autoInstallDecision({ version, sinceBootMs, windowVisible, activeRuns, lastAttempt, now }) {
  // A server too busy to answer may be running downloads; installing would kill them.
  if (activeRuns === null || activeRuns > 0) return "wait";
  if (lastAttempt && lastAttempt.version === version && now - Date.parse(lastAttempt.at) < RETRY_INSTALL_MS) {
    return "blocked";
  }
  if (!windowVisible) return "hidden";
  if (sinceBootMs < STARTUP_INSTALL_MS) return "visible";
  return "wait";
}

module.exports = {
  autoInstallDecision,
  closesToTray,
  nextUpdateState,
  findFreePort,
  waitForHealth,
  activeRuns,
  createLog,
  seedGalleryDl,
  isOwnOrigin,
  parseServerMessage,
};
