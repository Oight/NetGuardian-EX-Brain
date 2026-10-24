# 项目结构与修改归属

原分工依据：设计仓库 `120c81cfd4d8ed720c9cc70178edb9c6fd172a34` 的 T002—T005。下文 A/B/C/D 为参考映射，实际按当次任务声明的路径认领，可跨原分工串行实现；共享文件仍保持单任务写入。权威组件依赖和表所有者仍是 [architecture.json](../../spec/architecture.json)，不改变业务基线或事务边界。

冻结附件的 sharedWritePaths 仍含旧 fixtures/shared。按新版任务将纯 fake 映射至 packages/testkit、真实集成夹具映射至 tests/support；共享文件列入当次任务范围并串行处理，不重写冻结附件。

```text
campussec/
├── apps/desktop/
│   ├── main/、preload/、runtime/、assets/  A：S03
│   ├── renderer/                         D：S12，本地案件工作台
│   └── tests/                            A：宿主合成/恢复测试
├── packages/
│   ├── contracts/{src,tests}/            A：S01，产品唯一契约出口
│   ├── testkit/{src,tests}/              A：纯 fake、时钟、ID、场景
│   ├── storage/{src,migrations,tests}/   B：S02
│   ├── core/
│   │   ├── requests/、investigations/    A：S07
│   │   ├── alerts/、cases/、reports/     B：S05/S06/S10
│   │   └── delivery/                    C：S11
│   ├── investigation-profile/           B：S10
│   ├── wazuh-adapter/                   C：S04
│   ├── teleagent-bridge/                C：S08
│   └── mcp-server/{channels,gateway}/   C：S09
├── tests/
│   ├── support/                        A：真实数据库/文件集成夹具
│   ├── tooling/                        A：工程检查的失败场景
│   └── acceptance/                     D：案件闭环/预算组合验收
├── scripts/
│   ├── product/                        A：标准环境通用构建/检查
│   ├── local/                          A：Bun 本机检查入口
│   └── assets/                         A：静态资源生成
├── docs/{development,verification,history}/
└── spec/                               固定原文、校验值和来源
```

node_modules、.local、.cache、dist、dist-test 和包内 dist 是忽略的生成物，不作为源码或交接输入。cases 与 wazuh-adapter 已有真实服务；其余待实现模块仍只有 README，不导出成功占位接口。

## 公开入口与测试

| 功能                 | 消费方式                                | 测试位置                                                                                                     |
| -------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| S01 类型/schema      | `@campussec/contracts`                  | [contracts/tests](../../packages/contracts/tests/contracts.test.ts)                                          |
| S02 工厂/事务/事件   | `@campussec/storage`                    | [storage/tests](../../packages/storage/tests/storage.test.ts)                                                |
| 共享 fake            | `@campussec/testkit`                    | [testkit/tests](../../packages/testkit/tests/fakes.test.ts)                                                  |
| S03 装配与恢复       | 桌面目录内部装配；UI 消费 DesktopApi    | [desktop](../../apps/desktop/tests/desktop.test.ts)、[lifecycle](../../apps/desktop/tests/lifecycle.test.ts) |
| 真实临时库/预置数据  | 仅测试导入 tests/support/storage        | 不进入公共 fake 或产品导出                                                                                   |
| 待实现 core/接入模块 | 先交实现和公开子路径，再维护根导出/装配 | 自有模块的 tests/                                                                                            |

跨模块使用公开包/子路径，不绕入 src/private Repository。testkit 只依赖 contracts，因此 B/C/D 无需等待真实 S02 才能使用 HTTP/执行/投递 fake。

## 唯一写者

| 内容                                                        | 本轮工作线                             |
| ----------------------------------------------------------- | -------------------------------------- |
| 根配置、两份锁、公共导出、脚本、contracts/testkit、CI、装配 | A，单任务串行                          |
| storage/migrations、物理 DDL                                | B；业务状态仍归各表所有者              |
| core 各域实现与私有测试/夹具                                | 对应 A/B/C；core/package.json 交 A     |
| renderer、用户流程验收                                      | D                                      |
| tests/support、跨模块接线检查                               | A，业务夹具与对应所有者协调            |
| 任务文件                                                    | 对应工作线；共享导航由串行文档任务维护 |

本次 T007 是用户授权的结构整理，不追溯将旧 S02 或状态页认定越界。后续 S02 交 B、renderer 交 D；根锁和公共文件不由四线并发修改。

## 2026-10-24 本地新增入口

- B：`@campussec/core/cases` → createCaseService，模块真实 SQLite 测试跟随 cases/tests。
- C：`@campussec/wazuh-adapter` → createWazuhAdapter，HTTP/权限/分页/fence 合成测试跟随 wazuh-adapter/tests。
- D：renderer/app.ts → mountWorkbench，只消费 DesktopApi；跨模块闭环在 tests/acceptance。
- A：scripts/product/test-windows-full.ts 是 Windows/Node/Electron 专用入口；本机仅运行 scripts/local/check.ts 与 check-clean.ts。
- B：0002 为 S06 追加两张封存/页引用表，0001 及冻结附件保持原哈希。

执行范围与未验收项见[本轮验证](../verification/local-cases-2026-10-24.md)，阶段状态仍以具体任务文件为准。
