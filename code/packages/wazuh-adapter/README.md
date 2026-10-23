# S04 · Wazuh 适配

C 负责，尚未实现。维护认证、映射、受限查询、分页、能力和新鲜度；Wazuh 是冻结首个上游，不部署/改造或扩选型。

Indexer/Server 认证隔离，严格 TLS 与字段白名单；区分零匹配、403 和 partial。模块 tests/ 用公共 HTTP fake，不要求真实凭据。
