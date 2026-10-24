# S01 · 公共契约

归属 A；公开入口 `@campussec/contracts`，测试在 tests/。src/domains 按十个领域组织原文类型，schemas/limits/canonical/errors 提供校验与规范化。

产品唯一类型/schema 出口在这里；spec 只作对照，业务模块不能复制影子类型。不依赖 Electron、数据库、平台客户端或 Bun 专用 API。契约变化协调所有消费者，并同步类型、schema、向量和失败检查。

外部入口：parseRpcRequest、parseRpcResponse（方法/请求 ID 关联）、parseToolInvocation、parseEvidenceToolEnvelope、parseControlToolEnvelope、parseResultPackage。严格拒绝未知字段、非法枚举和错误信封版本。公开原文声明仍与 0.2.0 快照一致，冻结契约不变，4 个增量方法由独立维护附件定义。47 个 Desktop 方法均有合法往返与非法字段测试；这些证明结构边界，不证明业务语义或调查质量。
