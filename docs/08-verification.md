# 本轮重写的验证记录

验证日期：**2026-10-25，Asia/Shanghai**。对应当前新 `src/`、`test/` 与 `examples/`，不包含备份项目的测试结果。本文是本地功能验收，不是企业生产验收或性能报告。

## 1. 环境与实际执行结果

| 项目 | 实际结果 |
| --- | --- |
| 操作系统 / Shell | Windows / PowerShell 7.6.5 |
| Node / npm | Node 24.16.0 / npm 11.13.0 |
| TypeScript | 锁文件安装版本 5.9.3 |
| `npm ci` | 退出 0，按锁文件重新安装 143 个包；未使用旧 node_modules 作为最终验证前提 |
| `npm test` | 构建通过；**38 tests、38 pass、0 fail、0 cancelled、0 skipped、0 todo** |
| `npm run check` | 严格类型检查通过，启用 noUnusedLocals / noUnusedParameters / noUncheckedIndexedAccess |
| `npm ls --all --parseable` | 退出 0，依赖树没有 missing/invalid peer 错误 |
| `npm audit --omit=dev` | 执行时报告 **0 vulnerabilities**；不是未来安全承诺 |

最终一次测试运行是在 `npm ci` 之后；测试时长约 3.15 秒仅是这台机器的一次测试耗时，不能解读成生产吞吐量、延迟 SLA 或模型性能。

另行运行了本地结构检查：README 与 9 份 Markdown 文档的相对文件链接没有断链；实现矩阵恰好覆盖 R01–R24、W01–W20、C01–C20、F01–F07 共 71 项，无缺项/重复。用 TypeScript AST 检查 `src/test/examples` 的 30 个 TypeScript 文件，没有 `any` 类型节点、非空断言或连续 `as` 双重断言。此检查不等于形式化正确性证明或完整安全审计。

安装有两个弃用提示：`@opentelemetry/sdk-trace-node@2.8.0` 与其 `sdk-trace-base@2.8.0` 提示使用 `@opentelemetry/sdk-trace`。本轮保留已经验证的兼容组合，没有忽略 peer 冲突强装，也不把这个版本描述为“最新推荐版本”。迁移时须重新验证导出器、父子 span 和 shutdown。

## 2. 38 个测试分别证明什么

完整断言以对应测试文件为准；这里只总结本轮实际运行的内容。

### 运行时：`test/runtime.test.ts`，9 项

1. 同一消息/提交键重复投递返回同一任务；内容改变拒绝，trace 身份保留。
2. 租约到期后生成新 fencing token，旧 Runner 不能提交结果。
3. 自动回收有尝试次数上限，不能无限重领。
4. Direct 经真实 Ark HTTP 到 Runner 后完成，不生成 Draft；离线结果不伪造模型 token。
5. HTTP 取消传到模型适配器 AbortSignal，等待执行清理才确认取消。
6. 取消/成功按持久事务先后仲裁，不篡改已成功终态。
7. HTTP 角色、任务所有权、正文校验、事件游标与指标无数据口径。
8. 飞书可信 tenant/open_id 绑定、重复消息、文本命令及任务归属校验；**不登录真实飞书**。
9. 超过 1,000 条事件后卡片投影仍读到最新 8 条、保持时间顺序、不混入其他任务；不是只取历史第一页。

### 编排：`test/workflow.test.ts`，10 项

1. DAG 缺依赖、环、重复节点和不合法节点被拒绝。
2. 固定流程暂停、到达后批准、显式恢复；完成的模型步骤重放，不增加一次模型调用。
3. Draft 校验后冻结，执行不 `eval` 模型生成源码。
4. Draft 引入未授权能力时，在任何计划节点执行前拒绝。
5. 重开数据库连接后仍可重放完成步骤；输入漂移报冲突，未完成步骤可重新尝试。
6. pipeline 每个 item 单独前进，没有全局 stage barrier，并发数受限。
7. 独立注册验证命令成功后提前完成，不再启动下游模型。
8. 提前完成会中止正在执行的其他节点，等待它们的 finally 清理。
9. parallel 保留原始失败，向其他执行传播中止并等待清理，不吞错误返回成功。
10. 恢复任务仍累计此前模型调用预算，不通过重试重置额度。

### 能力与配置：`test/capabilities.test.ts`，8 项

1. Tool/Skill 版本唯一、正文/元数据 hash、版本启停互相独立。
2. 目录可见不等于可执行；来源限定名称不能绕过实际准入。
3. 两个获准业务线复用同一个冻结 Skill。
4. Tool 取消记录为失败，不创建本地副作用、不计为成功。
5. HTTP 远程发布配置，新任务使用新版，已排队任务保留快照。
6. 输入 Schema、当前策略、持久幂等与本地样例副作用。
7. 不明副作用不静默重跑，已上报模型用量去重。
8. **官方 MCP Client 通过真实 HTTP 协议**发现节点可用工具并调用统一网关；不是直接调一个假的 MCP 函数。

### 故障：`test/failures.test.ts`，6 项

1. 失败恢复保留已完成依赖，只重试失败步骤。
2. 验证命令失败不能提前成功，未注册/伪造验证证据被拒。
3. active timeout 触发模型中止并等待清理。
4. 租约被替换时旧 Runner 本地中止，不能写入成功。
5. **真实 SSE 流**按持久游标断线续看。
6. 能力制品漂移关闭执行；事件去重；完成检查点不能被替换。

### 进程边界：`test/process.test.ts`，2 项

1. 启动两个**实际 Node Runner 子进程**争抢同一任务，只有一个 attempt 和模型预算预留。
2. 强制结束正在运行的 Runner，等待租约过期，由另一实际进程恢复；旧 token 被拒，未完成步骤重新执行。

这两项使用 Demo/慢模型替身，但 Ark HTTP、SQLite、独立进程、进程终止与租约等待都是真实的；没有把单进程里的两个 Promise 称为双进程测试。Windows 强制结束使用本平台 Node 子进程语义，未据此声称验证了 Linux 信号处理或 Kubernetes 故障行为。

### SDK 与 tracing：`test/sdk.test.ts`，3 项

1. 按**已安装官方 SDK 的实际 TypeScript 类型**构造适配器，核对线程配置、signal、节点 MCP 配置、选中 Skill 文件字节与提示。
2. 不完整只读 turn 持久化 thread ID，下一次恢复调用 resumeThread 而非新建会话。
3. OTel 内存 exporter 真正收到父子 span，检查 trace/parent 关联及受控属性。

前两项通过类型化 Codex factory 替身提供事件，**没有调用 OpenAI、没有启动真实模型推理**。Skill 落盘/配置正确不等于证明模型实际采用了 Skill；内存 exporter 测试也不等于外部 Collector 已接通。

## 3. 已实际执行的命令行链路冒烟

本轮曾执行：

```powershell
pwsh -NoProfile -File ./examples/setup.ps1
# 独立启动 Ark，再提交：
./examples/submit.ps1 -Mode draft -Prompt "拆解检查步骤"
# 在另一进程执行：
node dist/src/index.js runner --demo --once
```

`setup.ps1` 成功生成本地随机凭据并发布样例；凭据未打印，`.data/` 被忽略。HTTP 查询到该次任务：

```text
id            = f4ac84b8-0d28-40b6-bb34-910abcd41323
state         = succeeded
mode          = draft
definition    = temporary-draft
modelCalls    = 2
outputTokens  = 0
```

这是**离线 Demo 冒烟**：2 表示规划/执行适配器的调用预算计数，不表示发生了两次真实模型 API 请求；0 不表示真实模型免费或零 token。冒烟服务器随后已停止，不要求常驻后台服务。其他机器不应依赖这个本地 task ID，应自行提交。

## 4. 来源证据与代码证据不能混用

- 官方资料与固定源码清单见 [01](01-source-register.md)，研究阶段的完整性检查见 [04](04-research-verification.md)。
- 研究缓存此前记录 53 次页面请求、48 次 HTTP 200、5 次失败；其中飞书事件页只取到标题，不能当协议正文证据。
- 27 个固定源码文件此前已校验 SHA-256 与 Git blob；这证明取回文件的完整性，不证明功能等价或外部系统已联调。
- Codex 官网请求失败后采用官方仓库及已安装包；本轮收尾重试 web 搜索/打开也没有返回可用正文，未补写“官网已读成功”。
- 每个简历名词的依据、真实文件、覆盖/部分/缺口见 [05](05-implementation-map.md)。它与原研究矩阵的 **71 项**一一对应，不把候选路径算成交付。
- 四种复用性质已区分：公开源码、官方示例、文档行为实现、项目适配。后两类不是官方私有实现源码。

## 5. 尚未验证，以及上线前需要补什么

| 未验证/未实现 | 需要补充的真实验收 |
| --- | --- |
| 真实 Codex CLI/API | 用授权账号验证流式事件、usage、MCP 调用、Skill 使用、中止后的 CLI 退出、同盘 thread 恢复 |
| 真实飞书 | 应用权限、长连接、消息 create/patch、限流/重试、群聊权限、真实身份映射 |
| 外部 OTLP Collector | 真实跨进程 trace 关联、采样、导出失败、队列与退出 flush |
| 企业隔离与认证 | OS/容器/网络隔离、SSO、凭据轮换、审计、授权回归；当前目录隔离不是安全边界 |
| 高可用与异机迁移 | 换数据库/队列后的 fencing 和事务验证、工作区/session 迁移、容量与故障演练 |
| 外部业务副作用 | 远端幂等键/查询对账、超时不明状态人工处理；本地 journal 不提供跨系统 exactly-once |
| 生产指标 | 真实时间窗、任务口径、观测数据、能力清单；当前没有 1K+/日、97%、100+ 的证据 |

本次已测本地机制，但没有承诺所有竞态穷尽、所有外部 handler 可强制终止、任意模型生成程序安全、完整程序化 Dynamic Workflow 引擎或生产级发布。可用范围与缺口不得从简历导读中删除。

## 6. 自己复验

在项目根目录执行以下命令，任何失败都应先修复再解释简历：

```powershell
npm ci
npm test
npm run check
npm ls --all --parseable
npm audit --omit=dev
```

接着阅读 [07 接入文档](07-integration.md) 的真实联调验收清单，最后按 [09 面试导读](09-interview-guide.md) 解释一条任务和一个故障场景。不要背测试名称来替代对状态机、权限与恢复语义的理解。
