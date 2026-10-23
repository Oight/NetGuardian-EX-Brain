# T002 · A：工程、桌面与调度

状态：in_progress。执行者：Codex；用户授权 A 线及交接修复。唯一实时位置：本文件。分支：task/T002-a-foundation。

- 实际 base 与既有成果提交：64443ed（已在 main，包含 S01/S02/S03 与结构整理）。分工来源 120c81c。
- 允许路径：根 README/AGENTS、根手动 CI、code 根配置/锁、contracts/testkit、scripts、S03 装配、S07；本次交接修复还包括产品/设计导航、任务入口与状态、设计检查脚本。禁止修改 B/C/D 业务实现、renderer 或物理迁移。
- 检查：code/ 下 npm ci --ignore-scripts、npm run check；design_document/ 下两个 Python 检查；根 git diff --check。工具链不满足时明确记录，不按成功放行。
- 外部范围：仅依赖安装所需公开包下载；不运行安装钩子、真实平台/模型或 Electron GUI，不推送。

| 阶段 | 状态 | 依赖与现有依据 | 剩余验收 |
|---|---|---|---|
| A1 | checking | 64443ed 已有 workspace、构建与 S03 入口 | 当前目标环境冻结安装/构建与桌面小验证；未执行 GUI 不算通过 |
| A2 | checking | 64443ed 已有 S01 schema/公开入口 | 当前标准运行时复验类型及错误输入；A1 完整门槛仍未通过 |
| A3 | checking | 64443ed 已有纯 fake、测试和边界脚本 | 修复入口、共享场景及标准运行时检查；线上 CI 未执行 |
| A4 | planned | A3、B1/B2、C2 窄端口 | S07 与真实接线；B2/C2 未实现，不提前交付成功占位 |
| A5 | planned | B3、C4、D3 | 三入口、恢复及真实证据分层验收 |

## 本轮交接

统一根入口与唯一产品任务位置，旧设计四线文件仅转发。旧 Linux/Bun 环境限制恢复为历史范围，不推定当前 Windows 禁止标准 Node。修复设计检查要求已删除工作流的问题；工作流迁到根并适配双目录，仅 workflow_dispatch，不恢复用户已关闭的自动检查。

Node 24.15 / Windows 下严格类型、构建、边界、契约、双锁及 28 个测试通过；无生成物副本冻结安装和同组检查通过。DesktopApi fake 已补齐，存储 fake 按消费者需求仍待补齐。当前结果见[接手验证](../../verification/a-handoff-2026-10-23.md)。现有实现依据为 64443ed；本轮修订提交依据由 Git 历史及后续记录补充；尚未合并 main，checking 不等于 done。A4 依赖不足时先继续 A1—A3 可独立工作。
