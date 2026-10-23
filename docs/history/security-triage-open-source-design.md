# 高校多源安全日志智能研判系统设计开发文档

> 整理标记（2026-10-22）：历史 v2；已被 v4.2 替代，保留用于追溯。
>
> 本副本仅增加状态说明并调整本地链接，未改写方案正文。[原始文件](../reference-index.md#source-18) · [统一文档入口](../README.md)

> 历史版本，2026-10-20 更新入口：当前实施设计以 [v4.1 受限调查客户端](../current/security-triage-client-design-v4.md)及[实验附录](../current/security-triage-client-experiments-v4.md)为准。本文件保留多机版与格式适配设计供参考，以下排期与能力不作为当前承诺。

**版本**：2.1，开源组件复用、混合接入与自定义格式适配历史方案。  
**日期**：2026-10-19。  
**资源**：四台约 Intel 13 代 i7、16 至 32 GB 内存的笔记本，Linux 与 Windows 混用；一台可部署 Kafka 的较弱服务器；无 GPU；通过供应商 API 使用大模型。  
**本次交付**：Markdown 设计文档，不包含具体程序、配置代码或安装脚本，也不表示已经安装或完成实测。

## 1 推荐方案与交付边界

采用 **Wazuh + Vector + 现有 Kafka + 一个 Python 研判服务 + 供应商大模型 API**。网络侧可接入防火墙、WAF、IDS/IPS、VPN 等设备的约定日志；Suricata EVE 是一个可复用的验证样例，不是架构必需条件。主要工作由安装配置、规则调优、字段适配和系统集成构成。

Wazuh 负责采集、解码、规则匹配、告警索引和原生查询页面；Vector 按需承担前置格式适配，并把需要调查的告警送到 Kafka；Python 处理案件、证据、资产与 API 工作流。首周不重写通用采集器、规则引擎或全量日志数据库。已有归一化数据通过独立的 Wazuh 输入投影与本地规则接入，不能假设内置厂商规则自动兼容自定义字段。

### 1.1 相比 v1 的明确调整

| v1 设计 | v2 设计 | 作用 |
|---|---|---|
| 自研文件采集与三种解析器 | Wazuh Agent 和已有 decoder，少量本地规则配置 | 缩小兼容性工作 |
| 自研窗口、检测状态机和检查点 | Wazuh 频率规则；候选案件的有界上下文查询 | 减少检测引擎开发 |
| 原始和规范化事件都进 Kafka | Agent 原生进入 Wazuh；Kafka 只承接候选告警 | 降低弱服务器负担 |
| 原始/规范化日志全量写 SQLite | 复用 Wazuh Indexer；SQLite 只保存案件和任务 | 避免重复建设索引 |
| 自研日志浏览页面 | 使用 Wazuh Dashboard；只增加简单研判页面 | 缩小界面工作 |
| NET_FANOUT 不同目标数规则 | 首周改为一种已选网络设备的安全告警接入，EVE 为可用样例 | 不再自研通用流量统计检测 |

**最后一项是交付范围调整。** 复用网络告警不能计为已经实现“60 秒内 30 个不同目标”的检测。该规则需要完整流记录及正确的去重统计，列入后续扩展；不能把 Wazuh 的频率或不同字段条件直接等同于精确的不同目标基数。

### 1.2 首周完成什么

三类数据接入：Linux 认证日志、Windows 认证事件、一种已选网络设备的安全日志。网络样例可使用 Suricata EVE，也可替换为实际设备的已知版本格式；首周不同时适配所有厂商。三个验证场景：认证失败聚集、聚集后出现同来源同账号成功、网络设备安全告警调查。另用相同样本投影生成自定义 JSON，验证其解码与通用规则兼容性；兼容测试不能当作新增厂商接入。

完成资产 CSV、候选案件聚合、证据回查、API 研判、本地校验、调查/拟处置双优先级和人工反馈。新增适配工作使用原有字段/规则适配预算，超过预算时减少厂商和场景数量，不扩大一周承诺。

一周标准版仍按 **两名熟悉 Python、HTTP 和 Linux 基础操作的开发者，每人每天六小时，共约 84 人时** 估算。熟悉 Wazuh 会进一步减少试错，但不把这个条件当作已知事实。单人裁剪版见第 11 节。

### 1.3 首周不承担的能力

本地 ML/DL 训练或微调、完整 OCSF 转换、任意 Sigma 规则自动执行、多 Agent 自主调查、全量报文存储、生产高可用、自动封禁，以及全校 1 万 EPS 或 20 Gbps 的持续运行保障，均不在首周完成定义内。

1 万 EPS 是后续递增压测档位，不能从官方 Agent 数量推荐或笔记本 CPU 型号推导出来。网络和资产规模未知，初验使用明确标注的实验清单，不虚构“一般高校平均值”。

## 2 开源组件怎样复用

| 职责 | 直接复用 | 项目仍需做的工作 |
|---|---|---|
| Windows/Linux 采集 | Wazuh Agent | 选定日志通道/文件、配置来源范围和实验身份 |
| 格式解析 | Wazuh decoder、JSON decoder 及 Vector 现成解析函数 | 原生规则可用时保留原生路径；自定义输入做字段语义映射和本地规则 |
| 认证失败聚集 | Wazuh 规则及 frequency/timeframe 等能力 | 选择规则族，验证来源、账号、Agent 分组及阈值边界 |
| 网络设备告警 | 已验证的厂商 decoder/规则；EVE 集成作为样例 | 按实际厂商/产品/版本选择适配，保留事件类型、原严重性与设备身份 |
| 日志索引与浏览 | Wazuh Indexer、Dashboard 及其默认转发链路 | 设置有限留存、只读查询账号、保存常用过滤视图 |
| 告警桥接 | Vector file/remap/filter 与 Kafka sink | 配置候选选择、输出字段、磁盘缓冲和错误分流 |
| 消息解耦 | 现有 Kafka | 一个候选 Topic、一个研判消费组，观察积压 |
| 研判工作流 | Python、Pydantic、httpx、SQLite、FastAPI | 实现小范围的项目逻辑，不建设通用平台 |

Wazuh 提供现成规则和解析测试工具；自定义内容放入其本地配置目录，不修改会随升级覆盖的内置规则目录。[Wazuh 数据分析说明](https://documentation.wazuh.com/current/user-manual/ruleset/)

Vector 的文件读取具有持久位置记录和轮转处理能力，Kafka sink 提供至少一次交付及确认支持。项目通过配置和故障测试复用它们，不重新实现文件 tail 和通用 Kafka 生产框架。[文件源](https://vector.dev/docs/reference/configuration/sources/file/)、[Kafka sink](https://vector.dev/docs/reference/configuration/sinks/kafka/)

Sigma 可以提供检测条件和关联设计参考，但它是规则格式与转换生态。后端支持、字段映射和时序关联能力需要逐项验证。首周不把 Sigma YAML 直接当成 Wazuh XML，也不开发通用转换器。[Sigma 关联说明](https://sigmahq.io/docs/meta/correlations)

## 3 总体架构与设备分工

### 3.1 数据流

```text
分散来源 / 已混合日志 / 已归一化数据
       ↓
逐记录接入信封：来源身份、格式线索、时间、原文位置
       ├─ 已验证原生输入 ── 原生 Agent / 已验证 decoder ─┐
       └─ 自定义或未支持输入 ─ Vector 解析与语义映射     │
                                  ↓                 │
                     单事件 JSONL → Wazuh Agent ─────┤
                                                   ↓
                              Wazuh Manager：原生或通用本地规则
                                               │
                                               ↓
                                          alerts.json
                                           /        \
                        原生 Filebeat 转发 /          \ Vector：候选选择与字段映射
                                         ↓            ↓
                                Wazuh Indexer      Kafka triage.candidates
                                  /       \                 ↓
                          原生 Dashboard   \       Python 案件与研判服务
                                            └────→ 有界证据检索
资产 CSV ────────────────────────────────────────→ 证据包与双优先级
                                                           ↓
                                                   供应商大模型 API
                                                           ↓
                                                本地校验、研判页面与反馈
```

图中分支按格式兼容性划分，不要求来源事先物理分开。同一个文件、接收端或 Topic 中的记录逐条识别后进入相应适配路径；来源在合流后仍保留。原生 Filebeat 链路不变，LLM 不可用时，检测和 Dashboard 仍可使用。

Wazuh 原生 Agent 无需先绕到 Kafka。自定义格式默认由 C 的适配器写成本机 JSONL，再由 C 上 Agent 读取；该 Agent 表示中转机，实际来源和目标必须保留在事件字段中。若数据已在 Kafka，用 Vector Kafka source 接入该适配路径，不假设 Manager 原生消费任意 Kafka Topic。单一来源同一时段只选一条检测路径，避免原文和归一化副本重复计数。

### 3.2 四台笔记本的使用

| 设备 | 建议条件 | 职责 |
|---|---|---|
| A | Windows 或 Linux，16 GB 起 | 原生 Agent、Windows 认证样本、源端正常/异常场景验证 |
| B | 优先 Linux、32 GB、空闲 SSD 最大 | Wazuh Manager、Indexer、Dashboard、原生 Filebeat，以及告警分支 Vector |
| C | Linux 优先，16 至 32 GB | 混合输入接收、必要的 Vector 适配、本机 JSONL 与 Agent、选定网络设备样本及负载回放 |
| D | Linux 或 Windows，16 GB 起 | Python 研判服务、案件 SQLite、API worker、资产表和简单研判页面 |
| 较弱服务器 | 现有可用环境 | Kafka 单 broker，仅缓存候选告警 |

B 的 Linux 环境是首日部署条件；原生安装优先使用官方支持的发行版。若只有 16 GB Linux 设备，先小规模验证，不能按 32 GB 预算直接部署。需要虚拟机时，计算宿主与来宾的共同内存和磁盘开销。

Wazuh 官方 Quickstart 对 1 至 25 个 Agent 的集中部署列出 4 vCPU、8 GiB 内存和 50 GB 存储的推荐参考；该表不是 1 万 EPS 测试结果。本项目优先给 B 分配更多内存和磁盘，用于索引、操作系统及并行服务。[Wazuh Quickstart](https://documentation.wazuh.com/current/quickstart.html)

第一天建议核实 B 至少约 80 GB、D 约 10 GB 的空闲空间，作为实验起始预算；实际留存按实测消息大小与磁盘增量配置，不承诺该空间能长期保存校园日志。四机接电、禁止实验中自动休眠、优先有线连接并同步时钟。

## 4 大量正常数据如何清洗与降噪

### 4.1 清洗与候选筛选分开

清洗解决字段、类型、时间、来源和质量问题；检测判断哪些行为值得调查。“未触发规则”不能标为“已经证明正常”。首周优先使用已有 decoder 和 Vector 解析函数；自定义输入做一次必要的结构与语义转换，Python 不再对所有原文重复解析。

| 层次 | 配置或动作 | 数据后续去向 |
|---|---|---|
| 源端范围 | 选择认证日志和约定安全告警，暂不接入无关应用调试流 | 进入 Wazuh 的流量先收敛 |
| 解析与基础规则 | 使用现有 decoder、基础规则，保留失败与成功 | 为聚集检测和补证提供数据 |
| 候选选择 | Vector 依据规则 ID/组、等级和设备签名选择 | 只有候选进入 Kafka 和案件服务 |
| 案件合并 | 固定实体和场景键合并重复告警 | 同一行为形成持续更新案件 |
| 深度分析 | 对案件查询上下文、绑定资产并调用 API | 消耗较多资源的部分受到预算控制 |

### 4.2 两道门不能混成一道门

**第一道门是 Wazuh 的记录和索引条件，第二道门是 Vector 的候选条件。** 第二道门收紧时，不应同步提高第一道门而丢掉后续调查需要的基础认证记录。

Wazuh 默认把等级至少为 3 的告警写入 alerts.json，并通过原生链路索引。不是所有收到的原始事件都会出现在该索引中。[告警管理](https://documentation.wazuh.com/current/user-manual/manager/alert-management.html)

首周必须核实 Linux 和 Windows 的失败、成功基础事件都能查询到；若某种来源没有输出必要事件，使用范围很窄的本地规则补齐，或明确标为证据缺失。不得通过把基础规则降为 0 或只保留高危告警来减少负载，再宣称支持完整的失败后成功调查。

Vector 初始候选条件为：指定认证聚集规则、选定网络设备安全事件族，以及其他等级至少为 8 的已纳入规则。等级阈值只是初始配置。厂商告警和自定义语义规则有独立通道，不能只看 Wazuh 等级；设备原严重性和 Wazuh 等级不是同一种尺度。动作 deny/blocked 本身不代表攻击，须先完成事件类别及行为语义判断。

### 4.3 不用抽样破坏检测条件

认证失败计数、失败后成功关联所需数据不得在进入规则引擎前随机抽样。重复投递与真实重复行为分开处理。来源正常、白名单或成功结果都不能单独成为“丢掉所有记录”的依据。

Vector 的 filter 用于明确范围内的候选分流；throttle 会丢弃超过限制的事件，不作为关键认证输入的默认处理。需要限制的是 API 调用量，而不是悄悄减少规则看到的失败次数。[Vector filter](https://vector.dev/docs/reference/configuration/transforms/filter/)、[throttle 的丢弃语义](https://vector.dev/docs/reference/configuration/transforms/throttle/)

### 4.4 分层保存

| 数据 | 默认保存方式 |
|---|---|
| 源端原文 | 尽量复用来源文件或事件日志，按容量滚动保留 |
| 约定认证基础事件与安全告警 | 进入 Wazuh 原生告警索引，使用有限留存 |
| Kafka 候选消息 | 短期缓存，保护研判服务不受瞬时峰值影响 |
| 案件证据 | 检索后冻结并固化到 D，附上实际索引和文档引用 |
| LLM 结果与人工反馈 | 与证据版本一起保存到案件库 |

首周不默认启用所有收到事件的 archives 全量索引。Wazuh 的全量事件记录与告警记录是不同能力；开启 logall_json 会增加本地事件保存量。[Wazuh 事件记录](https://documentation.wazuh.com/current/user-manual/manager/event-logging.html)

只在必要事件已经可查询的前提下使用该默认方案。若需要未匹配规则的原文，必须另行确认归档或源端回查路径；第一周不建设通用跨主机原始日志查询平台。查不到的上下文记为缺失，不解释为良性或不存在。

### 4.5 混合输入先解决记录边界和来源身份

同一文件或 Topic 中可以交替出现不同设备的记录，但必须能判断一条事件的边界，并尽量保留 origin_device_id、observer_id、vendor/product、format/version、namespace、原始位置和时间。多行事件先按已知格式组装；传输或日志中的多行字符串不能随意拆成多个安全事件。原始网络报文需先变成可分析记录，不直接当普通文本日志混合解析。

采集来源、观察设备与事件参与者分开：中转机地址不是原设备身份，防火墙管理地址不是攻击来源地址；事件的 src_ip/dst_ip 不能由采集 socket 的对端地址随意代替。

格式判断优先使用接入配置、可信来源登记、schema 标记和程序名，再按 CEF/JSON/固定文本特征选择少量候选解析器。只识别到 JSON 外壳不等于识别了厂商业务格式。无法识别或多个解析器冲突时，保留原文并进入 unknown/ambiguous 队列，记录样本与数量，不归为正常，也不逐条送 LLM 兜底。

若来源标签已经丢失，只能用内容特征补充推断并标记 source_uncertain；原始信息被删除后，系统不能保证恢复真实设备和字段含义。首周新增来源需要样本和格式说明，不承诺任意日志自动识别。

### 4.6 统一的是字段含义

| 来源表达 | 统一语义示例 | 需要保留的差异 |
|---|---|---|
| Linux 认证失败文本 | authentication / login / failure | 本地主机、账号范围与来源地址 |
| Windows 4625 | authentication / login / failure | 计算机、域、账号、登录类型 |
| 某 VPN 的 auth_result=failed | authentication / login / failure | VPN 产品版本、远程账号及地址语义 |
| 防火墙 action=deny | network_connection / deny / unknown | 策略与阻断动作，不直接称攻击 |
| IPS 的签名命中事件 | security_alert / detect / unknown | 设备事件类、签名、原严重性与原动作 |

JSON 序列化不完成上述语义映射。适配表需要规定行为类别、结果码、严重性尺度、时间单位/时区、账号范围、地址方向和缺失值。保留原始字段，不能靠字段名相似就认定含义相同。Vector 提供 JSON、Syslog、CEF、键值等解析函数；厂商语义和版本仍由适配表补充，CEF 等解析后的类型也须校验转换。[Vector VRL 函数](https://vector.dev/docs/reference/vrl/functions/)

建议最小规范包括：schema_version、event_id、namespace、origin_device_id、observer_id、event_category、event_action、event_outcome、event_time/observed_at、src_ip/dst_ip、target_entity_id、account_scope/account_name、native_event_code/severity、mapping_version、quality_flags、raw_locator。规则只使用其适用场景的必要字段，不把未知账号或目标合并为共同空键。

### 4.7 自定义格式怎样进入 Wazuh

| 情况 | 接入与检测方式 |
|---|---|
| 原生格式已有可靠支持 | 使用已有 decoder/规则，验证实际版本和样本 |
| 新厂商或未支持文本格式 | 增加少量本地 decoder，或由 Vector 先解析并映射到统一字段 |
| 已有自定义 JSON 规范 | 生成稳定的 Wazuh 输入投影，用 JSON decoder 提取字段，并配置匹配统一语义的本地规则 |
| 自定义二进制或其他内部格式 | 前置适配器转换为可解码的 JSON 输入投影，内部规范可继续保留 |

Wazuh 的 JSON decoder 能提取自定义字段供规则使用，不要求 JSON 必须来自 Suricata。但它不自动把自定义的 auth_result 转成内置规则期待的字段和规则链。对象数组等结构也有解码限制，首周规则输入优先用标量和简单对象，复杂证据保留在原文/证据包中。[Wazuh JSON decoder](https://documentation.wazuh.com/current/user-manual/ruleset/decoders/json-decoder.html)

规则适配层至少定义基础认证失败、基础认证成功、失败聚集和设备安全告警等少量场景。基础记录的输出用于后续补证，不直接认定攻击。规范中 login/failure 等语义一致后，同一通用场景规则可供多个已映射来源使用；新增行为类别仍需规则和测试，不承诺一次映射就覆盖该设备所有攻击。

因此有三项独立验收：能接收、能解析、能按预期检测。内置规则依赖的 decoder/规则链和字段不满足时，不能只把字段改名后声称全部内置检测仍然有效。[自定义 decoder](https://documentation.wazuh.com/current/user-manual/ruleset/decoders/custom.html)

### 4.8 混合转发不能按中转机错误分组

规范化路径的 Agent ID 可能全部指向 C。认证分组改用真实 namespace、target_entity_id、来源地址和带范围账号，生成稳定的 correlation_auth_key；关键身份缺失时跳过该聚集条件并报告质量缺口，不使用 null 当公共键。本地规则可用动态字段 same_field 关联这一组合键。

Wazuh 默认频率计数只考虑同 Agent；跨 Agent 计数需要明确配置和测试，global_frequency 的范围也只是单 Manager。跨设备、跨来源或跨 Manager 的完整案件关联不因数据混在一起就自动完成，仍由约定规则与研判服务的有界查询负责。[关联规则的作用范围](https://documentation.wazuh.com/current/user-manual/ruleset/ruleset-xml-syntax/rules.html)

同一真实行为可能被主机、认证网关和安全设备分别观察。先保留独立观测及其来源，再建立支持关系；没有稳定的共享事件身份时，不把三条观测简单当成三次登录失败，也不按同 IP 自动认定为同一事件。

每个计数场景配置权威计数来源和辅助证据来源。例如主机认证失败用于次数，设备的转发副本或旁路观察只作支持；来源不明时降低计数覆盖确定性。通用频率规则先限定计数来源，再按组合键统计，不能把混合后的所有同类观测直接相加。

### 4.9 首周适配登记与测试

每个适配登记格式/产品版本、来源匹配条件、必需字段、语义映射、schema/mapping 版本、适用规则、正反例和未知字段策略。D1 冻结 Linux、Windows 和一种实际网络格式；自定义规范用这些来源的等价投影验证，不额外承诺更多厂商。

验收必须交错混入不同来源、正常事件和异常事件；同时测试未知格式、错误标签、同名不同域账号、多个目标经同一中转机、原生与投影副本重复、不同来源的严重性尺度。混合与分开输入应得到相同的适用事件计数及场景结果；时序敏感规则保持相同投递节奏。未识别样本不能算作正常。

## 5 三个首周场景怎样实现

### 5.1 认证失败聚集

复用 Wazuh 认证基础规则和频率关联能力。业务初始条件为同一监测范围、来源、目标和账号在 60 秒出现 20 次失败。使用内置规则时先检查它的真实分组条件；条件不同就配置少量本地规则，不能只改描述。

规则语法支持 frequency/timeframe、既有规则匹配及相同来源等条件，但不把配置写出来视作验证完成。用 19、20、21 次、不同账号、不同来源、不同 Agent 和窗口边界样本确认实际行为。[Wazuh 规则语法](https://documentation.wazuh.com/current/user-manual/ruleset/ruleset-xml-syntax/rules.html)

优先用 Wazuh 自带 wazuh-logtest 验证解析和规则，再用真实 Agent 链路验证端到端。工具测试是规则测试，不等同于实时采集已经完成。[官方规则测试工具](https://documentation.wazuh.com/current/user-manual/ruleset/testing.html)

### 5.2 失败聚集后出现成功

首周默认采用“已有聚集告警触发有界调查”的方式：案件建立后，只针对该来源、目标、账号，查询之后 300 秒内是否出现成功认证。每十秒检查一次活跃案件，最多并行跟踪十案；该查询不调用 LLM。

成功出现且身份和顺序可确认时，补入同案并提高调查优先级。每次查询只处理新增证据 ID；没有新增证据不增加 revision，也不再次调用模型。活跃关联额度满时，后续案件显示 correlation_deferred，仍保留原生聚集告警；首周由人工触发补查，不声称已经连续跟踪全部案件。

若原生关联规则能在实际版本、来源字段和正反例中正确表达该条件，可以替换十秒查询；不为此新建通用 CEP 状态机。默认查询方案的时效目标见第 12 节。

首周的时序解释按平台实际可查询时间及来源时间质量给出。来源批量迟到、时钟异常或缺少可靠来源时间时，标记 order_uncertain，不断言准确的行为先后。历史样本回放要记录投递节奏，不能只改消息内时间戳就宣称验证了原生引擎的精确事件时间窗口。

### 5.3 不同网络设备的安全告警

按实际设备选择已有 decoder 或第 4.7 节的通用适配路径。设备可通过已有文件、Syslog 或约定接口集中接入；消息是否可接收与业务字段是否被正确解析分别验证。[Wazuh 日志接入能力](https://documentation.wazuh.com/current/user-manual/capabilities/log-data-collection/index.html)

使用 EVE 时，可直接复用官方集成。首周可以回放已有网络设备日志；只有实际检测引擎及对应流量产生了记录，才计为完成在线网络检测。[Wazuh 与 Suricata 官方集成样例](https://documentation.wazuh.com/current/proof-of-concept-guide/integrate-network-ids-suricata.html)

先冻结一至两个有正反例的设备安全事件场景，不承诺“自动覆盖所有网络攻击”。告警中的地址、事件代码/签名、严重性、流或会话 ID 及流量统计可按实际可用性用于研判。没有全量 flow 输入时，不生成精确不同目标数、完整连接基线或未被记录的通信事实。

设备原生告警表示签名条件被命中，后续仍核查授权任务、资产角色和证据缺口。签名命中不直接等同于攻击成功。

## 6 只开发一个研判服务

逻辑上分成下列三个模块，使用一个仓库和 D 上一个本机案件数据库，不拆成三个独立平台。

| 模块 | 需要实现的内容 | 复用的边界 |
|---|---|---|
| 案件与任务 | 候选去重、固定案件键、revision、SQLite 任务与反馈 | 不实现原始采集和检测器 |
| 证据与资产 | 固定查询模板、字段映射、CSV 时态绑定、预算证据包 | 不开发任意查询代理或完整 CMDB |
| API 与输出 | 一个供应商适配、超时/配额、结构校验、双优先级和简单页面 | 不做本地训练或自主执行处置 |

实现栈建议使用 Python 3.12、confluent-kafka、Pydantic 2、httpx、SQLite、FastAPI/Uvicorn/Jinja2。D1 适配验证后锁定版本，不为追新升级整个依赖树。

### 6.1 案件与身份

认证案件键由 run_id、namespace、目标实体、来源地址、带域或主机范围的账号和场景族组成。原生直采可通过 namespace 与 Agent 身份绑定目标资产；中转/规范化路径必须用事件中的真实目标身份，不能绑定成中转机。未知时保留稳定主机实体，不将所有未知资产合并为空值。首次建案的实体键固定，资产更新不自动迁移既有案件。

网络设备案件键使用来源实例、适用的会话/流 ID 和事件代码或签名，并受 run/namespace 限定；缺少可靠关联字段时按该告警独立建案。不同传感器的相同流 ID、不同厂商的相同事件代码不能直接合并。

同一场景空闲十分钟后，新信号新建下一案件。告警合并不等同于删除误报。只在新增证据或明确的调查条件变化时修订案件。

### 6.2 最小资产表

| 字段 | 作用 |
|---|---|
| asset_id、namespace | 稳定资产及网络空间 |
| origin_device_id、agent_id、host_alias、ip | 本次实验使用的身份线索；Agent 是中转机时不得替代真实对象 |
| valid_from、valid_to | 绑定有效区间，按事件时间查询 |
| role、criticality | 角色和重要性 1 至 5 |
| owner | 负责单位或负责人标识 |

导入时检查有效期和冲突。同一空间同一时刻多个候选返回 ambiguous；没有匹配返回 unresolved。服务器重要性不作为攻击事实。网络告警攻击方向不明确时保留两端候选，不默认目的地址就是受害者。

### 6.3 本机数据库

| 表 | 内容 |
|---|---|
| received_alerts | 收到的候选及唯一键 |
| cases、case_evidence | 案件、revision、证据引用与冻结内容 |
| triage_jobs、triage_results | 调度状态、租约、版本、预算与历史结果 |
| asset_bindings | 版本化资产表 |
| feedback | 人工确认和备注 |
| quota_usage | 按尝试预占的持久 API 额度 |

所有表只由 D 上服务访问，不把 SQLite 放在共享目录供多台机器直接写。Wazuh 索引继续作为原生查询来源，案件库不复制所有背景日志。

### 6.4 ML 与 DL 的位置

首周由现有规则、聚集条件和有界上下文查询完成初筛；语义研判使用供应商已经部署的大模型。传统 ML 或独立 DL 检测不成为部署依赖。复用一个算法仓库并不等于已经获得适配本校日志的模型。

后续若取得适配的现成模型，先固定特征名称、顺序、单位、缺失值处理、编码和模型版本，再通过统一批量评分接口加入候选信号。CPU 推理的耗时、覆盖范围和误报需要独立实测；模型不可用时现有规则链路继续工作。首周不为这些扩展建设训练平台。

## 7 字段契约与证据检索

### 7.1 候选告警契约

| 字段组 | 字段与要求 |
|---|---|
| 来源身份 | source_instance、run_id、namespace、Wazuh native_alert_id |
| 幂等键 | source_instance 加 native_alert_id；同一输出文件重投递保持不变 |
| 来源对象 | agent_id、origin_device_id、observer_id、真实目标身份、主机名与传感器标识 |
| 检测信息 | native_rule_id、native_level、groups、场景族；网络侧保留 signature_id、native_severity |
| 时间 | observed_at、可确认的 event_time、time_quality |
| 行为实体 | 统一 src_ip、目标实体、带范围账号；保留来源字段路径 |
| 初始证据 | 原始 full_log 或受限快照、解析质量和原始位置 |
| 适配版本 | field_mapping_version、candidate_policy_version |

原生 Wazuh 输入的字段路径仍可能不同；自定义规范输入使用其已冻结的字段路径。D1 保存 Linux、Windows、选定网络格式和自定义投影的对照表。研判服务通过查询适配层获得统一事件视图，不要求原生路径全量再次写入；如果已有全量归一化输入，则只做必要的 Wazuh 输入投影，不转换完整 OCSF。

同源原始日志重新注入 Wazuh 可能生成新的 native_alert_id。首周的幂等保证针对同一已生成候选的重投递，不承诺把任意重复采集都识别为同一真实行为。独立演练使用新 run；来源没有独立 run 字段时，实验期间固定来源清单、时间边界和重放记录。

### 7.2 固定证据查询

从 Wazuh Indexer 的告警索引查询，使用只读账号。Wazuh Server API 用于管理和规则测试，不把它误当作通用告警全文检索 API。[Indexer 告警查询示例](https://documentation.wazuh.com/current/user-manual/indexer-api/use-case.html)

首周只定义四个查询模板：按原生告警身份定位；按真实目标、来源、账号和短时间窗查询认证上下文；按同观察设备及会话/事件代码查询网络告警；按已绑定资产和短时间窗查询选定来源的相关安全告警。原生路径和统一格式路径各自映射查询字段，中转路径不以同 Agent 代替同目标。接口限制时间范围、返回数和并发，不允许模型生成任意 SQL 或索引查询。

跨源补证只针对已经触发的候选案件，初始范围为案件时间前后各五分钟、同 namespace 的确定资产别名和约定事件类。它把主机认证与设备告警作为可能相关的证据，不因时间或 IP 接近就自动合并案件或证明因果。NAT、共享地址、资产冲突或顺序不确定时保留关联缺口；不对所有背景日志做两两比较。

索引文档的 `_id` 与 Wazuh 告警自身 id 分开保存，证据引用包含实际 index、文档 `_id`、原生告警 id 和来源范围。不得把两种 id 当成同一个值。

单次最多取 50 条代表记录；需要总量时另用受限计数或聚合查询。计数必须标明“已索引且符合条件的记录数”，不能在索引存在缺口时称为原始全部行为次数。可疑事件、后续成功、业务反证分别查询，避免只取最新 50 条而漏掉关键类别。

### 7.3 索引延迟与证据包

候选由本地告警文件较快发出，Indexer 可能尚未可查。先建立本地案件，使用消息快照展示依据，再每两秒查询，初始最多等十秒；仍未找到时进入 evidence_missing/needs_review，不输出良性结论。后续补查由人工触发。

冻结证据包包含：案件版本、关键/反证事件、计数的统计口径、资产快照、未知项、字段版本和查询覆盖情况。最多十二条代表事件，优先保留成功登录、关键告警和反证；重复失败用计数与代表样本表达。完整已取到的证据固化在案件库，LLM 只接收预算内的子集。

evidence_hash 根据冻结包计算。重试不更换包；新证据产生新 revision。必保内容超出预算时标记 budget_insufficient，转人工核验。

## 8 API 工作流、恢复与校验

### 8.1 工作流

```text
Kafka 候选
  → 案件库同事务：候选去重、案件修订、等待补证任务
  → 提交输入位点
  → 查询并冻结证据包
  → 领取任务租约，预占调用额度
  → 供应商 API
  → schema、包内引用、版本和资产校验
  → 条件回填当前结果，或保存为旧版本历史
```

等待补证任务首先以 case/revision/model/prompt 唯一键创建。冻结后生成带 evidence_hash 的调用键。API 不放在数据库事务内；任务状态包含 waiting_evidence、running、retry_wait、succeeded、superseded、needs_review。

领取任务采用状态和租约条件更新，并生成 lease_token。回填同时校验租约令牌和当前案件 revision；旧请求完成只入历史，不覆盖新结果。新证据取消未运行的旧任务，不强行中断已经发出的外部请求。

### 8.2 初始参数

| 参数 | 初始值及处理 |
|---|---|
| API 并发 | 2，依据供应商额度调整 |
| 整次调用超时 | 30 秒，覆盖连接至完整响应 |
| 最多调用尝试 | 2，首次和重试合计 |
| 每日尝试上限 | 50，可配置；发送前在本机事务预占，重试/超时/租约重发均计入 |
| 活跃待研判任务 | 最多 100，同案合并为最新待运行版本 |
| 输入/输出预算 | 约 6,000 / 800 token，按供应商计数和 usage 核对 |
| 任务租约 | 初始 60 秒，过期可重新领取，但受总尝试和当日额度约束 |

额度耗尽或队列满时，案件保留并显示 quota_exceeded/queue_full，进入 needs_review。限制 API 不应静默删除原生告警。请求超时不证明远端没有执行，有限重试也可能产生重复计费；记录每次尝试与 request_id。

### 8.3 输出契约

| 输出字段 | 约束 |
|---|---|
| verdict | malicious、benign、insufficient_evidence |
| findings | 区分事实与假设，提供支持和反证 ID |
| affected_asset_ids | 只能引用本包资产 |
| missing_evidence | 明确待补内容 |
| suggested_actions | 给出候选调查/处置建议，由人工执行 |
| 本地元数据 | case/revision、evidence_hash、实际模型和提示词版本由适配器绑定 |

日志内容只能作为证据，不能修改任务指令。行为引用必须在本次发送的冻结包内；资产事实引用包内资产与快照。校验通过只代表格式和追溯关系有效，不能证明推理正确；人工反馈保留原始证据入口。

### 8.4 复用后仍存在的恢复边界

Vector 使用持久 data_dir、适用的确认机制、磁盘缓冲与保留的告警文件，结合轮转/重启/断网测试验证。Kafka 候选 Topic 单分区、单 broker、复制因子 1；只对该候选流采用至少一次与幂等消费，不宣称端到端恰好一次。

Wazuh 检测引擎重启后的关联状态按其实际版本行为测试。本项目不额外开发检测状态持久化；原生计数状态若不能恢复，则最长 300 秒相关观察窗口标为 warming_up，不能继承 v1 自研检查点方案的无缝恢复承诺。已落库案件、证据和 API 任务仍可恢复。

## 9 双优先级与项目创新

### 9.1 双优先级

| 决策 | 规则 |
|---|---|
| 调查 I1 | 强信号，或重要性至少 4 且已有有效候选信号；优先核验 |
| 调查 I2 | 其他候选、身份待确认或需要补证；等待老化防止长期饥饿 |
| 拟处置 P1 | 有支持证据的恶意行为，且核心资产受影响或正在扩散，立即人工确认范围 |
| 拟处置 P2/P3 | 按已核验影响、持续性与业务代价安排准备处置或跟踪 |
| REVIEW_REQUIRED | 证据不足、身份不确定、输出校验失败或遥测缺口 |
| NO_ACTION | 已核实良性且没有未解决的冲突证据 |

拟处置等级由本地策略结合事实与报告生成，不能把模型自报置信度直接当阈值。重要资产的弱线索可以优先调查，但不会变成强攻击证据。普通终端若影响核心系统，也不能因为源资产等级低而降低相应处置优先级。

### 9.2 三项工程创新及验证

| 创新 | 对已有组件增加的工作 | 如何证明有用 |
|---|---|---|
| 保留关键/反证的预算证据包 | 按规则选择关键事件、反证与代表样本，附查询覆盖和统计口径 | 与固定窗口原文输入比较 token、必保覆盖、引用错误和人工判断 |
| 随证据修订的渐进研判 | 案件 revision、冻结包哈希及旧结果回填约束 | 人为制造索引/API 延迟，检查过期结果覆盖和重复调用 |
| 身份不确定性下的双优先级 | 资产有效期/冲突标记，区分调查排序和拟处置 | 固定行为改变资产标签，检查事实不变、排序按策略变化 |

这是本项目的工程设计贡献，不声称算法首创。不能把告警合并率写成误报率降低，也不能用少量人工样本宣称真实校园攻击召回率。对规则外未知攻击的覆盖仍需后续真实数据评估。

## 10 借鉴哪些已有设计

| 来源 | 可以借鉴的部分 | 本项目的具体落点 | 未直接采用的部分 |
|---|---|---|---|
| Wazuh 原生架构与 Suricata 集成 | Agent/解码/规则/索引/查询的成熟处理链路 | 替代 v1 通用采集、解析、检测和查询子系统 | 不以官方演示代替本地性能验证 |
| Wazuh 官方 LLM 告警增强 PoC | 检测结果触发 API，补充解释和建议的集成路径 | 参考接口衔接方式，增加案件、证据和预算控制 | 其 YARA/FIM 和自动响应示例不进入本项目首周范围 |
| CORTEX | 基于证据检索的调查、行为上下文与可审计判断 | 固定模板检索 → 冻结证据包 → 单次结构化 API → 本地校验 | 不照搬多 Agent、自由工具探索和论文性能指标 |
| Sigma 关联设计 | 事件计数、实体分组、时序条件的明确表达 | 用于审查本地规则和设计正反例 | 不假设所有格式和关联都能直接转换为 Wazuh 规则 |

[Wazuh 官方 LLM 增强 PoC](https://documentation.wazuh.com/current/proof-of-concept-guide/leveraging-llms-for-alert-enrichment.html) 已给出检测与外部大模型结合的实例，但它不是本项目完整案件流程的即插即用替代品。

[CORTEX: Collaborative LLM Agents for High-Stakes Alert Triage](https://arxiv.org/abs/2510.00311) 为证据驱动分诊提供研究参考。本项目是对其部分设计思想的工程取舍，不是论文复现；论文中验证的收益不能直接转移到本项目。

## 11 七天实施计划

### 11.1 两人标准版

| 日期 | 开发者 A：平台与数据 | 开发者 B：研判与集成 | 当天完成条件 |
|---|---|---|---|
| D1 | 安装 Wazuh，接入一台 Agent，登记混合来源与网络样例 | 验证 API、资产样例、统一字段与输入投影契约 | 一条真实认证可查询，来源与格式边界冻结 |
| D2 | Linux/Windows 和一种网络格式接入，JSON 投影与规则测试 | 配置 Vector 候选到 Kafka，案件库幂等消费 | 原生/自定义样本可查，基础成功/失败记录均保留 |
| D3 | 调优失败聚集规则、候选通道和保留策略 | 案件键、上下文查询、资产绑定、冻结证据包 | 正反例形成预期案件，无空身份误合并 |
| D4 | 验证失败后成功与原生网络告警链路 | API 结构化输出、校验、租约、版本和额度 | 至少一案真实 API 闭环，失败可待查 |
| D5 | 平台健康与原生查询视图、来源回归 | 简单研判页面、反馈、双优先级及链接 | 可演示证据、结论和人工核验 |
| D6 | 混合交错、格式/身份边界、断网/轮转/重启与压测 | API 评估、三个创新对照实验与联调 | 实测报告、失败清单和改进项 |
| D7 | 修复阻塞缺陷，冻结环境和规则 | 修复阻塞缺陷，交付手册与演示材料 | 他人按手册可重复演示 |

估算预算：平台与采集配置 18 人时，规则/字段适配 12，桥接与案件 16，资产/证据/API 20，页面 4，集成测试和交付 14，共约 84 人时。实际安装权限、网络、磁盘或样本缺失会影响该排期；D1 不能解决的依赖必须写进未完成项。

### 11.2 单人约 42 人时裁剪版

使用一个 Linux 认证源，完成 Wazuh 聚集告警、候选转发、资产 CSV、证据引用、API 研判和简单案件页。Windows、在线 Suricata、持续的失败后成功跟踪和四机优化拆分顺延。Kafka 已可用时复用；若尚未部署，第一阶段可使用原生 Indexer 有界增量查询进入同一个案件入口，明确其轮询时效，不为等待 Kafka 停掉整个闭环。

增量查询使用重叠时间窗、固定排序和持久查询位置，并以原生告警身份去重；需要翻页时完成当批分页后才推进边界。这条裁剪路径不是标准版的 Kafka 故障自动切换，也不和 Kafka 双路同时消费。

### 11.3 工期保护

D1 中央组件无法稳定运行时，先解决环境并降范围，不继续叠平台。D2 某个来源不能提供必要基础记录时，保留其接入未完成状态。D3 有界上下文查询不能稳定关联时，先交付聚集告警加人工触发调查，不宣称已完成失败后成功监测。D5 仍未贯通时停止增加新规则和可选组件，优先修复完整链路。

## 12 验收与性能口径

### 12.1 功能验收

标准版三个场景各至少五个正例、五个反例，共至少 30 个场景；另测缺字段、未知资产、重复候选、跨账号/Agent 分组、索引迟到和乱序。分开标注 expected_signal、expected_case、expected_verdict，不能要求规则从连接或认证统计中自动推断业务授权。

| 项目 | 完成条件 |
|---|---|
| 接入 | Linux、Windows、一种网络格式均有已验证路径；持续接入与回放分开记录 |
| 混合与自定义输入 | 交错输入和分开输入结果一致；同源 JSON 投影满足既定语义规则，中转身份不混成实际目标 |
| 必要背景 | 失败与成功基础认证记录都可查，或缺口被明确阻止自动下结论 |
| 聚集规则 | 阈值、账号、来源和 Agent 边界均符合预期 |
| 失败后成功 | 同对象的新成功证据进入同案；无新增不反复调用 API；跟踪额度溢出可见 |
| 网络告警 | 指定设备事件类/签名可建案，厂商版本、原严重性、事件代码与资产方向不混淆 |
| 幂等 | 同一已生成候选的 Kafka 重投递不重复建案或调用 |
| 证据 | 引用属于本次冻结包，原始索引身份和固化证据可核验 |
| 资产 | 已知/未知/有效期/冲突测试符合预期，标签不替代攻击事实 |
| API | 至少十案真实调用成功；模拟结果与真实结果分列，失败计入报告 |
| 恢复 | 文件轮转、Vector 重启、Kafka 中断、worker 租约过期都有测试记录 |
| 版本 | 迟到旧结果不能覆盖新 revision；队列和额度限制可见 |

### 12.2 性能目标

先用选定日志组成 **100 EPS** 的功能基线，再尝试 **500 EPS 连续 30 分钟**。这两个速率指送入 Wazuh 的范围内日志，不是 Python 收到的候选告警速率；同时报告原生接收、规则输出、实际索引、候选、案件和 API 尝试速率。

本地初始告警 p95 不超过五秒作为待测目标，从最后一条必要事件进入采集链路至原生告警可见；窗口本身的观察时间另计。失败后成功默认十秒检查一次，目标为成功记录可查询后十五秒内更新案件；该目标限跟踪额度内，超限不计为已完成实时关联。

API 分开测排队、检索、供应商响应和校验。额度内、约定到达负载下 p95 六十秒为待测目标，超时、缺证据和配额阻塞全部进入完成率和待查率统计，不删掉失败后只计算成功请求。

随后按 1,000、5,000、10,000 EPS 做短时递增测试，依据温度、磁盘和积压停止。测试 Kafka 或 Vector 的峰值不能代表 Wazuh 索引和完整调查吞吐。Agent、Manager、Indexer 和 Vector 的丢弃/错误指标必须同时记录；本项目不承诺逐条原始输入都产生一个告警。

### 12.3 计数与故障验证

不同阶段记录输入唯一数、投递尝试、解析失败、采集丢弃、规则输出、候选通过/排除、积压和持久化成功数。原始事件与告警不是一一对应，不使用 v1 的 raw=normalized+quarantine 公式对整个 Wazuh 管线做错误对账。

对于 Vector 已读取的告警，按候选通过、规则排除、解析错误和待处理统计；对于 Kafka 已送达的唯一候选，按已持久案件输入和消费积压核对。原始回放清单及平台指标用于检查接入覆盖，不能只看到 Dashboard 有几条告警就断言没有丢数据。

原生组件未暴露的阶段计数标为 unavailable，使用受控回放和源端清单补充验证；不把缺少指标写成零错误或零丢弃。未知格式、截断及未解码数据能否被观察，也作为 D2 的样本核对项目。

故障至少包括：Kafka 断开后缓冲及告警文件仍可用；文件轮转和 Vector 重启；候选比索引先到；API 非法输出与引用越界；API 处理中证据修订；worker 租约过期；当日额度耗尽；原生检测引擎重启后的 warming_up；源端或索引证据过期。

### 12.4 资源与费用测算

若原始范围为 1 万 EPS、平均每条 1 KB，原始体量约 36 GB/小时。即使不调用模型，采集、解析和索引仍有实际成本。开源组件减少开发量，不会消除全量处理成本。

作为消息量示例，候选若为 10 EPS、每条 4 KB，Kafka 约 144 MB/小时；这是计算示例，不是预先保证的过滤比例。发生告警风暴时必须按实际候选速率调整留存、案件聚合和调查预算，不能偷偷丢掉关键输入来维持漂亮的吞吐。

费用按实际输入/输出 token 及供应商单价计算，重试单列。所有“减少误报”“节省 token”的结果都要给出基线、样本量和未完成案件。未发现的攻击属于后续评估问题，不能因规则没有命中就归类为正常。

## 13 实施交付物与冻结要求

后续实施应交付：组件/依赖版本清单、脱敏配置及字段映射、少量本地规则、Vector 拓扑配置、资产模板、一个研判服务、场景及预期标签、操作手册、实测与对照报告、已知缺口和十分钟演示流程。本次不提供这些项目的具体实现代码。

只配置或调用组件公开接口，不维护 Wazuh/Vector 私有分支。D1 对照实际安装版本冻结中央组件、Agent、规则集、Vector、Kafka 和 Python 依赖；规则 ID 与字段按已安装版本和样本确认，不从旧博客直接照搬。引用论文保留来源与改动说明，不把工程取舍描述为论文复现。

最终完成条件：另一名成员能够按手册启动约定环境，运行样本，看到原生告警、同案证据、真实 API 结果和人工反馈，并复现至少一次失败/恢复。未完成的接入、性能或关联能力明确标注。

## 14 核查来源

以下官方文档与论文用于能力、接口和架构参考，核查日期为 2026-10-19；不构成本项目实测证明。

1. [Wazuh Quickstart](https://documentation.wazuh.com/current/quickstart.html)：集中部署、硬件与系统要求。
2. [Wazuh 数据分析](https://documentation.wazuh.com/current/user-manual/ruleset/)：内置解码、规则及本地扩展。
3. [Wazuh 规则语法](https://documentation.wazuh.com/current/user-manual/ruleset/ruleset-xml-syntax/rules.html)：频率、窗口和关联条件。
4. [Wazuh 规则测试](https://documentation.wazuh.com/current/user-manual/ruleset/testing.html)：原生测试工具与会话。
5. [Wazuh 告警管理](https://documentation.wazuh.com/current/user-manual/manager/alert-management.html)：记录阈值及默认索引链路。
6. [Wazuh 事件记录](https://documentation.wazuh.com/current/user-manual/manager/event-logging.html)：全量事件与告警记录的区别。
7. [Wazuh 与 Suricata 集成](https://documentation.wazuh.com/current/proof-of-concept-guide/integrate-network-ids-suricata.html)：已有 EVE 接入路径。
8. [Wazuh Indexer API 示例](https://documentation.wazuh.com/current/user-manual/indexer-api/use-case.html)：告警检索接口。
9. [Vector 文件源](https://vector.dev/docs/reference/configuration/sources/file/)、[Kafka sink](https://vector.dev/docs/reference/configuration/sinks/kafka/)、[缓冲模型](https://vector.dev/docs/architecture/buffering-model/)：文件状态、转发及背压。
10. [Vector filter](https://vector.dev/docs/reference/configuration/transforms/filter/)、[remap](https://vector.dev/docs/reference/configuration/transforms/remap/)、[throttle](https://vector.dev/docs/reference/configuration/transforms/throttle/)：选择、字段映射及丢弃语义。
11. [Wazuh LLM 告警增强 PoC](https://documentation.wazuh.com/current/proof-of-concept-guide/leveraging-llms-for-alert-enrichment.html)：外部模型集成实践参考。
12. [CORTEX 原文](https://arxiv.org/abs/2510.00311)：证据驱动、可审计的安全告警研判研究参考。
13. [Sigma 关联说明](https://sigmahq.io/docs/meta/correlations)：关联表达与后端支持边界。
14. [Wazuh JSON decoder](https://documentation.wazuh.com/current/user-manual/ruleset/decoders/json-decoder.html)、[自定义 decoder](https://documentation.wazuh.com/current/user-manual/ruleset/decoders/custom.html)：自定义字段、解码限制与规则适配。
15. [Wazuh 日志接入](https://documentation.wazuh.com/current/user-manual/capabilities/log-data-collection/index.html)：主机、网络设备与集中日志接入。
16. [Vector VRL 函数](https://vector.dev/docs/reference/vrl/functions/)、[Kafka source](https://vector.dev/docs/reference/configuration/sources/kafka/)、[文件 sink](https://vector.dev/docs/reference/configuration/sinks/file/)：既有混合数据的解析与输入投影。
