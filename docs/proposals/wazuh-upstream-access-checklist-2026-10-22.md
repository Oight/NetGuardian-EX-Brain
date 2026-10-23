# Wazuh 上游模块与 API 接入清单

日期：2026-10-22。状态：官方文档核对稿与接入建议，待运行账号验收；不替代 v4.2，不表示已启用、已部署或已完成端到端验证。

本稿初次编写时根据用户要求查阅 Wazuh 官方文档，并与 [2026-10-21 环境核实](../current/wazuh-capability-assessment-2026-10-21.md) 对照；该阶段仅查询公开资料与整理本地文档。随后 [旧凭据重试](../reference-index.md#source-25) 未通过。用户分别提供专用身份后，[Server 独立认证及单机资源抽样成功](../reference-index.md#source-23)，[Indexer 告警、归档及聚合读取成功](../reference-index.md#source-24)，均不经过面板；Indexer 根信息、漏洞及两类清单状态请求为 403，严格 TLS、最小权限与分页等仍待验收。没有调用模型或改变上游配置。上游仍采用既定 Wazuh，不新增选型；下列配置项是维护者需要确认的条件，缺项先在客户端登记限制。

[当前设计基线](../current/security-triage-client-design-v4.md) · [实验与验收计划](../current/security-triage-client-experiments-v4.md) · [统一文档入口](../README.md)

## 1. 结论与采用范围

建议将接入要求分为三层：

| 层次 | 接入条件 | 项目含义 |
|---|---|---|
| 基础必需 | 已采集的告警可检索；受控 Indexer 查询入口、受限身份、证书信任、范围与分页约定 | 支持告警收件箱、提醒、建案、相关告警调查和告警统计 |
| 首个完整调查用例建议 | 基础认证事件可查询；Syscollector 基础清单可查询；选定目录的 FIM 变化可查询；建议通过 Server API 提供设备状态和清单 | 展示“认证异常 → 检查后续成功 → 补查主机背景/文件变化”的按证据分支过程；这些不是所有 P0 演示的隐含前提 |
| 条件增强 | 漏洞发现、SCA、已采集的 Sysmon/审计事件、连接状态历史；网络安全设备材料按既定用例单列 | 取得相应数据、权限和验收依据后再开放工具或图表 |

严格的告警最小闭环可以只使用 Indexer；若设备状态、清单、FIM 对象背景或 SCA 采用下述 Server API 路径，则相应 Server API 授权成为该能力的接入条件。不能以“已开放一个 API”概括整个接入。

## 2. 模块、数据路径与现有证据

下表“文档条件”来自公开资料，“已有观察”只描述 10 月 21 日管理员快照，“本项目建议”是待实施取舍。10 月 22 日独立接入结果另列于本文入口及维护记录。文档默认值不能代替实际配置核实。

| 能力 | 文档条件与数据路径 | 已有观察 | 本项目建议 |
|---|---|---|---|
| 告警与等级 | Manager 规则分析产生告警，告警经 Filebeat 进入 Indexer；读取告警索引。[告警管理](https://documentation.wazuh.com/current/user-manual/manager/alert-management.html) | 告警索引有数据，原生规则、等级、设备和时间字段可读 | 基础必需；确认 JSON 告警输出、现有转发、实际索引名和留存范围 |
| 认证与普通事件 | Logcollector 收集相应日志；Linux 按实际来源选择日志文件或 journald；Windows 使用实际事件频道。[跨系统日志采集](https://documentation.wazuh.com/current/user-manual/capabilities/log-data-collection/configuration.html)、[journald](https://documentation.wazuh.com/current/user-manual/capabilities/log-data-collection/journald.html) | 有 sshd/PAM、Windows 认证材料；部分失败事件在当时查询范围内为零 | 选定演示系统后确认成功、失败事件与身份字段；只查询实际已采集内容 |
| 可检索归档 | Manager 的 `logall_json` 保存 JSON 归档；Filebeat 的 `archives.enabled` 将归档送入索引。[事件归档](https://documentation.wazuh.com/current/user-manual/manager/event-logging.html) | `wazuh-archives-4.x-*` 已可查询，包含大量非告警记录 | 认证背景用例优先复用现有归档；确认留存和权限，不能把本地归档文件视为可检索索引 |
| 设备基础信息 | 已登记 Agent 的身份、连接状态通过 Server API 查询；Agent 名单不代表业务服务健康。[Server API RBAC](https://documentation.wazuh.com/current/user-manual/api/rbac/reference.html) | `/agents` 可读，含 Manager 及 Linux/Windows Agent | 设备选择和在线状态采用获准设备视图；单列 Manager，保留未知状态 |
| 系统与软件清单 | Agent 的 Syscollector 采集；Manager 接收。若采用状态索引，还涉及 Inventory Harvester 与 indexer connector。[清单配置](https://documentation.wazuh.com/current/user-manual/capabilities/system-inventory/configuration.html) | OS、软件、进程、端口等已有材料；软件状态索引为空但 Server API 有数据 | 优先验证 Server API 清单路径；按类别固定主来源，保留扫描时间 |
| FIM | Agent 的 `syscheck` 启用并覆盖指定文件/目录；变化事件通过告警/归档读取，对象资料可通过 Server API 读取。[FIM 配置](https://documentation.wazuh.com/current/user-manual/capabilities/file-integrity/how-to-configure-fim.html) | 有变化记录，也有 `/syscheck/{agent_id}` 对象资料 | 展示 FIM 时确认监控目录和变化样例；对象状态与变化历史分别返回 |
| 漏洞发现 | Syscollector 提供系统/软件背景；Manager 的 `vulnerability-detection`、状态索引及 indexer connector 工作，漏洞情报可用。[漏洞配置](https://documentation.wazuh.com/current/user-manual/capabilities/vulnerability-detection/configuring-scans.html) | 漏洞状态索引已有发现记录 | 条件增强，先复用已有发现；展示发现时间，不解释为已利用 |
| SCA | Agent 的 `sca` 和适用策略产生检查结果，通过 Server API 读取。[SCA 配置](https://documentation.wazuh.com/current/user-manual/capabilities/sec-config-assessment/how-to-configure.html)、[SCA 参数](https://documentation.wazuh.com/current/user-manual/reference/ossec-conf/sca.html) | Linux 抽样策略与检查明细可读 | 条件增强；读取已产生结果，记录策略和扫描时间 |
| 历史行为事件 | 需要相应日志源实际产生事件，并被 Logcollector 收集、解码、索引。[Windows 频道](https://documentation.wazuh.com/current/user-manual/capabilities/log-data-collection/configuration.html) | 已见部分 Sysmon 组记录，具体事件覆盖未逐项验证 | 仅公布已验证事件类型；不由进程清单推导完整进程历史 |
| 网络安全设备 | 设备日志送达、解码和检索必须分别成立。文档给出 Syslog 和 Suricata 文件采集路径。[remote](https://documentation.wazuh.com/current/user-manual/reference/ossec-conf/remote.html)、[Suricata 示例](https://documentation.wazuh.com/current/proof-of-concept-guide/integrate-network-ids-suricata.html) | 未识别到可确认的防火墙/IDS/WAF 来源 | 保留缺口；本稿不新增来源或部署要求，后续选定场景另行登记 |

### 2.1 归档需要分成两项确认

需要非告警事件时，维护者确认：Manager 已保存 JSON 归档，且转发链路已使其进入客户端获准查询的归档索引。只有 `logall_json=yes` 不证明索引已可用；只有文本 `logall=yes` 也不能替代 JSON 归档索引链路。Dashboard 的归档 index pattern 服务于面板浏览，客户端直接查询已存在索引时无需为自己的界面新建该 pattern。[官方归档说明](https://documentation.wazuh.com/current/user-manual/manager/event-logging.html)

已有告警与归档可能记录同一行为。分别保存源引用，再按已验证的事件身份关联，不能把两边数量相加当作独立行为数；已有环境核实仅证明过一个重叠样本。

### 2.2 清单与历史事件分别提供

Syscollector 文档示例使用周期扫描，端口采集示例的 `all="no"` 只包含监听端口。本项目据此把它设计为带来源时间的快照。Windows Sysmon、Linux 审计等已采集事件才可能提供相应历史行为；各自覆盖需要另外验收。[Syscollector 配置](https://documentation.wazuh.com/current/user-manual/capabilities/system-inventory/configuration.html)

状态索引路径需要确认 Manager 的 Inventory Harvester/indexer connector；Server API 路径和状态索引路径的数据完整性、字段及更新时间分别核实。状态索引为空时，先核对已选清单来源，不能据此要求重新启用整个模块。

### 2.3 FIM 的增强项单列

基础 FIM 用例只要求指定范围的文件变化及可追溯属性。实时监控、`whodata`、`report_changes` 是分别配置的能力；不能因为存在 FIM 记录就宣布有修改者身份或差异正文。首个用例不要求任意远端文件读取。[syscheck 参数](https://documentation.wazuh.com/current/user-manual/reference/ossec-conf/syscheck.html)

### 2.4 两种等级阈值分别记录

Wazuh 的 `log_alert_level` 控制告警输出门槛；客户端的自动调查阈值只筛选已经可查询的告警。调低客户端阈值不能恢复上游未输出的告警，也不会补采历史事件。客户端应显示已知上游门槛，未知时明确标记。[告警阈值](https://documentation.wazuh.com/current/user-manual/manager/alert-management.html)

### 2.5 维护者检查的具体配置项

下表用于核对现有配置；只有所选用例确实需要且当前缺失时，才形成相应配置变更建议，不要求重写完整配置文件。

| 所在位置 | 配置项 / 期望条件 | 对应能力 |
|---|---|---|
| Manager | `global/jsonout_output=yes`，现有 Filebeat 告警转发正常 | JSON 告警进入索引；文本 `alerts.log` 不是本客户端额外依赖 |
| Manager + Filebeat | `global/logall_json=yes`，Filebeat `archives.enabled=true`，归档索引可读 | 普通事件背景 |
| Agent | `wodle name="syscollector"` 中 `disabled=no`；确认所需 `os`、`packages`、`processes`、`ports` 等类别和周期 | 清单快照 |
| Manager | 采用清单状态索引时确认 Inventory Harvester 与 `indexer/enabled=yes`、连接和同步 | 清单进入 Indexer；采用 Server API 时分别核实其数据 |
| Agent | `syscheck/disabled=no`，`directories` 覆盖用例范围，确认扫描/实时模式 | FIM 变化；增强项按 2.3 单列 |
| Manager | `vulnerability-detection/enabled=yes`、`index-status=yes`、indexer connector 正常、情报可用 | 漏洞状态数据 |
| Agent | `sca/enabled=yes`，所需策略存在且启用，确认实际调度 | SCA 结果 |
| Agent / 日志产生端 | 确认所需 `localfile` 文件/频道、`log_format`、筛选条件及事件实际产生 | 认证和历史行为；Sysmon 等按用例选择 |

配置名称见前述各模块文档；JSON 告警开关另见 [global 参数](https://documentation.wazuh.com/current/user-manual/reference/ossec-conf/global.html)。API 接入主要是现有服务的入口、TLS、身份及权限约定，各功能数据还依赖对应模块产出；给账号增加 API 权限不会补出尚未采集的数据。

## 3. API 清单

Indexer API 与 Server API 使用不同的授权体系。默认 HTTPS 端口分别为 9200、55000；交付时填写维护者实际提供的受控入口及 CA，而不是要求把默认端口直接暴露到公网。Dashboard 的 443 是网页入口，能登录面板不能证明客户端已经获得下列两类 API 的权限。[架构与端口](https://documentation.wazuh.com/current/getting-started/architecture.html)

本轮用户进一步明确客户端采用独立 API 接入：本应用不安装或嵌入 Wazuh Dashboard 组件，不把面板登录、cookie、内部代理或通过面板取得的临时 token 作为正式运行依赖。客户端分别建立 Indexer 查询身份和 Server API 认证流程，直接通过维护者提供的相应入口读取数据。上游是否保留 Dashboard 作为运维工具单独决定，本次没有要求移除已有组件。

10 月 21 日观察应表述为“管理员借助 Dashboard 已读到相应数据”。10 月 22 日更换两类专用身份后，Server 已通过独立认证及单机资源抽样，Indexer 已通过告警/归档查询和聚合；其余条件继续按实际入口、运行身份和证书验收，包括分页、token 失效后重新认证及权限范围核对。

### 3.1 Indexer：告警、归档、状态查询

以下索引模式来自文档和已有环境，实际模式写入版本化连接配置。查询体由客户端根据受控业务参数构建，模型不直接提交任意 DSL。

| 操作 | 路径 | 启用条件 / 用途 |
|---|---|---|
| 告警查询及聚合 | `POST /wazuh-alerts-4.x-*/_search` | 基础必需；过滤、排序、分页、等级分布和设备分布 |
| 原记录回查 | `GET /{approved-index}/_doc/{document-id}` | 使用该读取方式时验收；只允许已获准索引和记录，也可使用受控搜索回查 |
| 普通事件查询 | `POST /wazuh-archives-4.x-*/_search` | 归档能力可用时；认证背景、FIM/审计补证 |
| 漏洞发现 | `POST /wazuh-states-vulnerabilities-*/_search` | 漏洞工具启用时 |
| 系统清单 | `POST /wazuh-states-inventory-{category}-*/_search` | 选用该清单路径时；category 是配置白名单，不是模型自选索引 |
| 设备连接状态历史 | `POST /wazuh-monitoring-*/_search` | 可选图表；需确认该索引已有历史和授权 |

告警 `_search` 与聚合见 [Indexer 用例](https://documentation.wazuh.com/current/user-manual/indexer-api/use-case.html)；原记录等接口类别见 [Indexer API 参考](https://documentation.wazuh.com/current/user-manual/indexer-api/reference.html)，按 ID 读取的路径另见 [OpenSearch 2.19 Get Document](https://docs.opensearch.org/2.19/api-reference/document-apis/get-documents/)；状态索引见 [清单查询](https://documentation.wazuh.com/current/user-manual/capabilities/system-inventory/viewing-system-inventory-data.html)、[漏洞数据](https://documentation.wazuh.com/current/user-manual/capabilities/vulnerability-detection/how-it-works.html)；连接状态历史见 [索引说明](https://documentation.wazuh.com/current/user-manual/wazuh-indexer/wazuh-indexer-indices.html)。

现有环境的查询引擎观察为 OpenSearch 2.19.6。分页候选可参照 [OpenSearch 2.19 分页文档](https://docs.opensearch.org/2.19/search-plugins/searching-data/paginate/)，但具体排序字段、分页方式、权限和迟到记录处理尚待实测。使用 PIT/scroll 等机制时另外记录所需权限和资源释放，不把它们假定为普通搜索权限的一部分；只读查询不等于所有请求都必须使用 GET。

### 3.2 Server API：设备、清单、FIM 对象与 SCA

下列路径通过 Wazuh 官方仓库 **v4.14.9 标签的 [OpenAPI 定义](https://github.com/wazuh/wazuh/blob/v4.14.9/api/api/spec/spec.yaml)** 交叉核对。它们是待适配接口清单，不能替代运行环境验收。

| 功能 | 方法与路径 | 采用范围 |
|---|---|---|
| 取得 API token | `POST /security/user/authenticate` | 使用获准 Server API 身份，后续请求携带 Bearer token |
| 设备列表与详情筛选 | `GET /agents` | 设备选择、身份、状态和基本平台信息 |
| 状态汇总 | `GET /agents/summary/status` | 可选；确认受限主体下的统计口径，也可从已获设备列表汇总 |
| OS / 硬件 | `GET /syscollector/{agent_id}/os`、`GET /syscollector/{agent_id}/hardware` | 已选清单类别 |
| 软件 / 进程 / 端口 | `GET /syscollector/{agent_id}/packages`、`GET /syscollector/{agent_id}/processes`、`GET /syscollector/{agent_id}/ports` | 按需提供快照及来源时间 |
| 网卡与地址 | `GET /syscollector/{agent_id}/netiface`、`GET /syscollector/{agent_id}/netaddr` | 可选设备背景 |
| FIM 对象资料与最近扫描 | `GET /syscheck/{agent_id}`、`GET /syscheck/{agent_id}/last_scan` | 对象背景；变化时间线仍查询实际事件 |
| SCA 策略及检查 | `GET /sca/{agent_id}`、`GET /sca/{agent_id}/checks/{policy_id}` | 已有检查结果及依据 |

认证机制见 [Server API 入门](https://documentation.wazuh.com/current/user-manual/api/getting-started.html)。设备、清单和检查接口按实际版本使用其过滤、排序、返回字段和分页参数；适配层检查业务错误及局部失败，HTTP 200 不能单独代表全量成功。JWT 失效后按已核实流程重新认证，不假定面板凭据或 Server token 能用于 Indexer。

### 3.3 运行账号建议权限

| 范围 | 申请内容 | 限定方式 |
|---|---|---|
| Indexer | 选定告警索引的 `read`；归档、漏洞、清单、monitoring 分别按使用能力增加读取范围 | 明确索引模式，按需要使用文档级权限限制可见设备；不能只靠客户端隐藏 |
| Server 设备 | `agent:read` | 选定 `agent:id` / `agent:group` 资源 |
| Server 清单 | `syscollector:read` | 同上，仅在清单接口启用时 |
| Server FIM 对象 | `syscheck:read` | 同上，仅在对象背景接口启用时 |
| Server SCA | `sca:read` | 同上，仅在 SCA 工具启用时 |

权限名称与资源映射来自 [Server RBAC 参考](https://documentation.wazuh.com/current/user-manual/api/rbac/reference.html)；Indexer 的索引读取和文档级限制参考 [角色配置说明](https://documentation.wazuh.com/current/user-manual/user-administration/rbac.html)。Index/Server 权限分别验收。各索引族的设备字段和标签覆盖可能不同，文档级过滤必须逐类验证，不能照搬告警索引示例到所有状态索引。

项目运行账号不需要 Active Response、远程命令、临时扫描、重启、日志注入、规则修改、配置修改或账号管理能力。平台自身原有模块保持其既有管理策略；本项目不为取证工具申请上述操作权限，也不执行 SCA 结果中的检查命令或整改文本。

### 3.4 默认端口、认证与证书核对

| 项目 | 官方默认值或默认流程 | 实际测试仍需确认 |
|---|---|---|
| Indexer API | `https://<indexer-host>:9200`；HTTP Basic 默认启用，每次请求携带该侧账号密码；JWT 默认未启用 | 实际主机、端口、代理前缀、账号及读取权限 |
| Server API | `https://<manager-host>:55000`；使用 Basic 认证调用 `POST /security/user/authenticate`，随后携带 `Authorization: Bearer <token>` 查询 | 独立 Server API 身份、范围、token 失效处理 |
| Server JWT 有效期 | v4.14.9 OpenAPI 标注默认 900 秒，即 15 分钟 | 运维可能修改实际有效期 |
| Dashboard | HTTPS 443 网页入口 | 不作为本客户端 API 基础地址 |
| Indexer 监听地址 | 官方默认配置示例的 `network.host` 是 `127.0.0.1` | 安装方式或部署配置可能调整；确认客户端可访问的监听地址与网络路径 |
| Server API 监听地址 | 默认 `host: ['0.0.0.0', '::']`，HTTPS 启用 | 防火墙、容器端口映射或代理仍可能影响可达性 |

端口依据 [架构说明](https://documentation.wazuh.com/current/getting-started/architecture.html)，Indexer 认证依据 [API 入门](https://documentation.wazuh.com/current/user-manual/indexer-api/getting-started.html)，Server 认证依据 [API 入门](https://documentation.wazuh.com/current/user-manual/api/getting-started.html)，有效期依据 [v4.14.9 接口定义](https://github.com/wazuh/wazuh/blob/v4.14.9/api/api/spec/spec.yaml)。监听和 HTTPS 配置分别见 [Indexer API 配置](https://documentation.wazuh.com/current/user-manual/indexer-api/configuration.html) 与 [Server API 配置](https://documentation.wazuh.com/current/user-manual/api/configuration.html)。默认监听示例只能解释一种可能的连接限制，不能据此判定旧环境 9200 不可达的实际原因。

Indexer 安装助手文档使用 `admin` 管理账号，Server API 文档列出默认管理员 `wazuh`，另有面板通信账号 `wazuh-wui`；这些名称用于识别账号体系，不是客户端运行账号的固定要求。安装助手会生成随机密码，实际凭据由维护者提供。[Indexer 安装助手](https://documentation.wazuh.com/current/installation-guide/wazuh-indexer/installation-assistant.html)、[账号说明](https://documentation.wazuh.com/current/user-manual/user-administration/password-management.html)

Server API 默认启用 HTTPS，缺少证书时会生成自签名证书；Indexer 默认配置示例启用 HTTPS 并使用部署证书及根 CA。客户端应取得对应服务端证书的信任材料。标准账号认证流程不要求提供服务端私钥；客户端证书只在部署另有要求时配置。文档中的 `-k` 用于跳过证书校验，不作为产品默认配置。[Server API 证书说明](https://documentation.wazuh.com/current/user-manual/api/securing-api.html)、[Indexer API 配置](https://documentation.wazuh.com/current/user-manual/indexer-api/configuration.html)

## 4. 态势面板复用哪些数据

| 面板内容 | 数据来源 | 口径 |
|---|---|---|
| 告警趋势、等级分布、规则/设备排行 | 告警索引 `_search` 聚合 | 当前身份、设备范围与时间窗；说明 Top N 和是否完整 |
| 设备在线状态 | `/agents` 或已验证的汇总接口 | 连接状态，不等同于服务健康 |
| 系统、软件、端口背景 | 已选 Syscollector 来源 | 显示各类别来源时间；未知保留未知 |
| 漏洞与基线检查 | 漏洞状态索引、SCA API | 发现数、检查通过/失败等分别显示，不生成未经验证的综合风险分数 |
| 调查进度、等待回答、队列、预算 | 客户端本地业务记录 | 属于本项目任务数据，不向 Wazuh 寻找对应 API |
| 设备状态历史 | 已获准 `wazuh-monitoring-*` | 条件增强，需标明来源采样周期 |

告警排名可通过文档中的聚合查询实现；时间趋势参考 [OpenSearch 2.19 日期聚合](https://docs.opensearch.org/2.19/aggregations/bucket/date-histogram/)。常规态势页面可以复用同一批已获准读取接口，不需要为了本客户端开启 Dashboard 开发控制台、额外告警推送插件或新的写入 API。`wazuh-statistics-*` 属于平台性能统计，按需要另列，不是调查面板必需依赖。

`wazuh-monitoring-*` 的状态历史和 `wazuh-statistics-*` 的平台统计涉及 Dashboard 周期任务；若上游也不运行 Dashboard，不能假定这些索引继续产生数据。首版当前设备状态读取 `/agents`，告警趋势直接聚合告警索引，历史状态图在来源明确可用后再展示。[官方索引说明](https://documentation.wazuh.com/current/user-manual/wazuh-indexer/wazuh-indexer-indices.html)

## 5. 给客户端适配层的约定建议

建议每项能力分别保存：状态（可用、无权、不可达、不支持、未知）、实际来源、映射版本、设备范围、最近验证时间和限制。空结果不能单独证明模块禁用；成功返回也不能证明所有设备均已覆盖。

每次查询至少交付：

- 查询来源、实际设备与绝对时间范围、采用的时间字段及时区解释。
- 源记录身份、本地证据身份、观察/扫描时间、取得时间；缺失来源时间时保留未知。
- 返回条数、分页进度、截断、局部失败、超时及已完成范围。
- 当前运行账号的可见范围和该类来源的已知采集限制。

这些字段属于本项目适配契约建议，不是 Wazuh 原生响应字段承诺。工具只在对应能力验收后开放；协议和权限事实表中的待验证项不写成可用。

学校部门、设备业务用途、维护授权、制度文档、人工意见和本应用历史案件仍由客户端资料服务或其他获准信息源提供。Wazuh Agent/清单可以提供关联身份，但不能代替这些业务背景。

## 6. 交给上游维护者确认的接入表

| 编号 | 需要交付或确认的事项 | 当前依据 / 待补内容 |
|---|---|---|
| U1 | Manager、Agent、Indexer 的实际版本及连接方式 | Manager/插件曾观察为 4.14.9；引擎节点曾观察为 2.19.6；本次没有复核在线版本 |
| U2 | Indexer 的受控入口、认证方式与 CA | 新文件指定的完整 HTTPS 入口和专用身份已通过告警/归档/聚合读取；根信息和部分增强索引请求为 403，严格证书信任仍待落实 |
| U3 | Server API 的运行身份、可见 Agent 和 token 失效流程 | 用户提供专用身份后，55000 独立认证及单机资源抽样成功；最小权限、完整设备范围和 token 失效流程待验收 |
| U4 | 告警/归档/状态索引的实际名称、字段映射、留存及设备权限 | 新 Indexer 身份已读取告警与归档元数据并完成一次聚合；漏洞及两类清单状态请求 403，完整覆盖与设备权限待验收 |
| U5 | 所选认证来源及成功/失败事件的可追溯样例 | 已见成功材料；失败样例、身份关联和完整性仍需受控用例 |
| U6 | Syscollector 各类别的主查询路径及时间语义 | 软件 API 与状态索引曾不一致，先确定主来源 |
| U7 | FIM 已监控范围、已有变化样例及增强项状态 | 不假定已提供差异正文或可靠修改者身份 |
| U8 | 漏洞情报/索引新鲜度、SCA 策略与扫描时间 | Server 身份已读 SCA 策略/明细；当前 Indexer 漏洞请求 403，需取得该侧读取条件后再开放漏洞工具 |
| U9 | 稳定分页、排序与迟到事件处理依据 | 文档提供机制；现有环境尚无连续无遗漏查询证明 |
| U10 | 网络安全设备来源的实际状态 | 继续标未验证；来源建设不由本清单自动启动 |

U2/U3 的入口和专用身份均已取得基础业务读取依据，可以分别开展 Indexer 和 Server 适配开发；继续补齐 U4、严格 TLS、分页与权限/失效验证。清单已有 Server 路径，不因对应状态索引 403 自动申请额外权限。其他项按选定调查用例补齐，不要求一次启用所有 Wazuh 能力。

## 7. 第一条真实接入验收建议

选定一个获准设备、一个短时间窗和一项明确问题，由维护者提供可复核参考材料：

1. 运行账号可查该设备告警及其源记录，范围外的已知测试设备在相同索引/API 上不可读；测试对象须明确获准。
2. 认证工具分别取得预期成功、失败或缺权结果，保留账号命名空间、来源、时间和查询覆盖。
3. 清单工具返回某一类别的实际快照与来源时间；FIM 工具在声明范围内取得变化事件。
4. 复现零匹配、无权、分页中断和来源时间未知，客户端显示各自状态。
5. 在相同获准范围运行趋势与分布查询，数字能够追溯到相同统计口径。

这是待执行的上游接入验收，不要求同时调用模型；随后再验证真实模型经 MCP 读取这些材料并据此改变后续查询。只完成接口验收时，不标记完整调查闭环通过。

## 8. 版本与文档维护记录

- 后续经用户本轮明确授权重试独立 API，9200/55000 均在无认证连接阶段遇到本地 `WinError 10013`，提权执行申请又被当前审批策略拒绝。该结果不属于远端端口或账号验收；详见 [2026-10-22 检查记录](../reference-index.md#source-28)。本稿其他“已有观察”仍指 10 月 21 日快照。
- 用户随后临时启用 full access 并要求继续测试，已获得 [实际连接及认证结果](../reference-index.md#source-25)：9200 为连接拒绝，55000 认证 401，指定账号未通过独立 API 接入验收；平台配置未改动。
- 用户再提供独立 Server 账号，[标准认证及设备/单机资源读取通过](../reference-index.md#source-23)，13 次请求尝试，仅向 Server 发送该侧凭据；采用精确目标证书例外，没有重测 Indexer。该结果更新 Server 接入状态，不覆盖旧凭据的失败记录。
- 用户再提供 Indexer 专用账号，使用文件完整入口的 [告警、归档、单条投影和 24 小时聚合通过](../reference-index.md#source-24)；共 11 次请求尝试，仅向 Indexer 发送该侧凭据。根信息、漏洞和两类清单状态请求为 403；没有修改角色或索引权限。
- 官方 `current` 文档是滚动内容；访问日期为 2026-10-22。尝试访问部分 `/4.14/` 页面时，本次浏览工具未能读取，不能据此认定页面不存在。因此本文将模块说明标为当前公开文档条件，Server API 路径另用 v4.14.9 标签定义交叉核对。部署前还需核对实际安装版本。
- 10 月 21 日计数、接口成功与连通性仅引用既有报告；10 月 22 日新增连接/认证尝试单独留证，没有更新或覆盖旧快照。
- 本次新增本文件，并在 `docs/README.md` 增加导航。主设计、既有提案、原始归档、研究证据和迁移清单均未改写。
- 随后根据本轮用户澄清补记独立 API 接入约束，以及 Dashboard 周期任务产生的历史数据依赖；这项补记没有重新连接平台或执行配置变更。
- `docs/README.md` 是迁移时新增的统一导航，不在清单中带 `working_sha256` 的原始文档副本集合内。本次导航更新由本节记录，不修改 `migration/manifest.jsonl` 中的原件或快照哈希；新增核对稿不构成新的主设计版本。
- 本轮后续同步更新 `docs/project-status.md`、Wazuh 报告/脚本导航，并新增独立检查脚本及两次结果；迁移原件与既有三份 Wazuh 脚本保持不变。
