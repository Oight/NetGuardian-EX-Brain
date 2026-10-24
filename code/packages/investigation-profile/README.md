# S10 · 调查配置

`@campussec/investigation-profile` 导出 `createInvestigationProfile(): InvestigationProfilePort` 与 PROFILE_MANIFEST。prepare 是纯准备：验证冻结范围、背景与 prepared 种子投影，生成固定 Skill/system 提示、受限 user 输入、工具白名单和精确引用。

只接受 system 调用；重复能力、范围外设备、错误哈希、缺失/过期种子及超过消息上限均明确失败。工具仅按 available 能力启用，背景保留人工核实状态；不读取个人配置、启动宿主、释放投影或调用模型。实际加载和权限隔离仍需 S08/S09 验收。测试在 tests/，验证记录见 [T003](../../docs/development/tasks/T003-b-local-domain.md)。
