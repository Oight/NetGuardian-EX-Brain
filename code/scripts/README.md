# 工程脚本

A 串行维护。product 放标准 Node/Bun 均可执行的构建、测试发现、边界/原文/锁检查；local 只有本机 Bun 编排；assets 放静态资源生成。

业务源码不依赖这些脚本。本机所有子命令使用 process.execPath（Bun），不执行 Node/npm/Electron。标准 npm 命令仅由其他成员/外部环境执行。
