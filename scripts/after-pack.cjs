// electron-builder never copies a node_modules folder through extraResources, and the standalone Next
// server needs its own. This runs after packing, for both the unpacked folder and the installer.
const fs = require("node:fs");
const path = require("node:path");

exports.default = async function afterPack(context) {
  const from = path.join(context.packager.projectDir, ".next", "standalone", "node_modules");
  const to = path.join(context.appOutDir, "resources", "server", "node_modules");
  if (!fs.existsSync(from)) throw new Error(`${from} is missing. Run \`next build\` and scripts/prepare-standalone.mjs first.`);
  // dereference: a Windows build can leave junctions here, which break once the folder is moved.
  fs.cpSync(from, to, { recursive: true, dereference: true });
  console.log(`  • copied the server's node_modules  to=${path.relative(context.packager.projectDir, to)}`);
};
