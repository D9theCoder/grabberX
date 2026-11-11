// Downloads the pinned standalone gallery-dl.exe that the installer ships as a first-run seed.
// The exe is not committed (22 MB, replaced often). The app updates its own copy with `gallery-dl --update`,
// so this pin only decides what a fresh install starts from.
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const BUILD_TAG = "2026.11.11";
const ASSET = "gallery-dl_windows.exe";
const SHA256 = "56d0bf2c457ccb69e7c32457a2fb17497413651a69b7a884072b02a88152b6ec";
const LICENSE_URL = "https://raw.githubusercontent.com/mikf/gallery-dl/master/LICENSE";

const root = process.cwd();
const outDir = join(root, "build", "gallery-dl");
const exePath = join(outDir, "gallery-dl.exe");

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function exists(path) {
  return stat(path).then(() => true, () => false);
}

async function download(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

await mkdir(outDir, { recursive: true });

if (!(await exists(exePath)) || sha256(await readFile(exePath)) !== SHA256) {
  const local = process.env.GATHER_GALLERY_DL_SEED;
  const exe = local
    ? await readFile(local)
    : await download(`https://github.com/gdl-org/builds/releases/download/${BUILD_TAG}/${ASSET}`);
  if (sha256(exe) !== SHA256) {
    throw new Error(`gallery-dl.exe does not match the pinned SHA-256 for ${BUILD_TAG}. Refusing to ship it.`);
  }
  await writeFile(exePath, exe);
  console.log(`gallery-dl ${BUILD_TAG} saved to build/gallery-dl/gallery-dl.exe`);
} else {
  console.log("gallery-dl seed already present and verified");
}

const licensePath = join(outDir, "LICENSE-gallery-dl.txt");
if (!(await exists(licensePath))) {
  await writeFile(licensePath, await download(LICENSE_URL));
}
await copyFile(licensePath, join(outDir, "LICENSE.txt"));
