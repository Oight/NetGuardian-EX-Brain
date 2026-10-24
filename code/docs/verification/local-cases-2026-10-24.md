# 本地案件闭环与 Windows 全量验收入口 · 2026-10-24

## 基准与授权

只读来源：NetGuardian-EX-Brain，代码基准 cc610cb6447ca70659030cc597b486a12cd8d872。复用已合入的 A1—A3 与独立预算（3ee347c / 157e956），业务 v4.2、工程 0.2.0、外部信封 0.1.0 保持。

用户授权按建议实现基础修复、本地案件闭环、C0/C1 离线适配与对应页面，并追加 Windows 开发者的 Node.js/Electron 全量测试命令。单个执行者串行处理 A/B/C/D；未启动子 Agent。所有实现与测试产物仅写 campussec；本地目录无产品 Git，本轮未提交、未合并、未推送，任务保持 checking/planned。

同步前的本地差异已保存在忽略目录 .local/implementation-cc610cb/before；来源代码清单及哈希在同级 baseline.json。历史 review 保留，不覆盖原有其他项目。

## 已实现行为

| 归属 | 实现与公开入口 | 核心失败行为 |
| --- | --- | --- |
| A 基础修复 | Facade 对成功/错误统一校验；同步抛错任务能再次调度；先构建后运行消费包的测试；增加 Bun 干净副本验证 | 未知错误码/额外字段变安全 INTERNAL；原有合法错误保留；未执行项不记通过 |
| A 格式化修复 | 从已验证的 157e956 附件恢复原 provenance 哈希对应字节；声明比较使用语法结构，权限检查容忍排版，锁比较仍核对完整元数据 | 冻结附件哈希、137 声明、43 方法/70 DTO 与初始 DDL 校验保留 |
| B1 存储 | 连续迁移校验和、身份校验、事务升级与失败保留；0001 不变，新增 0002 | 旧库可升级，未知版本/篡改校验拒绝；不是覆盖历史 DDL |
| B2 案件 | @campussec/core/cases，createCaseService({db,events,clock,ids})，CaseService 全部 7 方法和 CaseAtomicPort 全部 15 方法 | CAS 冲突不覆盖；种子/材料/投影按主体、连接、案件、轮次和版本核权 |
| B2 证据/背景/覆盖 | 原生来源去重、内容版本、retrieval、同页幂等与冲突；人工背景版本和相交案件 revision；连续页覆盖 | 缺来源身份拒绝；零结果也保留覆盖变化；不拿最后空页证明整窗完整 |
| B2 轮次原语 | 冻结输入、白名单投影、released/uncertain、持久化幂等 manifest、晚到报告保护、清理计划与当前保护集合复核 | prepared 不形成有效交付 refs；封存后不能补写；过期/引用变化要求重新预览；不改 S07/S10/S11 表状态 |
| C0/C1 | @campussec/wazuh-adapter，createWazuhAdapter({db,secrets,clock,ids,http?})；ConnectionService 全部方法有实际行为或明确受限错误 | 构造不联网；两侧认证不混用；403 不是零；预算/取消/旧代次禁止交付；未知映射不伪造材料 |
| D 本地工作台 | mountWorkbench({element,api})；案件创建/检索/详情、背景、状态、移动材料、来源与覆盖、设置与宿主能力状态 | 冲突保留输入；未接入调查明确错误；纯文本展示；无 Renderer 特权 |
| A/D 装配 | 生产 composeRuntime 默认注入真实案件服务和适配器，连接变更事件；后台调查仍受 recovery 屏障 | 未装配 S07/S08/S09/S11 时保持 degraded，本地案件可操作 |
| Windows 入口 | npm run test:windows:full（PowerShell 可用 npm.cmd） | 仅 Windows + Node >=24.15 <25 + npm 11.12.1；失败立即停止，后续 skipped；本机不执行 |

0002 两张新表均归 S06：case_run_manifests 解决 B0/G01 封存事实持久化，case_query_page_refs 保存精确页引用。冻结 architecture/schema 不重写，源码边界检查器显式登记追加表所有权。manifest 不额外复制可过期投影正文。

G02（处理备注入口）与 G05（报告结构引用/人工语义核查）属于后续 S10 及公共契约协调，未通过私加 API 或业务成功占位绕过。S06 清理原语不会被 S03 直接暴露；S07 还需把证据过期与工具回复缓存过期放在同一事务。

## 验证结果

本机 Linux / Bun 1.4.4。依赖先核对生命周期脚本，全部安装使用 --ignore-scripts、空 trustedDependencies；本轮新增的依赖只有本地 workspace 接线，未增加外部包版本。业务代码使用标准 TypeScript/ES modules 与 Node 公共 API，不使用 Bun 专有业务接口。Bun 专用行为仅在 scripts/local。

| 执行项 | 实际结果 |
| --- | --- |
| bun scripts/local/check-clean.ts | 通过；排除 node_modules/dist/dist-test/.local/.cache 后复制源码，冻结离线安装，再运行完整本机检查 |
| 严格类型、构建与标准测试编译 | 通过；测试前先生成公共包输出，证明不依赖旧 dist |
| 源码边界、冻结附件/DDL、两份锁图 | 通过；55 个产品源码文件，43 Desktop 方法、70 DTO；锁图比较不等于 npm ci |
| 全部自动化测试 | 128 项通过、0 失败，16 个测试文件；含原有基座/预算及新增真实案件、S04 合成、事务组合和 Windows 编排测试 |
| 真实临时 SQLite | 创建、背景版本、双 CAS、同页冲突/精确重放、覆盖、投影/封存、晚到报告、清理保护与回滚、v1→v2 升级和重开回读通过 |
| S07/S06 组合 | 预占第 300 个源身份后实际 capture，再因第 301 个超额失败，事件预占、证据与页整体回滚 |
| 合成浏览器操作 | 通过页面保存离线连接→创建案件→保存背景→重启本地核心→回读；模拟另一人保存后旧版本报冲突且输入保留；未装配调查明确失败并保留问题 |
| Windows 命令本机验证 | 纯计划/假 runner 验证平台、运行时和版本拒绝，失败阶段/未执行阶段区分，Electron CJS 静态语法通过；未启动 Node/Electron |
| 真实 Windows / Node.js / Electron 新代码 | 未执行；由 Windows 开发者运行新入口并提交实际报告 |
| 真实 Wazuh / TeleAgent / 模型 / MCP / 投递 | 未执行，未读取真实凭据 |
| 完整安装包、签名、安装卸载 | 未实现验收入口；不算 Windows 全量自动化通过范围 |

本轮曾出现并已修复的检查失败：格式化破坏冻结附件哈希；旧宿主测试仍假定案件服务不可用；空页夹具的 returned 与 records 不一致；多页覆盖把“仅有下一页”误判为永久 partial；新根级组合测试缺少 core 公开入口接线。上述历史失败不删除；最终干净副本检查为 128/0。

合成浏览器最初因沙箱拒绝监听端口而未启动；经用户批准，仅使用 Bun 在 127.0.0.1 建立临时测试页面。页面测试桥接和允许同源连接的 CSP 仅在独立本地工具中，生产 CSP 仍禁止网络。

## Windows 开发者执行

在 campussec/（远端对应 code/）使用 Node.js 24.15.0、npm 11.12.1：

```powershell
npm.cmd run test:windows:full
```

命令自动完成冻结依赖安装、全部产品检查、无旧产物的离线复验、官方 Electron SHA256 校验和真实双进程验收。需要首次官方依赖下载及可使用窗口/托盘/系统保护的 Windows 桌面环境。

真实 Electron 通过生产 renderer 创建案件、保存背景并制造一次并发冲突，再启动第二进程回读。它使用独立合成空间与 OS 保护的合成秘密，不读取个人 userData，不配置真实平台入口。

总报告：.local/windows-full/run-*/report.json。阶段失败后返回非零退出码，未执行项为 skipped；Electron 细项在 .local/electron-acceptance/run-*/write.json 和 reopen.json。详细命令见 [commands](../development/commands.md)。

## 下一阶段与边界

本轮交付本地案件闭环及外部环境可执行的完整自动化入口，不宣称整个项目完成。仍需 C2 的宿主/隔离通道窄端口，A4b 的请求生命周期、工具/留存/发布/完成装配，B3 的告警/报告审核/导出，C3/C4 的 MCP/投递，D3 的完整三入口界面，以及目标系统和安装包验收。当前相关入口明确返回不可用；后续按任务依赖推进，不能用本轮 fake 或历史 Windows 成绩替代新代码验收。

## 后续 Review 补记（2026-10-24）

上文 128/0 为首轮交付的实际历史结果。随后按用户要求 review，新增 7 个回归场景复现并修复了全局背景原/新范围与容量、规范化入参、清单原生身份、固定上界覆盖和设备误标问题；最终干净副本检查更新为 **135 项通过、0 失败**。详见 [Review 与忽略规则核对](../reviews/local-implementation-2026-10-24.md)。Windows 全量入口仍等待外部实际执行，未在本机启动 Node/Electron。
