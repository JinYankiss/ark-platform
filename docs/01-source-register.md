# 资料登记与复用边界

取回日期：**2026-10-25，Asia/Shanghai**。只为原始简历中的运行时、Workflow、能力池、统一配置取证。

## 1. 证据分级

- **R：公开源码**。已读取具体文件，可以依据适用许可证复用/移植；能否在 Codex 下运行仍需适配与测试。
- **E：官方示例/公开契约**。可改写接口用法、配置、示例；其内部 Runtime 不因此开源。
- **B：官方行为说明**。可以作为功能等价的验收依据，不等于获得实现源码。
- **G：缺口**。本次证据不足或只覆盖一部分。不能自行填入实现后宣称来自官方。

原始矩阵中的“拟代码落点”是研究阶段的候选位置。用户随后允许文档行为实现与必要项目适配；实际文件、覆盖和限制见 `05-implementation-map.md`，不得把候选路径当作实际交付。

取证规则：

1. 实际读取正文，不把搜索摘要或侧边导航当证据。
2. 源码固定提交 SHA，记录 blob SHA、文件 SHA-256。
3. `.research/fetch-manifest.json` 记录网页请求；HTTP 200 不一定有正文。
4. `.research/upstream-manifest.json` 记录公开源码；`.research/installed-codex-manifest.json` 记录官方安装包映射源码。
5. Codex 官网 403 等失败保留记录，不声称读过失败页面。
6. 未检索到不等于不存在；G 只表示本次证据不足。

## 2. OpenAI / Codex：实际运行时

| ID | 已读取依据 | 与简历的关系 |
| --- | --- | --- |
| O01 | 官方 npm 包 `@openai/codex-sdk@0.164.0` 的 README、类型声明、源码映射 | R/E。`startThread/resumeThread/run/runStreamed`、`outputSchema`、`AbortSignal`。SDK 包装 CLI 子进程并交换 JSONL，不是普通聊天 HTTP 客户端 |
| O02 | [SDK README](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/sdk/typescript/README.md) | E。Direct 执行、流式事件、线程恢复、工作目录、环境与配置传递 |
| O03 | [流式示例](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/sdk/typescript/samples/basic_streaming.ts)、[结构化输出示例](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/sdk/typescript/samples/structured_output.ts) | R/E。事件处理与 Schema 传入的实际代码，不是企业调度系统 |
| O04 | 安装包映射中的 `codex.ts/thread.ts/exec.ts/outputSchemaFile.ts` | R。线程 ID、事件生成器、信号与子进程、临时 Schema 清理 |
| O05 | [Codex 配置 Schema](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/config.schema.json) | R/E。`RawMcpServerConfig.enabled_tools/disabled_tools`、`SkillConfig`、`OtelConfigToml` 的实际配置契约 |

[Codex SDK 官网](https://developers.openai.com/codex/sdk/)、Skills、MCP 页面在本环境请求失败，因此使用官方仓库与官方安装包，不假装读取了官网正文。

安装包版本与仓库提交分别记录。**未证明固定提交就是 npm 0.164.0 的发布提交**；接口实际可用性仍应以已安装包和运行测试为准。

## 3. Claude / Anthropic

| ID | 实际读取页面 | 对应机制与边界 |
| --- | --- | --- |
| A01 | [Dynamic workflows](https://code.claude.com/docs/en/workflows.md) | E/B。JS 脚本持有控制流与中间结果，`agent/pipeline/parallel` 示例、阶段、保存、暂停、重放。脚本不是 Runtime 源码 |
| A02 | [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) | B。Routing、预定义工作流与自主 Agent、orchestrator-workers；不是同名 Direct/Workflow/Draft 三分支源码 |
| A03 | [Skills](https://code.claude.com/docs/en/skills.md) | E/B。`SKILL.md`、元数据、按需加载、复用、工具范围；提示约束不等于服务端鉴权 |
| A04 | [Hooks](https://code.claude.com/docs/en/hooks.md) | E/B。会话、工具前后、停止事件；Claude Hook 不自动成为 Codex SDK API |
| A05 | [Monitoring usage](https://code.claude.com/docs/en/monitoring-usage.md) | E/B。OTel 指标/事件；不等于本项目已部署 Collector |
| A06 | [Settings](https://code.claude.com/docs/en/settings.md)、[Managed settings](https://code.claude.com/docs/en/managed-settings.md) | E/B。配置作用域、优先级、企业托管分发；不是嵌入 Ark 的通用配置中心源码 |
| A07 | [Permissions](https://code.claude.com/docs/en/permissions.md) | E/B。Allow/ask/deny；发现、权限和业务身份是不同层次 |
| A08 | [MCP](https://code.claude.com/docs/en/mcp.md) | E/B。服务声明、连接、发现、认证与策略；MCP 不是企业能力数据库 |
| A09 | [Sessions](https://code.claude.com/docs/en/sessions.md) | E/B。恢复与持久化，不是外部副作用 exactly-once |
| A10 | [Plugins](https://code.claude.com/docs/en/plugins/overview.md)、[Manifest](https://code.claude.com/docs/en/plugins-reference.md)、[Marketplace](https://code.claude.com/docs/en/plugin-marketplaces.md) | E/B。组件组合、目录与分发；市场页指向 git ref/sha 固定方式。版本号本身不是制品完整性证明 |

## 4. Devin

| ID | 实际读取页面/文件 | 对应机制与边界 |
| --- | --- | --- |
| D01 | [Dynamic Workflows](https://docs.devin.ai/work-with-devin/dynamic-workflows.md) | E/B。确定性 Python、结构化结果、无全局阶段屏障的 pipeline、按输入记录并重放 |
| D02 | [Outposts 概览](https://docs.devin.ai/cloud/outposts/overview.md) | E/B。控制侧/执行机分离、Worker、执行环境、持久化责任 |
| D03 | [Orchestration](https://docs.devin.ai/cloud/outposts/orchestration.md)、[API/CLI reference](https://docs.devin.ai/cloud/outposts/reference.md) | E/B。List/watch、SSE cursor、原子 claim、409 竞争、deadline、release、Worker 启停 |
| D04 | [官方 Operator](https://github.com/CognitionAI/devin-outpost-k8s/tree/fedb657f327091ad0ca547f4e6809e3cf3b94ec3) 的 `queue_watch.rs/plan.rs/reconcile.rs/metrics.rs` | R。监听、Observed→Action 规划、协调与指标的真实源码；依赖 Devin API 和 Kubernetes |
| D05 | [Playbooks](https://docs.devin.ai/product-guides/creating-playbooks.md) | E/B。组织/企业共享、版本历史、回退；过程说明不等于确定性引擎 |
| D06 | [Skills](https://docs.devin.ai/product-guides/skills.md) | E/B。发现、元数据、复用、只读工具示例 |
| D07 | [Security Profiles](https://docs.devin.ai/product-guides/security-profiles.md) | E/B。网络/MCP/Git、组织/会话绑定、强制策略下限、恢复时解析 |
| D08 | [Session Insights](https://docs.devin.ai/product-guides/session-insights.md) | B。用量、结果分析与改善；不是 Tool/Skill 成本归因实现 |
| D09 | [Configuration](https://docs.devin.ai/cli/extensibility/configuration.md)、[MCP configuration](https://docs.devin.ai/cli/extensibility/mcp/configuration.md) | E/B。用户/项目作用域、权限与工具配置 |

固定 Operator README 与当前 Outposts 产品概览对服务开通的表述存在版本差异，不能静默合并为统一可用性结论，也不用于推断本项目拥有 Devin 权限。

## 5. GitHub Copilot

| ID | 实际读取依据 | 对应机制与边界 |
| --- | --- | --- |
| G01 | [Dynamic workflows](https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/dynamic-workflows) | E/B。程序编排、顺序/并行/人工检查、定义复用、权限与运行控制 |
| G02 | [Using dynamic workflows](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-dynamic-workflows) | E/B。创建/运行/恢复、非交互权限、工作流 OTel span |
| G03 | [SDK workflow.ts](https://github.com/github/copilot-sdk/blob/c57638f4a7ce2255a34192d5035932d0e109bbdd/nodejs/src/workflow.ts) | R/E。`defineWorkflow`、定义冻结、`WorkflowContext`、`step/pause/parallel/pipeline` 契约、状态与错误码；不能仅靠此文件获得调度与日志存储引擎 |
| G04 | [ToolSet](https://github.com/github/copilot-sdk/blob/c57638f4a7ce2255a34192d5035932d0e109bbdd/nodejs/src/toolSet.ts)、`docs/features/changing-tools.md` | R/E。来源限定的 builtin/MCP/custom 工具集合；不自带业务线 RBAC |
| G05 | [Session persistence](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/session-persistence) 及仓库文档 | E/B。会话恢复；宿主侧处理函数不能假定已序列化进历史 |
| G06 | [Skills](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills) 及 SDK `docs/features/skills.md` | E/B。技能目录与会话发现/注入，不等于完整能力池 |
| G07 | [SDK OTel](https://docs.github.com/en/copilot/how-tos/copilot-sdk/observability/opentelemetry)、`nodejs/src/telemetry.ts` | R/E。W3C Trace Context、OTLP、可选内容采集；Ark/Runner 仍需传播适配 |
| G08 | [Tool permissions](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/allowing-tools) | E/B。可见不等于可执行 |
| G09 | [Registry](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-mcp-usage/configure-mcp-registry)、[Enforcement](https://docs.github.com/en/copilot/reference/enterprise-administrators/mcp-private-registry-enforcement) | E/B。目录 API；旧 ID 匹配有绕过局限，页面推荐托管 allowlist。目录不是执行网关 |
| G10 | [Managed settings](https://docs.github.com/en/copilot/reference/enterprise-administrators/enterprise-managed-settings)、[Team overrides](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-enterprise/use-managed-settings/override-settings-for-teams) | E/B。企业基线、允许覆盖的键、团队映射；多团队合并规则不能任意改写后声称原样来自官方 |
| G11 | [Extensions](https://docs.github.com/en/copilot/concepts/customizations/extensions) | E/B。注册/共享；不意味着可在 Ark 进程中安全执行任意生成脚本 |

容易误读的源码边界：

- `WorkflowJsonSchema` 只支持部分结构校验，不是完整 JSON Schema 实现。
- `parallel/pipeline` 单项失败与取消/Runtime 断连不同，不能把所有异常吞成 null。
- 中止 `waitForRun` 等待不同于 `cancel` 执行。
- 暂停可恢复不等于取消可恢复，恢复也不重置已消费预算。

## 6. Zcode

已确认对象为 [zcode.z.ai](https://zcode.z.ai)，不是同名第三方仓库。

| ID | 实际读取页面 | 对应机制与边界 |
| --- | --- | --- |
| Z01 | [Bot Channel](https://zcode.z.ai/cn/docs/bot-channel) | E/B。飞书绑定、工作区范围、同卡片流式更新、审批分开显示；执行仍在宿主 |
| Z02 | [Goal](https://zcode.z.ai/cn/docs/goal) | E/B。工作轮次与独立目标验证、暂停恢复、上限；“说完成”不是证据 |
| Z03 | [Subagents](https://zcode.z.ai/cn/docs/subagents) | E/B。角色、独立上下文、前后台、工具范围与只读 Explore |
| Z04 | [Skill](https://zcode.z.ai/cn/docs/skill) | E/B。元数据、按需正文、启停、插件分发与导入 |
| Z05 | [MCP](https://zcode.z.ai/cn/docs/mcp-services) | E/B。服务配置、作用域、启停、优先级；停用不应只是 UI 变化 |
| Z06 | [Hooks](https://zcode.z.ai/cn/docs/hooks) | E/B。工具前后、失败与 Stop、JSON 子进程协议、快照/超时/输出限制 |
| Z07 | [Plugin](https://zcode.z.ai/cn/docs/plugin) | E/B。能力打包、目录、安装、启停、版本、市场、用户配置 |
| Z08 | [Configuration](https://zcode.z.ai/cn/docs/configuration)、[Safety](https://zcode.z.ai/cn/docs/safety-confirm) | E/B。配置与权限模式；普通问答的超时不是权限审批超时 |
| Z09 | [Usage](https://zcode.z.ai/cn/docs/usage-stats)、[Tasks](https://zcode.z.ai/cn/docs/task-management) | B。用量和任务组织；不是企业任务状态机源码 |

未核实到 Zcode 同名 Dynamic Workflow 的可独立复用执行引擎；使用功能等价项说明，不杜撰 API。

## 7. 飞书官方 SDK

| ID | 实际读取依据 | 对应机制与边界 |
| --- | --- | --- |
| L01 | [SDK README](https://github.com/larksuite/node-sdk/blob/b188be60134d409b61259546bcf69c731d2b0b7c/README.md) | R/E。`EventDispatcher`、`im.message.receive_v1`、HTTP adapter、WSClient、消息发送 |
| L02 | 同提交 `adaptor/default.ts`、`dispatcher/request-handle.ts`、`dispatcher/verification-token.ts` | R。Challenge、token/signature 与加密数据解析 |

飞书文档请求虽然 HTTP 200，但正文只得到标题，因此不把它当作签名协议证据，改以实际 SDK 源码取证。

尚有缺口：企业消息去重存储、业务身份绑定、完整流式卡片 API/限流契约。Z01 只能证明卡片体验形式，不能替代协议。

## 8. Copilot 文档指向的 MCP Registry

顺着 G09 的官方链接补齐“目录收录”和“版本冻结”源码，不是为凑技术栈引入无关组件。

| ID | 实际读取依据 | 对应机制与边界 |
| --- | --- | --- |
| M01 | [Registry README](https://github.com/modelcontextprotocol/registry/blob/edd9fa79197ff06499d3933813611fbbd9bb7649/README.md) | R/E。服务目录，与调用网关区分 |
| M02 | [Versioning](https://github.com/modelcontextprotocol/registry/blob/edd9fa79197ff06499d3933813611fbbd9bb7649/docs/modelcontextprotocol-io/versioning.mdx) | E/B。唯一发布版本、不可覆盖定义；不拿 latest 当冻结版本 |
| M03 | 同提交 `internal/service/registry_service.go`、`internal/database/migrations/007_add_publish_constraints.sql` | R。事务发布、版本查询、重复版本与 latest 唯一性；代码为 Go/PostgreSQL，不是可无修改接入的 TS 包 |

## 9. 固定提交与许可证

| 仓库 / 包 | 本次固定依据 | 已读取的 LICENSE |
| --- | --- | --- |
| `openai/codex` | `970111f6cb62cc02fe36a82ea7d71b37a2889c97` | Apache-2.0 |
| `@openai/codex-sdk` | 精确 `0.164.0`，锁文件 integrity 单独记录 | 包声明 Apache-2.0 |
| `github/copilot-sdk` | `c57638f4a7ce2255a34192d5035932d0e109bbdd` | MIT |
| `CognitionAI/devin-outpost-k8s` | `fedb657f327091ad0ca547f4e6809e3cf3b94ec3` | MIT |
| `larksuite/node-sdk` | `b188be60134d409b61259546bcf69c731d2b0b7c` | MIT |
| `modelcontextprotocol/registry` | `edd9fa79197ff06499d3933813611fbbd9bb7649` | 当前许可迁移：新代码 Apache-2.0、部分历史贡献仍 MIT、非规范文档 CC-BY-4.0，不能简写成全库 MIT |

当前重写保留了 SDK 示例改写说明、许可副本与 `THIRD_PARTY_NOTICES.md`。没有声称拿到了四家私有调度引擎源码。

## 10. 实现阶段补充的直接依赖来源

| ID | 已实际读取的包内一手资料 | 使用范围 |
| --- | --- | --- |
| L03 | `@larksuiteoapi/node-sdk@1.76.0` README、实际 types、LICENSE | 真正安装版本，长连接、消息创建和 patch；不声称等于 L01 固定提交的发布构建 |
| M04 | `@modelcontextprotocol/sdk@1.32.2` 官方包 `dist/esm/examples/server/simpleStatelessStreamableHttp.js`、server/client 类型和 LICENSE | stateless HTTP MCP 示例改写；实际协议往返测试使用官方 Client |
| T01 | `@opentelemetry/sdk-trace-node@2.8.0` 与 `@opentelemetry/exporter-trace-otlp-http@0.219.0` 包内 README、类型、LICENSE；API 1.9.0 | 手动 span、父子链路与可选 OTLP exporter；版本按 peer 兼容固定，不称最新 |

实现阶段曾尝试 API 1.10.0 / exporter 0.300.0，与 Node tracer 2.x peer 不兼容；已撤回，最终 `npm ls` 必须无 invalid peer。Node tracer 2.x 包在当前 registry 有弃用提示，本项目记录此限制，未把“有新版本”混同为已验证迁移。
