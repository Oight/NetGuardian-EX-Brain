# S04 · Wazuh 只读适配

C 线实现；公开入口 `@campussec/wazuh-adapter` 导出 `createWazuhAdapter({db,secrets,clock,ids,http?}): ConnectionService`。构造不联网；未注入 HTTP 时使用严格 HTTPS 实现，测试必须显式注入 fake。

已实现连接保存/generation CAS、两侧秘密隔离、Server JWT single-flight 与单次 401 重登、受控重试、全应用两路平台并发、每次网络尝试预算回调和前后身份 fence；HTTP 拒绝重定向、限制 4 MiB、10 秒超时并使用明确 CA/系统信任。

服务覆盖设备分页、独立能力探测、单设备类别详情、告警固定窗口第一页、清单/SCA 的受限读取和确定性 24 小时统计。代理前缀保留，路径逐段编码，索引模式要求固定前缀，客户端游标只作随机键，绑定主体/epoch/generation/run/查询。

| 能力                          | 当前行为                                                                           |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| 告警                          | 受控 DSL、设备子集与半开时间窗；原生 index/documentId 身份；缺字段省略             |
| Indexer 后续稳定分页          | 未核实，不生成后续游标；有剩余记录时 partial                                       |
| 清单、FIM 对象、SCA           | Server offset 分页；时间与稳定采集身份不足时明确 source limitation；对象不冒充事件 |
| authentication / file_changes | 映射未核实，返回 CAPABILITY_UNAVAILABLE，不伪造认证或变更历史                      |
| 漏洞状态                      | 403 返回 denied/not_executed；成功的权限探测也不能在行映射未核实时返回“零发现”     |
| 统计                          | size=0、level terms、UTC 1h histogram；保留 total.relation、分片/误差与 partial    |

这些限制与设计中的真实验证边界一致，不代表已经完成真实 Wazuh 的权限、严格 TLS、稳定分页或全设备覆盖验收。字段/路径与离线 M0 材料见 docs/development/workstreams/c/c0-c1-handoff.md。合成验收在 tests/adapter.test.ts；不读取真实凭据。
