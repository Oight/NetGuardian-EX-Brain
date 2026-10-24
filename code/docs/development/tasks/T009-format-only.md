# T009 · 全项目代码排版

状态：in_progress；实际 base d5b87dd；工作分支 task/T009-format-only。用户授权统一项目代码格式，要求保持逻辑不变。

范围：全部受 Git 管理的可执行源码、测试、工具、可编辑 JSON/HTML/CSS/YAML、Python；添加共享 Prettier/Ruff 配置与本任务记录。TypeScript 等采用两空格，Python 采用四空格。

保留：code/spec、design_document/docs/implementation 的原始设计快照、全部已应用 SQL 迁移、来源哈希登记、依赖锁、二进制、生成目录、.idea 和个人数据。SQL 迁移即使只改缩进也会改变校验和，不属于可安全重新排版的文件。

检查：TS/JS 语法树和字面值、Python AST、JSON/YAML 配置值、HTML/CSS 结构与受保护文件哈希；格式检查、产品完整检查与干净副本复验、设计检查。不会运行修复 lint、整理 import、依赖升级或真实模型/平台操作。


## 本轮实际结果

- Prettier 3.6.2 与 Ruff 0.11.13 固定版本；工具仅下载到忽略的本机目录，package.json 与两份依赖锁均未增加格式化依赖。
- 共检查 173 个既有源码/配置文件，按根 .prettierrc.json 与 .ruff.toml 统一样式；已经规范的文件不制造无意义差异。原先挤在单行的函数、事务和测试均拆为正常缩进与换行。
- 150 个 TS/JS/CTS/CJS 文件：格式化前后语法树、操作符、标识符和字面值一致；只忽略不影响表达式结构的外层括号。
- 3 个 Python 文件：ast.dump(include_attributes=False) 完全一致；16 个 JSON 保持键序与值一致；2 个 YAML 工作流保持配置值一致；HTML 元素/属性/有意义文本与 CSS AST 一致。
- 33 个受保护文件 SHA-256 完全一致，包括冻结快照、迁移和锁；未升级依赖、排序 import、运行 lint fix 或变更业务行为。
- 全仓 Prettier check、Ruff format --check、git diff --check 通过。
- npm run check：232/232 通过；npm run check:clean：冻结离线安装后的干净副本 232/232 通过。
- 两个 Python 设计检查通过；未重新运行有既知环境阻塞的真实 Electron 或真实宿主/模型/平台测试，T008 的未完成项保持原状。

后续开发者可在仓库根目录使用 `npx --yes prettier@3.6.2 --check .`（改写时用 --write）；Python 安装固定 Ruff 0.11.13 后运行 `ruff format --config .ruff.toml --check code/docs/development/workstreams/b/verify_b0.py design_document/scripts/design`。根忽略配置会排除不可重排的文件；不要绕过它去格式化已应用迁移或原文快照。
