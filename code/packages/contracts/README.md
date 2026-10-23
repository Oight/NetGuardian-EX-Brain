# S01 · 公共契约

归属 A；公开入口 `@campussec/contracts`，测试在 tests/。src/domains 按十个领域组织原文类型，schemas/limits/canonical/errors 提供校验与规范化。

产品唯一类型/schema 出口在这里；spec 只作对照，业务模块不能复制影子类型。不依赖 Electron、数据库、平台客户端或 Bun 专用 API。契约变化协调所有消费者，并同步类型、schema、向量和失败检查。
