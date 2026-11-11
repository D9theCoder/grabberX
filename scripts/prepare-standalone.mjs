// Copies the assets `next build` leaves out of .next/standalone, so server.js can serve them itself.
import { cp, mkdir, stat } from "node:fs/promises";
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

await mkdir(join(standalone, ".next"), { recursive: true });
await cp(join(root, ".next", "static"), join(standalone, ".next", "static"), { recursive: true });
if (await exists(join(root, "public"))) {
  await cp(join(root, "public"), join(standalone, "public"), { recursive: true });
}
console.log("Standalone output ready in .next/standalone");
