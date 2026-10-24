import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
const manifest = JSON.parse(
  await readFile("node_modules/electron/package.json", "utf8"),
);
const executable = resolve(
  `.local/electron-${manifest.version}`,
  process.platform === "win32" ? "electron.exe" : "electron",
);
try {
  await access(executable);
} catch {
  throw new Error(
    "Run npm run prepare:electron first; dependency installation deliberately skips Electron hooks",
  );
}
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawnSync(
  executable,
  [resolve("dist/apps/desktop/main/bootstrap.js"), ...process.argv.slice(2)],
  { stdio: "inherit", env },
);
if (child.error) throw child.error;
process.exit(child.status ?? 1);
