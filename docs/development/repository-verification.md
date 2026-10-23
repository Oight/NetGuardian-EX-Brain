# 仓库初始化核验

日期：2026-10-23。范围为本地仓库、设计文档与协作规范，不是产品或真实链路验收。

来源与修改范围见[初始化记录](repository-setup.md)。环境为 Windows、Python 3.12.6、Node v24.16.0、Git 2.49.0.windows.1。

## 提交前检查

| 检查 | 实际结果与范围 |
|---|---|
| python -B scripts/design/verify_subsystem_designs.py --node-syntax | 通过；17 份工程文档、137 个契约声明、49 张 SQL 表及合成约束；13 份 TypeScript 原文/内嵌块仅语法解析 |
| python -B scripts/design/verify_development_docs.py | 通过；46 份 Markdown、232 个本地链接、19 个声明组件 DAG、49 张表各一位写所有者 |
| 一次性导入核对 | 通过；52 份来源文件 SHA-256 未变，导入快照与清单一致；contracts.ts、schema.sql、contract-vectors.json、architecture.json 四份权威附件字节一致 |
| 基线与候选/历史正文 | 9 份 current/proposals/history 文档除引用链接目标适配外，正文一致；35 个未随附来源记录原路径及引用关系 |
| 纳入范围与忽略规则 | 58 份 UTF-8 文本/规范文件；仓库内本地链接不越界；11 个秘密/依赖/运行材料排除样例和 5 个预期纳入样例通过 |
| 定向内容检查 | 未发现私钥块、长 JWT 值和指定 API key 格式；此检查不代表完整秘密检测认证。没有复制 private、研究二进制、数据库或运行日志 |
| Git 状态 | main 已初始化、远端为空；初始提交前逐项核对暂存文件清单 |

## 已知格式提示

全量 git diff --cached --check 返回 2，未标为通过：三份历史 Markdown 各有 3 处原有双空格硬换行；architecture.json 有 367 行原有 CRLF，被 Git 默认空白检查提示。它们保留了导入来源的原格式，不改写原件或关闭检查来消除提示。

.gitattributes 对 architecture.json 关闭行尾转换，保证提交/检出后的来源字节哈希仍一致。其余文件使用 LF。排除上述四个原格式文件后，其余 54 个文件的暂存空白检查通过；不将该局部结果写成全量通过。

本环境对用户级 Git ignore 文件读取受限；暂存与清单核对命令临时指定 core.excludesFile=.git/info/exclude，仍使用仓库 .gitignore。没有修改全局 Git 配置。

## 证明范围

没有执行产品 tsc、runtime schema、源码依赖/SQL 访问检查、Electron 构建、安装包或真实宿主/MCP/模型/Wazuh 验证；未配置 GitHub 远端或线上 CI。仓库与文档初始化完成不等于产品基座或完整 P0 完成。
