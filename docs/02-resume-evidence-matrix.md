# 简历逐项证据矩阵

**这份是重写前的研究与验收清单。用户已允许文档行为实现和必要适配；当前实际文件、71 项覆盖与缺口以 `05-implementation-map.md` 为准。下面保留原拟路径，不伪装成实际目录。**

来源 ID 在 `01-source-register.md` 中给出实际页面/固定源码链接。R/E/B/G 的含义也见该文件。

每一行都回答：**对应简历哪句话 → 可借鉴的具体机制 → 后续代码落点 → 怎样证明不是空壳**。

## 一、端到端 Agent 运行时

简历原句：基于飞书 Bot、Ark 调度中心、Runner 执行引擎与 SDK 搭建端到端 Agent 运行时，打通消息接入、任务调度、模型执行及工具调用；建设统一任务生命周期与全链路可观测体系，实现执行过程实时展示、跨服务任务取消与提前结束。

SDK 已按用户纠正为 **Codex SDK**。

| 项 | 简历用语 | 实际机制与来源 | 拟代码落点 | 必须验证的行为 |
| --- | --- | --- | --- | --- |
| R01 | 企业内部平台 | D07、G10：组织/团队策略和受控执行；企业业务身份到任务的映射仍为 G | `src/contracts/execution-context.ts` | 入口身份不能由消息正文任意指定；同名能力不越业务线 |
| R02 | 飞书机器人、消息接入 | L01：`EventDispatcher.register`、`im.message.receive_v1`、HTTP/长连接方案；R/E | `src/ingress/feishu-adapter.ts` | 使用实际 SDK 协议；错误事件不进入调度 |
| R03 | 入口合法性 | L02：token、签名、加密数据、Challenge 处理；R | `src/ingress/feishu-adapter.ts` | 配置不完整不能默认为生产安全；错误凭据拒绝 |
| R04 | 消息到任务 | Z01：绑定/工作区；L01：消息字段；消息唯一键到持久任务的事务映射尚为 G | `src/ingress/task-submission.ts` | 重复投递不能产生两个模型任务；确认回复不等待模型完成 |
| R05 | Ark 统一调度中心 | D03/D04：监听队列、观察状态、规划动作、执行协调；R/E | `src/ark/scheduler.ts` | 调度只负责分配/控制，不在 HTTP handler 内运行完整模型循环 |
| R06 | 排队与资源调度 | D03/D04：待执行队列、并发容量、领取再启动；R/E | `src/ark/queue-adapter.ts` | 容量满时排队；停止/已结束的任务不再次派发 |
| R07 | 防重复执行 | D03：原子 claim、冲突 409、认领期限；D04：`Action::Claim/StartWorker/Renew`；服务端 claim 存储为 G | `src/ark/task-claim-store.ts` | 两个 Runner 竞争只有一个赢；过期拥有者不能继续提交结果 |
| R08 | 故障回收 | D03/D04：claim deadline、release、重启协调；R/E | `src/ark/runner-reconciler.ts` | Runner 宕机后任务可重新领取，不永久挂起；恢复不无限抢占 |
| R09 | Runner 执行引擎 | D02/D04：独立工作机、启动/回收、持久目录；O04：CLI 子进程；R/E | `src/runner/runner-service.ts` | 调度与执行有真实服务边界；退出后回收资源 |
| R10 | 执行环境 | O02/O05：工作目录、sandbox、环境、网络/MCP 配置；D02：隔离责任；R/E | `src/runner/environment-adapter.ts` | 不让所有业务任务共享无限宿主权限；配置与实际子进程一致 |
| R11 | Codex SDK、模型执行 | O01/O02/O03：`startThread` + `run/runStreamed`；R/E | `src/runner/codex-adapter.ts` | 调用真实 SDK 接口；mock 模式不能悄悄冒充 live |
| R12 | 多轮与恢复 | O01/O04：`thread.started` 保存 ID，`resumeThread` 重建；R | `src/runner/thread-binding-store.ts` | 重启后找到正确线程和工作目录；不同任务不串上下文 |
| R13 | 工具调用 | O01 类型里的 `mcp_tool_call/command_execution/file_change`，O05 MCP 配置；A08；R/E | `src/tools/mcp-adapter.ts` | 展示真正调用结果与错误，不能只打印“正在调用工具” |
| R14 | 统一任务生命周期 | G03：run/attempt 状态、终态判断；D04：队列 phase 与 session status 分开；R/E | `src/tasks/task-service.ts` | 排队、运行、暂停、失败、取消、成功不能混为一个 boolean |
| R15 | 状态持久化 | G03/G05、D03：durable run/cursor/session；企业数据库转移协议为 G | `src/tasks/task-store.ts` | 进程重启后状态存在；不能只用内存 Map 却宣称可恢复 |
| R16 | 执行实时展示 | O03：消费结构化事件；Z01：同卡片增量更新；R/E/B | `src/progress/event-projector.ts`、`feishu-progress-adapter.ts` | 展示开始、工具状态、阶段和终态；不是完成时一次性回整段文本 |
| R17 | 断线续看 | D03：cursor/list-watch；G03：进度分页；R/E | `src/progress/progress-store.ts` | 重连后补齐事件并容忍重复；不能假定网络永不中断 |
| R18 | 全链路可观测 | A05/G07：OTel、W3C 上下文；O05：Codex OTel 配置；R/E | `src/observability/telemetry-adapter.ts` | 同一任务能关联入口、调度、Runner、模型、工具，不只是每行生成新 traceId |
| R19 | 用量与指标 | O01：`turn.completed.usage`；D04：运行指标；D08/Z09：结果/用量分析；R/E/B | `src/observability/usage-projector.ts` | 重放不重复计量；未知用量保留未知，不伪造为零或估算价格 |
| R20 | 跨服务取消 | G03：`cancel` 与 `waitForRun` 区别；O04：signal 传入 CLI spawn；完整 Ark→Runner 控制协议为 G | `src/tasks/task-control.ts`、`src/runner/control-adapter.ts` | 真正停止执行方；只断 SSE/HTTP、改数据库状态或停止等待都不够 |
| R21 | 取消竞态 | G03：执行控制/终态；跨服务完成提交仲裁尚为 G | `src/tasks/task-control.ts` | 取消与完成竞争只产生一个有依据的终态；不能伪称官方统一规定“取消永远优先” |
| R22 | 正常提前结束 | Z02：独立完成验证；G03：结果只在 completed 时读；B/E | `src/tasks/completion-verifier.ts` | 已达成目标可停后续任务，但有证据才记成功；用户取消不能计成功 |
| R23 | 暂停、超时、结束区分 | A01/D01/G03：不同控制语义；R/E/B | `src/tasks/task-control.ts` | 可恢复暂停不同于不可恢复取消；超时不自动等于成功 |
| R24 | 日均 1K+、成功率 97% | 这是本项目运行指标，不是任何产品文档能证明的功能；G | 运行报告与观测查询，不写成常量 | 真实时间窗、唯一任务数、失败/取消/重试口径；保存原始观测证据 |

### 这一部分不能省略的边界

- Devin Operator 的原子认领依赖 Devin 服务端；移植客户端循环**不会自动实现** Ark 自己的原子队列。
- Codex 本地 `AbortSignal` 只解决 Runner 进程内的一个环节；跨进程控制、鉴权、命令重试、确认还缺适配。
- Zcode 桌面任务管理页面不作为企业任务调度器的依据。
- 保留目标工作区/模型权限配置是执行边界，不借此引入简历之外的大型虚拟化产品。

## 二、Workflow 编排层与执行层

简历原句：设计并实现 Direct、固定 Workflow、动态 Draft 三类执行路径及路由机制，支持节点定义、依赖解析、调度执行、检查点保存与失败恢复。

| 项 | 简历用语 | 实际机制与来源 | 拟代码落点 | 必须验证的行为 |
| --- | --- | --- | --- | --- |
| W01 | Direct | O02/O03：单线程直接调用；A02：简单问题不强上编排；R/E/B | `src/ark/direct-executor.ts` | 简单任务不额外生成计划；仍走统一生命周期/权限/用量 |
| W02 | 固定 Workflow | A01：保存脚本；D01：保存 workflow 与 Skill；G03：注册定义；E/R | `src/workflow/definition-registry.ts` | 定义可复用且版本可确定；不是每次临时改提示词 |
| W03 | 动态 Draft | A01/D01/G01：模型为当前任务生成程序化计划；O03：结构化输出；E/B | `src/ark/draft-adapter.ts` | 临时定义可检查；不会在 Ark 主进程直接 eval 任意模型代码 |
| W04 | 三类执行路径 | A02 提供 routing 模式；三分支组合不是四家同名现成实现；G（组合） | `src/ark/router.ts` | route 决策可解释、可观测、可验证；不偷偷让所有请求都进入 Draft |
| W05 | 节点定义 | G03：`WorkflowMeta/WorkflowContext`、step/agent；A01/D01 schema；R/E | `src/workflow/contracts.ts` | 稳定节点/步骤标识、输入输出、执行设置；不能只把一段字符串叫节点 |
| W06 | 依赖解析 | A01/D01：程序 await/结构化输出表达依赖；G03：pipeline/parallel；显式任意 DAG 解析器未找到同等源码，G | `src/workflow/dependency-adapter.ts` | 区分程序依赖和 JSON DAG；若采用 DAG，须另列真实来源和环/缺失节点测试 |
| W07 | 顺序执行 | G03/D01/A01 的阶段与前一步结果交给后一步；E/B | `src/workflow/execution-adapter.ts` | 下游输入来自真实上游输出；失败不能伪装空输出继续成功 |
| W08 | 并行执行 | G03 `parallel` 契约；D01 fan-out；R/E/B | `src/workflow/execution-adapter.ts` | 保留结果与节点对应关系；单项失败不能不加说明丢掉 |
| W09 | Pipeline 调度 | D01/G03：每个 item 独立流经 stage，没有全局阶段屏障；E/B | `src/workflow/pipeline-adapter.ts` | item A 已到后续 stage 时不必等待慢 item B 完成上一 stage |
| W10 | 分支与循环 | A01/D01：代码条件与循环；G01：程序化步骤；E/B | `src/workflow/execution-adapter.ts` | 循环退出条件和上限可检查；不把静态 DAG 冒充全部动态能力 |
| W11 | 结构化交接 | O03 outputSchema；A01/D01 agent schema；G03 的部分 Schema 支持；R/E | `src/workflow/output-adapter.ts` | 按实际 SDK 接口校验；不宣称 Copilot 支持的子集就是完整 JSON Schema |
| W12 | 节点/Agent 并发限制 | G03：maxConcurrentSubagents/maxTotalSubagents；D04：Worker 容量；R/E | `src/workflow/limits-adapter.ts` | 区分同时运行与总调用数；并发槽满仅等待，不误报预算耗尽 |
| W13 | 检查点保存 | D01：记录 agent 输入/结果；G03：`step(key,producer)`、`pause(key)`；E/B | `src/workflow/journal-adapter.ts` | 已保存结果在恢复后可查；仅保存状态 running 不叫检查点 |
| W14 | 确定性恢复 | D01：prompt/schema/settings 的 hash；A01：重放约束；B/E | `src/workflow/replay-adapter.ts` | 不在重放控制流中读取随机数/当前时间造成执行偏移 |
| W15 | 失败恢复 | D01/A01/G01：复用完成结果、重跑未保存工作；E/B | `src/workflow/recovery-adapter.ts` | 重启测试确认完成步骤复用、未完成步骤重试；不能把整图从头跑算局部恢复 |
| W16 | 定义修改与恢复 | A01/D01/G01 的重放规则不同；G03 defineWorkflow 深冻结元数据；R/E/B | `src/workflow/definition-registry.ts` | 记录执行时定义版本；不能混合几家规则后声称“原样实现官方恢复” |
| W17 | 暂停审批与恢复 | G03：`pause` 的一次性检查点；Z01：审批入口；R/E/B | `src/workflow/control-adapter.ts` | 审批暂停可恢复；重复批准不重复执行已保存步骤 |
| W18 | 预算与超时 | G01/G03：active time、总用量、并发；R/E | `src/workflow/limits-adapter.ts` | 暂停时间不冒充活跃时间；恢复时不清零已消费预算；软费用上限不宣称硬保证 |
| W19 | 外部副作用恢复 | 文档说明结果重放，不自动保证外部建单/修复 exactly-once；G | `src/tools/invocation-adapter.ts` | 故障时确认外部操作是否已完成；无法确认不直接重试造重复工单 |
| W20 | 编排与执行分层 | D02/D04：协调/Worker 分离；O04 SDK 执行；R/E | `src/workflow/*` → `src/runner/*` | 编排不绕过 Runner 直接启动第二条未受控模型链路 |

### 特别纠正：Dynamic Workflow 不等于“模型生成 DAG JSON”

本次查到的 Claude/Devin/Copilot 动态工作流以**程序化控制流**为核心，包含条件、循环、parallel 和逐项 pipeline。DAG 可以表达其中一部分，但若为了简历“依赖解析”改成 DAG，属于另一层表示适配；不能把自写拓扑排序引擎贴上 Dynamic Workflow 链接就算上游源码改写。

`Draft` 是简历内的临时计划名称。可以保留项目名，不必在别家的文档硬找同名 API。

## 三、能力池与统一管理体系

简历原句：能力收录、目录可见、版本冻结、执行准入、用量回流；Skill 复用与 Tool 统一注册调度，支持按业务线配置工具集；统一业务配置、平台差异与功能开关，形成可复用能力清单和接入文档。

| 项 | 简历用语 | 实际机制与来源 | 拟代码落点 | 必须验证的行为 |
| --- | --- | --- | --- | --- |
| C01 | 能力池 | A10/Z07：插件组合；G09/M01：目录；R/E/B | `src/capabilities/catalog-adapter.ts` | Tool/Skill 是不同能力类型，不强塞成一个文本 prompt |
| C02 | 收录 | M03：事务发布/唯一版本；Z07：来源校验；R/E | `src/capabilities/publication-adapter.ts` | 记录来源、版本、类型与配置契约；重复发布不可覆盖 |
| C03 | 目录可见 | M01/G09：列表/版本查询；Z07：启停与来源；R/E/B | `src/capabilities/catalog-query.ts` | 业务线无权限时不返回敏感工具元数据；能看见不等于能执行 |
| C04 | 生命周期 | Z07 安装/启用/停用、M03 发布/生命周期操作；R/E/B | `src/capabilities/lifecycle-adapter.ts` | 停用会影响执行准入；目录不是静态 JSON 清单 |
| C05 | 版本冻结 | M02/M03：不可覆盖的发布版本；G03：元数据快照；A10：固定来源；R/E | `src/capabilities/version-resolver.ts` | 运行绑定精确版本；目录更新不漂移已有任务；latest 不算冻结 |
| C06 | 内容不可漂移 | 上游版本机制可参考；企业内部制品 hash/依赖锁定仍需集成，G | `src/capabilities/artifact-adapter.ts` | 版本字符串相同而内容变化时可检测；远端 URL 不变不代表实现不变 |
| C07 | 执行准入 | D07/G08：安全策略；G04：工具集合；R/E/B | `src/capabilities/admission-adapter.ts` | 调用前再检查而非只在目录过滤；直接请求工具也不能绕过 |
| C08 | 权限和发现区分 | G09：registry 与 enforcement 局限；G04：工具来源分类；R/E/B | `src/capabilities/admission-adapter.ts` | 名称伪装/同名 MCP 工具不继承 builtin 权限 |
| C09 | 用量回流 | O01 usage；G07 工具/Skill trace；D08/Z09 会话统计；R/E/B | `src/capabilities/usage-projector.ts` | 调用关联 task/node/capability version；重放不重复累加 |
| C10 | 归因边界 | 会话 token 用量与工具 span 可观测；精确每个 Skill token 成本未查到统一实现，G | `src/capabilities/usage-projector.ts` | 标记实测/估算/未知，不把整轮 token 算到每个工具上 |
| C11 | Skill 定义 | A03/D06/G06/Z04：SKILL.md、name/description、正文；E/B | `src/skills/skill-adapter.ts` | 校验文件与元数据；不是随便一个字符串都当有效 Skill |
| C12 | Skill 发现与按需加载 | A03/Z04/D06：元数据与正文区分；E/B | `src/skills/skill-catalog.ts` | 未选中 Skill 不把所有正文塞上下文；来源和冲突可解释 |
| C13 | Skill 复用 | D05/D06：组织共享；A10/Z07：插件分发；E/B | `src/skills/distribution-adapter.ts` | 跨业务线复用同一发布版，不是各自复制后无法追踪 |
| C14 | Skill 实际执行 | O05 SkillConfig，G06/A03 的产品行为；Codex 支持情况仍需实测，E/G | `src/runner/skill-binding-adapter.ts` | 必须证明模型收到并使用所选 Skill；仅目录读取不叫 Skill 复用 |
| C15 | Tool 统一注册 | A08/Z05 的 MCP；O05 RawMcpServerConfig；M01 目录；R/E | `src/tools/tool-registry-adapter.ts` | 保存服务及 schema、命名空间、启用状态；不把“注册”误当已经执行 |
| C16 | Tool 统一调度 | G04 来源限定集合；O01 真正工具事件；本项目统一网关为集成缺口，G | `src/tools/invocation-adapter.ts` | 直接调用和模型调用都服从同一准入；schema 错误不能调用后端 |
| C17 | 工具超时/失败 | O05 MCP startup/tool timeout；A04/Z06 工具失败事件；E/B | `src/tools/invocation-adapter.ts` | 分别记录超时/拒绝/工具失败；不能吞异常返回空成功 |
| C18 | 按业务线工具集 | D07 安全配置绑定；G10 团队映射；G04 来源工具集；R/E/B | `src/policy/business-line-adapter.ts` | 业务线策略来自可信身份；同一工具按不同业务线有明确差异 |
| C19 | 凭据隔离 | L01 凭据、D07 安全配置、O02 SDK env；E/B | `src/config/secret-binding-adapter.ts` | 配置引用而非明文公开；避免把宿主全部环境交给任意任务 |
| C20 | 100+ 能力 | 是实际运营资产指标；G | 真实清单及运营统计 | 不能循环生成 100 个 echo/占位工具制造完成证据 |
| F01 | 统一配置管理 | A06/D09/G10：作用域、优先级、托管与团队覆盖；E/B | `src/config/config-adapter.ts` | 所有入口读取同一解析结果；不仍从代码、Skill、Spec 三处各取一份 |
| F02 | 业务配置 | A10/Z07：manifest/userConfig；E/B | `src/config/business-config-adapter.ts` | Skill 参数/业务参数统一注入，不以拼接密钥到 prompt 代替 |
| F03 | 平台差异 | O02/O05：工作目录、env/sandbox/MCP；D02：Worker 环境；R/E | `src/config/platform-profile-adapter.ts` | 不在业务节点散落 Windows/Linux 路径分支；只覆盖实际需要的平台 |
| F04 | 功能开关 | Z07：启停组件；O05 Skill/MCP enabled；E/B | `src/config/feature-config-adapter.ts` | 关闭能力时执行层真正不可调用；不是页面隐藏 |
| F05 | 配置版本/生效时机 | D07：启动/唤醒解析；Z06：会话快照；G10 管理层级；E/B | `src/config/execution-config-snapshot.ts` | 运行中配置变更何时生效有明确规则；不能声称所有上游都热更新 |
| F06 | 配置中心服务端 | 上述页面提供分发/消费行为；本次未获通用企业配置中心的完整可嵌入实现，G | `src/config/provider-adapter.ts` | 若选择文件只读版，明确不是远程配置中心；后续需要真实 provider |
| F07 | 清单/接入文档 | A10/Z07 manifest、M01 发布/查询契约；E/B | `docs/integration/`、`capabilities/` | 新能力按文档能被真实注册、固定版本、准入、执行、计量；路径与命令必须验证 |

## 四、业务闭环只做验收，不扩产品范围

| 简历场景 | 最小验证价值 | 不扩展的内容 |
| --- | --- | --- |
| 知识库咨询 | 只读 Tool/Skill 在 Direct 或固定流程内执行、事件可见、用量回流 | 不为示例新建全套向量数据库/RAG 产品 |
| Bug 自动建单 | 有副作用工具需要准入、幂等与失败可解释 | 不新建复杂工单系统、组织架构或审批平台 |
| 自动修复 | Codex 工作目录内执行、权限约束、检查点恢复、结果验证 | 不把所有修复都视为成功，不未经授权推送/合并真实仓库 |

这些场景不能拿来遮盖调度、恢复、取消、冻结、准入等平台能力的缺失。

## 五、面试讲解时的证据链

每个可讲的模块应当能同时展示：

1. 文档/源码原型与固定来源。
2. 原机制解决的问题，不只说一个名词。
3. 本项目改写点和上游依赖限制。
4. 测试命令及可重复的成功/失败证据。
5. 生产指标的真实来源；没有实测就不拿生成代码倒推简历经历。

**资料审计不替代代码交付**。本表用于避免重写时再次出现“代码自行实现、事后附上几个资料链接”的情况。
