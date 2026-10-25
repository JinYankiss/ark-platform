# 官方依据 → 改写方式 → 实际实现

## 1. 先把“依据改写”说清楚

用户已经允许对没有公开源码的部分做**文档行为实现**和必要适配。因此没有把自有 TypeScript 队列/journal 宣称成某家的源码移植，也没有只复制接口就宣称实现了官方引擎。

| 核心模块 | 先读取的原型 | 本次类型 | 必需改动/区别 |
| --- | --- | --- | --- |
| `runner/model.ts` | O01–O05，官方流式/结构化示例与实际 SDK 源码 | 官方示例改写 | 非交互服务化、thread 绑定、AbortSignal、事件脱敏、Skill 文件、MCP grant；运行时只有 Codex SDK |
| `ingress/feishu.ts` | L01/L03 长连接/消息示例；Z01 Bot Channel | 示例改写 + 项目适配 | 选 WSClient，不开放自写 webhook；增加可信身份、幂等任务、通知存储、同卡片 patch |
| `core/task-service.ts` | D03 claim/deadline；D04 observed→claim/start/renew；G03 run/attempt | 文档行为实现 + 项目适配 | SQLite 本地原子 claim、fencing、生命周期与仲裁。没有移植 Rust Operator 或 Devin 服务端 |
| `workflow/context.ts` | G03 `step/pause/parallel/pipeline/phase`；D01 记录/重放 | 文档行为实现 | 自有 durable port，hash 和存储属于 Ark；默认失败传播，不复现上游所有 null/error 选项 |
| `workflow/definition.ts`、`runner/engine.ts` | A01/D01 程序依赖、A02 routing、O03 schema | 文档行为实现 + 表示适配 | 固定流程/Draft 使用可校验 DAG；不是官方脚本运行器。不在主服务 eval 生成代码 |
| `capabilities/catalog.ts` | M02/M03 唯一版本；A03/Z04 Skill；G04 来源限定工具集 | 文档行为实现 | Tool/Skill 精确 ref、hash、目录与执行策略分离；未移植 Go registry，未实现插件市场全部分发 |
| `capabilities/invocation.ts` | G08/G09 执行权限与发现的区别；Z06 工具前后/失败；O05 MCP timeout | 文档行为实现 + 网关适配 | HTTP/MCP 共用准入与调用 ledger；不伪造 Codex Hook API |
| `ingress/mcp.ts` | M04 SDK stateless HTTP 官方示例 | 官方示例改写 | 采用低层 Server 动态发布 JSON Schema，绑定节点 grant；协议由官方 SDK 处理 |
| `config/service.ts` | A06/G10 管理配置；D07 启动/唤醒解析 | 文档行为实现 + 项目适配 | Ark HTTP 发布/读取与不可覆盖版本；完整业务线配置，不声称照搬上游多团队合并算法 |
| `observability/tracing.ts` | G07/A05 trace；T01 OTel 官方包示例 | 官方示例改写 | 显式 parent、手动 span、可选 OTLP；不采集 prompt/密钥/工具正文 |
| `storage/database.ts`、`ingress/http.ts` | D03 远程控制、游标；M03 事务与唯一约束 | 项目集成适配 | Ark 的存储/API/认证与 SSE；上游没有这些同名 API |

**本次没有逐行移植四家私有 Workflow 引擎。** 原型、commit、许可证和请求失败记录见 01；示例改动与许可见根目录 `THIRD_PARTY_NOTICES.md`。

## 2. 原矩阵 71 项的实际落点

“本地”表示有实现及离线验证，不表示已接通真实企业账号；“部分”表示刻意保留的范围/证据缺口；“无指标”不靠生成数据填补。

### 运行时 R01–R24

| 项 | 实际文件/符号 | 当前结果与证据 |
| --- | --- | --- |
| R01 | `ingress/http.ts` Credential；`ingress/feishu.ts` FeishuBinding | 本地：业务线来自凭据/租户绑定，正文不能覆盖；不是企业 SSO |
| R02 | `FeishuBot.start`、`FeishuIngress.accept` | 部分：官方 WSClient/EventDispatcher，文本事件筛选；身份/重复消息离线测过，未登录真实飞书 |
| R03 | `FeishuBot` 构造器 | 部分：配置不完整启动失败，鉴权用官方长连接；不声称测试过 webhook 签名/加密，因为本实现未开放 webhook |
| R04 | `TaskService.submit`、`FeishuIngress.accept` | 本地：任务入库不等待模型；唯一消息/提交键冲突校验；通知队列持久化 |
| R05 | `ArkServer`、`TaskService.claim` | 本地：服务只保存控制状态；模型循环在独立 Runner |
| R06 | `Runner.run`、`runGraph` | 本地：每 Runner 一任务、每任务配置节点并发；暂无集群容量/公平性/优先级调度 |
| R07 | `Database.transaction`、`TaskService.fenced` | 本地：BEGIN IMMEDIATE + lease token；两个真实进程竞争测试只有一个启动 |
| R08 | `TaskService.claim`、`Runner.execute` | 本地：过期回收、自动回收尝试上限（默认 3）、旧拥有者写入被拒；真实进程 kill 测试 |
| R09 | `runner/worker.ts`、`runner/client.ts` | 本地：跨 HTTP、独立 CLI 进程、关闭时 abort/settle；非 Kubernetes Worker 管理器 |
| R10 | `CodexModel.runTurn`、`Runner.execute` | 部分：独立任务目录/CODEX_HOME/白名单 env/read-only 默认；不是 OS 隔离或容器证明 |
| R11 | `CodexModel` / `DemoModel` | 部分：真实 SDK 类型和调用入口、测试 factory 替身；没有真实 API 请求证据 |
| R12 | `record(thread.started)`、`resumeThread` | 本地：未完成只读 turn 保存并恢复 thread；依赖相同工作盘；write-tool turn 拒绝盲续跑 |
| R13 | `ingress/mcp.ts`、`ToolGateway.invoke` | 本地：官方 MCP Client 真正 list/call 网关，正确记录工具结果/失败；Codex 驱动 MCP 待 live 联调 |
| R14 | `TaskState`、`TaskService` | 本地：queued/running/paused/succeeded/failed/cancelled，attempt 与终态区分 |
| R15 | `storage/database.ts` | 本地：任务、journal、事件、配置、能力和 ledger 持久 SQLite；新连接加载验证 |
| R16 | `ArkServer.stream`、`FeishuBot.updateCard` | 部分：真实 SSE 测试；官方卡片 create/patch 类型接入，未真实飞书发送/限流联调 |
| R17 | `Database.events`、SSE Last-Event-ID | 本地：游标重连，事件键去重；SSE 断连不取消模型 |
| R18 | `observability/tracing.ts`、Task.traceparent | 部分：Runner→Ark/model 手动 span、任务/事件关联、内存 exporter 验证；无真实 Collector/飞书端到端 trace 证据 |
| R19 | `recordUsage`、`metrics`、`/usage` | 本地：模型 turn 计数去重，工具次数/时长；缺失 token 标记 partial/unknown，不估价 |
| R20 | `TaskService.cancel`、Runner heartbeat、SDK signal | 本地：HTTP 取消到执行方 signal，执行清理后确认终态；SDK 子进程依照官方契约，外部真实模型终止未实测 |
| R21 | `TaskService.finish` | 本地：取消先提交则取消胜出；成功先提交不回写取消；事务测试 |
| R22 | `ExecutionEngine` verify、`verification` 存储 | 本地：仅注册命令成功证据可提前终止；失败命令绝不成功；目标充分性由注册验证器负责 |
| R23 | `Paused`、`Runner.execute`、`resume` | 本地：审批暂停可恢复，取消不可恢复，超时是失败，不伪装成功 |
| R24 | `metrics.ts`、验证报告 | 无指标：未证明 1K+/日/97%；只有有口径的本地状态投影 |

### 编排 W01–W20

| 项 | 实际文件/符号 | 当前结果与证据 |
| --- | --- | --- |
| W01 | `ExecutionEngine.execute` direct 分支 | 本地：不生成 Draft，仍使用相同任务/预算/准入/journal |
| W02 | `DefinitionRegistry` | 本地：精确 `name@version`，发布不可覆盖，运行内嵌冻结定义 |
| W03 | `__draft`、`saveDefinition` | 本地：Codex outputSchema 生成受限计划，审批/工具能力执行前校验；Demo 计划明确离线 |
| W04 | TaskInput.mode + Feishu slash commands | 本地：可解释显式路由，不假装实现模型智能自动路由分类器 |
| W05 | WorkflowNode、definitionSchema | 本地：稳定节点/依赖/类型/输出 Schema；不是一个字符串冒充节点 |
| W06 | `parseDefinition`、`runGraph` | 本地：环/缺依赖/重复 ID/条件引用拒绝；**项目 DAG 表示适配** |
| W07 | `resolveInput`、依赖结果上下文 | 本地：下游接收已完成结果，不吞错误返回空成功 |
| W08 | `runGraph`、`WorkflowContext.parallel` | 本地：节点并发槽、结果对应、失败传播，收敛 sibling 后再结束 |
| W09 | `WorkflowContext.pipeline` | 本地：逐 item 推进，无全局 stage barrier，有先后顺序和并发测试 |
| W10 | `when`、可信程序库示例 | 部分：DAG 支持条件、**不支持 Draft 任意循环**；可信程序宿主可循环调用 step/pipeline，未作为第四条远程路径 |
| W11 | `outputSchema`、AJV | 本地：真 SDK 参数 + 返回校验；AJV 严于 G03 子集，不声称语义完全一致 |
| W12 | config.limits、`modelStart` | 本地：每图并发与全任务总调用预留分开；恢复不清预算 |
| W13 | `checkpoint`、`WorkflowContext.step` | 本地：输入 hash/结果/thread 持久；completed 不可被替换 |
| W14 | `hash`、step 输入、冻结定义/配置 | 本地：稳定 key+输入 hash 冲突；可信扩展 producer 仍须避免非确定性控制流 |
| W15 | 重开存储/失败恢复测试 | 本地：完成步骤不重跑；未完成读步骤重试；未知写副作用阻断 |
| W16 | `DefinitionRegistry.get`、task.definition | 本地：hash/精确版本快照；不跟随新版本漂移 |
| W17 | `pause`、`approve`、`resume` | 本地：先到达审批点才能批准，恢复复用完成步骤；审批不自动唤醒 |
| W18 | `activeMs`、`modelCalls`、`outputTokens` | 本地：暂停间隔不计 active，故障租约补记，输出预算是 turn 后软上限，不是硬费用封顶 |
| W19 | invocation ledger、write-tool turn 保护 | 部分：本地建单事务幂等、不明状态拒绝重跑；无远端 Jira/代码提交 exactly-once 保证/自动对账 UI |
| W20 | ArkServer→Runner→ModelAdapter | 本地：规划和执行不在 HTTP handler 调模型；没有不受控第二条模型链路 |

### 能力 C01–C20 与配置 F01–F07

| 项 | 实际文件/符号 | 当前结果与证据 |
| --- | --- | --- |
| C01 | Capability.kind、Catalog | 本地：Tool/Skill 分型，字段和真实绑定不同 |
| C02 | `Catalog.publish`、`/admin/capabilities` | 本地：来源、精确版本、schema、发布唯一键；不自动审核来源可信度 |
| C03 | `Catalog.list`、`GET /capabilities` | 本地：按业务线可见；HTTP 目录不下发 Skill 全正文 |
| C04 | `setEnabled`、capability-state API | 本地：启停立即影响新调用/模型节点准入；不承诺抢占 builtin 或立刻撤回已读 Skill |
| C05 | `freeze`、Task.capabilities | 本地：精确 ref，不追 latest；新任务与旧快照分开 |
| C06 | Capability.digest + Skill artifact hash | 部分：检测元数据/正文漂移；handler 可执行代码由部署版本负责，尚非完整可重现制品仓库 |
| C07 | `Catalog.admit`、`ToolGateway.invoke` | 本地：实际调用再检验；不是只过滤目录 |
| C08 | `tool:id@version`、MCP node grant | 本地：builtin 同名不继承授权；同名多版本同时绑定被拒 |
| C09 | `capability-usage`、model usage | 本地：task/node/ref/次数/时长；replay 不重复累加 |
| C10 | tokenAttribution / modelTurnUsage | 本地：Skill selected≠证明使用；每能力 tokens 为 null，不把整轮费用重复摊给全部能力 |
| C11 | `validateSkill` | 本地：最小受支持 SKILL.md front matter + 正文校验；非完整 YAML parser |
| C12 | `materializeSkills`、__draft 元数据列表 | 本地：仅选择的 Skill 落盘到节点上下文；不把全部 Skill 正文拼入 planner prompt |
| C13 | visibleTo/executableBy 多业务线 | 本地机制：多个业务线引用同一冻结版本；不是插件市场打包/安装系统 |
| C14 | `.agents/skills` + skills.config + `$name` | 部分：字节落盘、真实 SDK 配置与提示调用已测；模型真实采用正文尚无 live 证据 |
| C15 | schema/handler registry + MCP list | 本地：当前 3 个 allowlisted handler；新增后端需写受审 adapter，不允许运行任意注册代码/任意远端 URL |
| C16 | MCP 与 Tool node → 同一 invoke | 本地：同一准入、Schema、幂等和 ledger；官方 Client 往返测试 |
| C17 | tool timeout + signal + control watcher | 本地：取消/超时/失败分开记录，不返回空成功；业务 handler 必须协作处理中止 |
| C18 | config.capabilities + 可信 businessLine | 本地：目录、冻结、调用三层；未实现复杂组织层级 RBAC |
| C19 | 白名单 env、节点短期 grant | 部分：不继承宿主全部 env；grant 受租约约束；无 Vault/动态轮换服务，密钥禁止写 business config |
| C20 | `seed` | 无指标：3 Tool+1 Skill，不声明 100+ |
| F01 | ConfigService + admin/user API | 本地：业务线唯一有效版本；不复刻上游所有组织/项目/团队合并规则 |
| F02 | config.business、Tool handlers | 本地：知识文档等业务配置从同一快照读；非任意 Skill 参数模板系统 |
| F03 | workspaceProfile/sandbox/model/limits | 本地：Runner 统一解析、默认受限环境；无云平台镜像/工作区迁移管理 |
| F04 | features.draft/tools + capability enabled | 本地：关闭 Draft 拒提交，关闭 tools 拒实际调用；不是只藏 UI |
| F05 | immutable config version + task snapshot | 本地：新任务读新版本、恢复保留旧版本；能力停用为实时撤销例外 |
| F06 | HTTP 发布/读取、SQLite records | 本地：实际远程配置服务；不是文件只读 Provider；暂无审批审计 UI、HA 分发 |
| F07 | `bootstrap.ts`、examples、07 文档 | 本地：可运行接入流程、能力清单与 API；运行条件、端口、权限明确 |

## 3. 为什么不把缺口全部写成“已完成”

“有接入代码”“本地替身测过”“真实服务联调”“企业生产证据”是四件事。该实现能用于理解/演示/进一步开发，但不能反过来证明曾经在企业承载了简历里的真实业务量。面试时可以讲自己确实读过、实现过和测过的机制，不要把本文的“部分”删掉后当生产验收报告。
