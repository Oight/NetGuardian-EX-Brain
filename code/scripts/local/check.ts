import { spawnSync } from "node:child_process";
if (!process.versions.bun)
    throw new Error("本机检查仅允许 Bun 执行");
const commands = [
    ["node_modules/typescript/bin/tsc", "--noEmit"],
    ["scripts/product/check-boundaries.ts"],
    ["scripts/product/verify-foundation.ts"],
    ["scripts/product/export-npm-lock.ts", "--check"],
    ["scripts/product/build.ts"],
    ["scripts/product/verify-renderer.ts"],
    ["scripts/product/test.ts"],
    ["node_modules/typescript/bin/tsc", "-p", "tsconfig.test.json"],
];
for (const args of commands) {
    const result = spawnSync(process.execPath, args, { stdio: "inherit" });
    if (result.status !== 0)
        process.exit(result.status ?? 1);
}
console.log("PASS: Bun-only checks. Node.js, Electron, Windows and installer validation remain unexecuted.");
