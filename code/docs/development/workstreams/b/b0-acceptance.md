# B0 合成验收材料与核验边界

## 1. 文件格式与消费方式

[b0-fixtures.json](b0-fixtures.json)内所有身份、设备、告警、背景和报告均为合成数据；固定时钟为 UTC，保留原生 Agent ID `001`。数据按 DTO 名称分组，不含平台地址、凭据或现场采样。

[b0-scenarios.json](b0-scenarios.json)的每项具有 id/module/phase/ports、given、when、expected。fixtureRefs 使用 `组名.键名` 指向完整合成输入；given 和 when 中的补丁/步骤是测试安排说明，不是 IPC/MCP 请求格式。后续测试应先取完整 fixture，再应用列明变体，调用真实公开端口并断言 expected。不得把 expected 原样排入 fake 后声称产品行为通过。

expected 中错误码只在契约明确时固定；报告语义/无效引用先要求 validation != valid 并保留候选，具体 invalid/needs_review 的细分在 G05 明确。DDL 探针只验证 SQLite 约束，不把 SQLITE_CONSTRAINT 等同于某个产品 ErrorCode。

[b0-mapping.json](b0-mapping.json)记录表归属、业务写入口、端口方法与场景关联。ports 的 tx 标记表示计划事务边界；不复制接口签名或提供新的 Repository 公共出口。

## 2. 覆盖主题

- S02：迁移校验、重新打开、主体/空间/代次、事务与事件整体回滚、异步回调拒绝、事件 reset；已有测试定义只列为可复用依据。
- S05：首次历史/恢复补收、重复源与相同文本异源、页中断/迟到记录、策略 epoch 竞态、预算拒绝仍提醒、未知身份分组、通知发送后崩溃。
- S06：无种子建案、状态/CAS/双案迁移、源版本与过期再取、未知时间、页响应冲突、连续页/采集覆盖区别、投影实际释放、跨轮读取、封存、背景作者与版本、清理变化。
- S10：prepare 无种子、released 引用/哈希、零匹配与缺权、partial 的语义限制、跨轮/未释放引用、valid 仍未审核、missing、无 run 取消、重复完成、并入版本冲突、review 与显式发布区别、待办和导出。

## 3. 可重复的离线核验

从仓库根运行：

```powershell
python -B code/docs/development/workstreams/b/verify_b0.py
git diff --check
```

verify_b0.py 只使用标准库，执行以下检查：

1. 核对冻结 spec 的 provenance/hash 和 0001.sql；逐项核对 B 表覆盖、方法名、窄 Pick 视图、引用的场景和本地文档链接。
2. 核对合成材料内部引用、版本、投影内容哈希、案例/轮次/作用域和刻意的反例安排。不是 Zod schema 或真实服务验收；不另写一个产品实现来“验证”预期。
3. 加载真实初始 DDL，在临时 SQLite 上预置明确的合成外键依赖，验证唯一性、外键、CAS 条件更新、回滚和文件重开。探针直接执行 SQL，不经过产品 DatabasePort；不会证明 async/权限/调度/报告业务正确。

设计离线命令从 `design_document/` 执行：

```powershell
python -B scripts/design/verify_subsystem_designs.py
python -B scripts/design/verify_development_docs.py
```

完整开发规范检查仍会检查既有 `.github/workflows/design-checks.yml`，该文件在产品 base 中已不存在；如因此失败，保留失败记录，B0 不恢复无关 CI、不跳过断言来报总成功。可另外调用其 check_links/check_boundaries 记录已通过的部分，不能替代全命令结果。

## 4. B0 通过条件与后续检查

B0 要求实现单元/依赖、完整表与端口映射、原子性安排、具体合成输入和预期、跨线请求及实际检查记录可复核，并保存准确实现/合并提交。产品服务暂未实现的场景只能标记为“后续验收预期”。

B1—B3 放行后按各模块执行真实产品测试及受影响的 typecheck/build/check:boundaries；B4 再验证预算/capture、清理/缓存、终态/结果/outbox 等组合。Electron、Windows 安装包、真实模型、Wazuh 和投递分别取得独立证据，不由本材料补足。
