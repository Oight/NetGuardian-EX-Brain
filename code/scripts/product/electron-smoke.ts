import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
const manifest = JSON.parse(await readFile("node_modules/electron/package.json", "utf8"));
const overrideIndex = process.argv.indexOf('--electron-dir');
if (overrideIndex >= 0 && !process.argv[overrideIndex + 1])
    throw new Error('Missing --electron-dir path');
const executable = resolve(overrideIndex >= 0 ? process.argv[overrideIndex + 1]! : `.local/electron-${manifest.version}`, process.platform === "win32" ? "electron.exe" : "electron");
await mkdir(".local/electron-acceptance", { recursive: true });
const directory = await mkdtemp(resolve(".local/electron-acceptance/run-"));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
for (const phase of ["write", "reopen"]) {
    const result = spawnSync(executable, [resolve("scripts/electron/foundation-smoke.cjs"), phase, directory], {
        cwd: process.cwd(),
        env,
        stdio: "inherit",
        windowsHide: true,
        timeout: 90000,
    });
    if (result.error)
        throw result.error;
    assert.equal(result.status, 0, `Electron ${phase} acceptance failed`);
    const report = JSON.parse(await readFile(join(directory, `${phase}.json`), "utf8"));
    assert.equal(report.versions.electron, manifest.version);
    for (const check of [
        "realWindow",
        "sandboxedPreload",
        "ipc",
        "sqlite",
        "tray",
        "osProtection",
        "controlledShutdown",
        "cases",
        "revisionConflict",
        "rendererCaseWorkflow",
        "requestLifecycle",
    ])
        assert.equal(report[check], true);
    if (phase === "reopen") {
        assert.equal(report.restartRead, true);
        assert.equal(report.caseRestartRead, true);
    }
    console.log(`PASS: Electron ${phase}; ${JSON.stringify(report.versions)}; real production bootstrap, preload, SQLite, IPC, tray and OS protection.`);
}
console.log("PASS: two real Electron processes completed cleanly; isolated synthetic data remains under ignored .local/electron-acceptance.");
