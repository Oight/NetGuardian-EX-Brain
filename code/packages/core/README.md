# 本地业务核心

本目录按业务所有权组织，当前入口包含 cases、reports、alerts、requests、delivery、investigations/tools、investigations/retention 与 investigations/publication。公开出口见 package.json，生产接线见 apps/desktop/runtime/compose.ts。

S07 唯一决定任务终态；跨模块写入经过同步 InTx 端口。模块实现、生产装配合成检查与真实接入验收分开记录，见[全项目核验](../../docs/verification/project-audit-2026-10-24.md)。
