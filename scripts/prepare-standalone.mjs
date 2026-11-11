// Copies the assets `next build` leaves out of .next/standalone, so server.js can serve them itself.
import { cp, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const standalone = join(root, ".next", "standalone");

async function exists(path) {
  return stat(path).then(() => true, () => false);
}

if (!(await exists(join(standalone, "server.js")))) {
  console.error("No .next/standalone/server.js. Run `next build` first.");
  process.exit(1);
}

// The tracer can pull these in (instrumentation.ts, or a build that ran the queue in the project folder).
// .gather holds run history and must never reach an installer; the rest is source the server does not read.
for (const folder of [".gather", "src", "docs", "e2e", "scripts", "electron", "build", "release"]) {
  await rm(join(standalone, folder), { recursive: true, force: true });
}

await mkdir(join(standalone, ".next"), { recursive: true });
await cp(join(root, ".next", "static"), join(standalone, ".next", "static"), { recursive: true });
if (await exists(join(root, "public"))) {
  await cp(join(root, "public"), join(standalone, "public"), { recursive: true });
}
console.log("Standalone output ready in .next/standalone");
