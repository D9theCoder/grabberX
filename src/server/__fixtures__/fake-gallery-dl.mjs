// Stand-in for gallery-dl.exe in integration tests: same stdout/stderr shapes, no network.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const modeArg = args.find((arg) => arg.startsWith("--mode="));
const mode = modeArg ? modeArg.slice("--mode=".length) : "lines";

const out = (line) => process.stdout.write(`${line}\n`);
const err = (line) => process.stderr.write(`${line}\n`);
const sleepForever = () => {
  setInterval(() => {}, 1000);
};

const sample = () => {
  out("https://x.com/username/media");
  out("/media/username/Image/1834220145_1.jpg");
  out("# /media/username/Image/1834220145_2.jpg");
  err("[twitter][warning] 1834220146_1.jpg already exists");
};

if (mode === "lines") {
  sample();
  process.exitCode = 0;
} else if (mode === "fail") {
  out("/media/username/Image/1834220145_1.jpg");
  err("[twitter][error] Not found: https://x.com/username/media");
  process.exitCode = 1;
} else if (mode === "sleep") {
  sample();
  sleepForever();
} else if (mode === "tree") {
  sample();
  const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
    shell: false,
    stdio: "ignore",
    windowsHide: true,
  });
  const pidFile = process.env.FAKE_PID_FILE;
  if (pidFile) {
    writeFileSync(pidFile, `${process.pid} ${grandchild.pid ?? 0}\n`, "utf8");
  }
  sleepForever();
} else if (mode === "probe") {
  out(JSON.stringify([[2, { user: { media_count: 321 } }]]));
  process.exitCode = 0;
} else {
  err(`unknown mode ${mode}`);
  process.exitCode = 9;
}
