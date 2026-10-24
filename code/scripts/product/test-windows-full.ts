import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  windowsTestPlan,
  executeWindowsTestPlan,
} from "./windows-test-plan.ts";

const environment = {
  platform: process.platform,
  runtime: process.versions.bun
    ? ("bun" as const)
    : process.versions.electron
      ? ("electron" as const)
      : ("node" as const),
  nodeVersion: process.versions.node,
  npmVersion: process.env.npm_config_user_agent?.match(/^npm\/([0-9.]+)/)?.[1],
};
// The guard runs before installation, downloads, process spawning or any data writes.
const stages = windowsTestPlan(environment);
const npmCli = process.env.npm_execpath;
if (!npmCli)
  throw new Error(
    "请通过 npm run test:windows:full 启动，以使用当前已固定版本的 npm CLI。",
  );
const root = fileURLToPath(new URL("../../", import.meta.url));
await mkdir(join(root, ".local/windows-full"), { recursive: true });
const directory = await mkdtemp(join(root, ".local/windows-full/run-"));
const startedAt = new Date().toISOString();
const results = executeWindowsTestPlan(stages, (stage) => {
  console.log(`\n[${stage.id}] ${stage.label}`);
  // Invoking the npm JS entry with the current Node avoids Windows .cmd shell quoting.
  const result = spawnSync(process.execPath, [npmCli, ...stage.args], {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
    env: { ...process.env, npm_config_ignore_scripts: "true" },
  });
  if (result.error || result.signal) return 1;
  return result.status ?? 1;
});
const passed = results.every((stage) => stage.status === "passed");
const report = {
  startedAt,
  completedAt: new Date().toISOString(),
  environment: { ...environment, arch: process.arch },
  status: passed ? "passed" : "failed",
  stages: results,
  scope: "当前已实现产品的完整自动化检查和真实 Electron 验收",
  notCovered: [
    "完整安装包/签名/安装卸载（尚无打包入口）",
    "真实 Wazuh、TeleAgent、模型、MCP 与回传（需要独立授权和对应模块）",
  ],
};
const path = join(directory, "report.json");
await writeFile(path, JSON.stringify(report, null, 2) + "\n");
console.log(
  `\n${passed ? "PASS" : "FAIL"}: Windows 全量自动化验收。报告：${path}`,
);
for (const stage of results) console.log(`${stage.status}: ${stage.id}`);
console.log("安装包和真实平台联调不计为本命令通过。");
process.exitCode = passed ? 0 : 1;
