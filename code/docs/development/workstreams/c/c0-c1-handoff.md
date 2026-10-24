# C0/C1 离线材料与本地交接 · 2026-10-24

基准 cc610cb6447ca70659030cc597b486a12cd8d872，依赖已合入的 A1—A3（3ee347c / 157e956）。本轮在 campussec 串行实现；未向只读来源写入，尚无本轮实现/合并 commit。

## M0 状态

| 项目                              | 本轮证明                                                          | 真实环境状态           |
| --------------------------------- | ----------------------------------------------------------------- | ---------------------- |
| Server / Indexer 独立入口和身份   | HTTP fake 核对两侧 Basic/Bearer，不互换凭据                       | 未访问                 |
| 严格 TLS / CA / 重定向            | 严格 HTTPS 代码及 fake 失败路径；无跳过校验开关                   | 未做真实握手验收       |
| Server 401 / 403 / 局部失败       | 合成重登、single-flight、权限隔离和错误场景                       | 未访问                 |
| 告警固定时间窗 / 统计             | DSL 与输出合成验证，半开窗口、原生身份、gte/partial               | 未核实当前安装映射     |
| Server offset 分页                | 不透明游标、同页重放、身份/代次 fence                             | 动态数据一致性仍有限   |
| Indexer 稳定分页                  | 明确不开放；不假设 _id 可排序                                     | 未验证                 |
| 资源扫描身份 / 时间               | 合成 native key + scan identity；缺失明确限制，旧时间不刷新为现在 | 未验证所有类别原生行键 |
| 宿主 M0、隔离通道、可信来源、回执 | 未实现，不由 S04 fake 推定                                        | C2/C5 待执行           |

## 固定路径与字段

- Server 登录：POST security/user/authenticate?raw=true；后续独立 Bearer。
- 设备：GET agents，受控 limit/offset/select。
- 清单：GET syscollector/{agent}/{os,hardware,packages,processes,ports}。
- FIM：GET syscheck/{agent}，仅对象语义；SCA：GET sca/{agent}，仅策略，不拼接未定义 policyId 检查入口。
- Indexer：POST {configured-pattern}/_search；告警投影仅 timestamp/@timestamp、agent、rule、固定 IP/用户等映射字段；不返回任意 _source。
- 资源身份：使用原生 id 或类别稳定字段组合，并结合 scan.id/明确扫描时间；缺失时拒绝生成可去重材料。identity 哈希只压缩这些原生键，不哈希整条内容来伪造身份。
- authentication、file_changes、漏洞状态行映射和 stable_alert_pagination 未获真实证据前不开放成功材料路径。

合成夹具集中在 packages/wazuh-adapter/tests/adapter.test.ts，均标明 synthetic，无真实地址、凭据和平台历史数据。

## C2 前的角色矩阵

| 入口       | 可用范围                                              | 不允许                           |
| ---------- | ----------------------------------------------------- | -------------------------------- |
| UI         | 通过 DesktopApi 操作本地案件/连接及确定性只读平台方法 | 伪造 Actor/委派/自动来源         |
| system     | 经注入端口执行后台只读操作；同一平台并发上限          | 绕过预算/身份 fence              |
| evidence   | 未来只绑定当前 run 的窄工具入口                       | 连接管理、全案浏览、修改人工状态 |
| delegation | 未来由可信来源建立请求                                | 直接获得证据通道或任意源身份     |

C0/C1 本地状态保持 checking，真实 M0—M4、C2—C5 和成员复验分别记录，不把本轮归档材料当成真实接入成绩。
