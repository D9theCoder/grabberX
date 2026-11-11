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

async function activeRuns(baseUrl) {
  try {
    const health = await getJson(`${baseUrl}/api/health`, 2000);
    return Number(health.activeRuns) || 0;
  } catch {
    return 0;
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

module.exports = {
  findFreePort,
  waitForHealth,
  activeRuns,
  createLog,
  seedGalleryDl,
  isOwnOrigin,
  parseServerMessage,
};
