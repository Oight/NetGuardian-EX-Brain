# S06 · 案件与证据

B 负责，尚未实现。此处承载案件、revision/CAS、背景、不可变证据、查询覆盖、投影、封存和清理原语；自有 tests/ 跟随本目录。

只通过 CaseService/CaseAtomicPort 暴露服务，不回调 S07 预算或 S09 MCP。根 tests/support 的 seedCase 是合成预置数据，不是本模块实现。
