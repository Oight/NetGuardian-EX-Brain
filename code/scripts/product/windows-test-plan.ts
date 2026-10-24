export interface WindowsTestEnvironment {
  platform: string;
  runtime: 'node' | 'bun' | 'electron';
  nodeVersion: string;
  npmVersion?: string;
}
export interface WindowsTestStage { id: string; label: string; args: string[] }
export interface WindowsTestResult { id: string; label: string; status: 'passed' | 'failed' | 'skipped'; exitCode?: number; durationMs?: number }
export function windowsTestPlan(environment: WindowsTestEnvironment): WindowsTestStage[] {
  if (environment.platform !== 'win32' || environment.runtime !== 'node') throw new Error('Windows 全量验收必须由 Windows 上的 Node.js 执行；本机 Bun 不运行此入口。');
  const [major, minor] = environment.nodeVersion.split('.').map(Number);
  if (major !== 24 || !Number.isInteger(minor) || minor === undefined || minor < 15) throw new Error('需要 Node.js >=24.15 <25；建议使用 .node-version 固定的 24.15.0。');
  if (environment.npmVersion !== '11.12.1') throw new Error('请使用 npm 11.12.1，通过 npm run test:windows:full 启动。');
  return [
    { id: 'environment', label: 'Node/npm 版本检查', args: ['run', 'check:environment'] },
    { id: 'install', label: '冻结 npm 安装（禁用全部生命周期脚本）', args: ['ci', '--ignore-scripts', '--cache', '.cache/npm', '--no-audit', '--no-fund'] },
    { id: 'product', label: '严格类型、构建、架构、契约、锁和全部产品测试', args: ['run', 'check'] },
    { id: 'clean', label: '无 dist/依赖的干净副本离线复验', args: ['run', 'check:clean'] },
    { id: 'electron-binary', label: '官方 Electron 下载、SHA256 核实和解压', args: ['run', 'prepare:electron'] },
    { id: 'electron', label: '真实 Electron 双进程、窗口、沙箱、IPC、案件重启回读和系统保护', args: ['run', 'test:electron'] },
  ];
}
/** Stops on the first failure; unexecuted stages never become passing results. */
export function executeWindowsTestPlan(stages: WindowsTestStage[], run: (stage: WindowsTestStage) => number, now = () => Date.now()): WindowsTestResult[] {
  let failed = false;
  return stages.map(stage => {
    if (failed) return { id: stage.id, label: stage.label, status: 'skipped' };
    const started = now();
    let exitCode: number;
    try { exitCode = run(stage); } catch { exitCode = 1; }
    if (!Number.isInteger(exitCode) || exitCode < 0) exitCode = 1;
    failed = exitCode !== 0;
    return { id: stage.id, label: stage.label, status: failed ? 'failed' : 'passed', exitCode, durationMs: Math.max(0, now() - started) };
  });
}
