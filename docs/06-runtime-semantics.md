# 架构、取消、恢复与安全语义

## 1. 存储与服务边界

Ark 独占管理数据库，Runner 只能通过 HTTP 操作。SQLite 使用 WAL、busy_timeout、唯一主键。任务体、配置和能力是 JSON records，但 journal、任务和 claim 都是**持久数据库记录**，不是内存 Map；Map 只用于单次执行的依赖索引和本轮缓存。

`BEGIN IMMEDIATE` 包住“观察队列→判断状态/期限→更新租约”，在本机多个数据库连接间串行化写者；并不声称是分布式共识。Runner 领到任务后才创建工作目录/启动模型。

这是 D03 的 list/claim/renew 行为适配，未复制 Devin 私有服务端；没有把 K8s client loop 当成数据库原子性的来源。

## 2. 任务状态机

```text
queued ── claim ──> running ── finish ──> succeeded / failed
  │                    │
  │ cancel             ├─ reached pause ──> paused ── approve + resume ──> queued
  ▼                    └─ cancel flag → Runner abort + cleanup → cancelled
cancelled

failed -- explicit resume --> queued
running + expired lease -- claim new token --> running (attempt + 1)
running + repeated lease failures beyond taskAttempts --> failed
```

取消为不可恢复终态；暂停可恢复；失败可显式恢复。失败恢复**不会重置**模型调用数、已观测 tokens 或 active time。自动租约回收默认最多 3 次认领，可用 `limits.taskAttempts` 配置 1–10；达到上限等待人工排查，而不是无限抢占。人工 resume 是显式操作，不等于无上限自动 retry。

## 3. 租约为什么还需要 fencing token

仅有 deadline 不够：Runner A 暂时网络卡住，租约过期后 B 重新领取；如果 A 又回来提交旧结果，仅看任务仍在 running 就会覆盖 B。

每次 claim 生成新 token。所有 checkpoint、model-start、usage、Tool、finish 都必须检查：

1. state 是 running；
2. token 等于当前租约；
3. deadline 尚未到期。

失败返回 409 LEASE_LOST。旧执行方 heartbeat 失败会 abort 并停止写终态，等待中心回收。**数据库 fencing 不能撤回已经发给外部系统的副作用**，所以还要幂等/对账。

## 4. 跨服务取消不是“断开等待”

1. 用户调用 cancel，Ark 原子写 `cancelRequested`。
2. queued/paused 可直接取消；running 保留到执行方确认。
3. Runner heartbeat 收到标志，abort 当前执行组合 signal。
4. signal 传至 `Codex.thread.runStreamed`；官方 SDK 将 signal 传给 CLI 子进程。
5. Workflow 停止启动新节点，等待已运行 sibling 收敛；Tool 网关也周期复核取消/租约/停用。
6. Runner 清理后 finish，中心再次仲裁终态。

客户端断开 SSE/GET 不发送 cancel。HTTP request timeout 也不自动变成远程取消。取消不能回滚已完成建单或文件写入；网络失联期间在租约过期后可标取消，但旧主机是否立即停止属于进程/OS 层，不能只靠改数据库做保证。

仲裁是本项目明确选择：**cancel 先写入，后来的成功提交折为 cancelled；success 先入库，后来的 cancel 不改终态**。不是四家通用的“永远取消优先”规定。

## 5. 三种执行路径和两种编排表示

- `direct`：一个持久 step 包裹模型执行，不创建 Draft。
- `workflow`：按 `name@version` 读取已发布定义，冻结进任务。
- `draft`：planner 模型先用 outputSchema 生成临时定义；校验结构、依赖、允许能力和 verifier 后才保存/执行；不是自动发布为公共固定流程。

入口显式选择 mode；飞书 slash command 解析 mode，不假称实现了智能分类器。

Claude/Devin/Copilot 的 Dynamic Workflow 原型是程序化控制流。本项目提供两层：

1. 可信宿主的 `WorkflowContext`：step/phase/parallel/pipeline/pause，可用宿主语言条件/循环。必须给循环稳定 key 和版本化输入，不能用当前时间/随机值控制重放路径。
2. 服务接受的固定/Draft 表示：受限 DAG，支持条件、不支持生成代码和任意循环。这是安全/审计取舍，不与官方脚本引擎等同。

pipeline 将每个 item 的 stage 链当成独立 worker；快 item 可以进入第二阶段，不等待慢 item 完成第一阶段。DAG scheduler 用 Promise.race 释放完成节点的后继，不做“整个拓扑层全部完成才进入下一层”。

## 6. 检查点与恢复的实际保证

step 记录 stable key、输入 hash、started/completed、结果，以及模型 thread ID。

- completed：hash 一致直接回放结果，不调用 producer/模型/Tool。
- started：只读步骤可重跑；模型可使用保存的 thread 恢复。
- hash 不同：REPLAY_CONFLICT，而不是悄悄接着跑。
- pause：到达节点后等待独立 approval 记录，resume 时一次性完成 pause step。
- workflow/config/capability 版本已经冻结，新版本发布不漂移旧任务。

三层持久性必须同时成立：Ark journal、Codex session、工作盘。默认按 `workspaceRoot/profile/taskId` 保存，节点上下文在其 `.ark/contexts/nodeId`。恢复到其他机器但未挂载同一工作盘，不提供环境恢复保证。项目尚无工作区快照/迁移服务。

### 副作用

本地 `ticket.create` 将工单与操作唯一键放同一数据库事务，重放 completed 调用不重复建单。若 invocation 只有 started/uncertain，不盲重放 write-tool；没有自动外部对账系统。

模型带 write-tool 的中断轮次即使有 thread ID，也不直接 resume，因为再次续跑可能重复业务操作。当前会明确失败为 UNCERTAIN_SIDE_EFFECT；需要操作者检查真实结果，再以新任务/受审恢复流程继续。

MCP 工具幂等键由 `ref + args` hash 形成，作用域为 task/node。同一节点重复同样参数被视为同一个操作；确实要两次相同操作时应使用不同节点/显式不同业务幂等字段。该契约不适合所有远端业务，接入前须确认。

## 7. 提前结束的证据与预算

verify 节点只能引用配置中由管理员注册的 argv；使用 execFile、不拼 shell。命令成功返回 exit 0 和输出 digest，证据保存后才允许提前成功；失败/超时不伪装成功。

这只证明**配置的检查成功**。检查是否足以证明业务目标，需要管理员负责。测试中的 `process.exit(0)` 只是分支验证，不能拿来证明真实 Bug 已修复。不会自动 push/merge 代码。

预算：每任务节点并发、全任务模型调用预留、累计 active time、已观测 output tokens。model-start 先预留一次调用，失败也不退还，避免重试绕过上限；它不是账单完成请求数。token 上限在 turn 结束后观测，是软上限；失联/失败 turn 可能缺 usage，API 标记 partial_or_unavailable，不将缺失当精确零成本。

## 8. 能力/配置/安全边界

1. capability ref 是 `tool:id@1.0.0` 或 `skill:id@1.0.0`，不能以同名 builtin 继承权限。
2. 发现权限 visibleTo、执行权限 executableBy、业务线 allowlist、任务绑定、节点 grant、实时启停逐层判断。
3. 已发布版本不覆盖；Skill 正文 hash 并落盘，只有选择的 Skill 出现在节点发现目录；选择不等于已证明模型采用。
4. Tool 通过官方 MCP SDK 暴露，所有 call 与 DAG Tool 节点共用同一调用网关；不是只把名称写 prompt。
5. 配置是远程服务的完整业务线有效配置。发布新版本只影响新任务，恢复保留快照；能力停用是即时撤销例外。已交给模型的 Skill 文本无法“从上下文抹除”。
6. API keys/飞书 secrets 只从进程环境读取；business config 不得放密钥。应用不继承全部宿主 env，但当前无 Vault/SSO。
7. 默认仅 loopback 监听。跨机器部署需要 TLS、真实身份认证、网络策略和 OS 隔离；不要把开发 bearer token 或目录划分当企业安全边界。

## 9. 可观测和运营口径

持久事件携带 task ID、traceparent、node/attempt；SSE cursor 可以重连。OTel 手动 spans 使用同一个 trace，默认不采集 prompt、reasoning、工具参数/正文/命令原文。可选 OTLP 导出，不声称本次已部署 Collector。

`/metrics` 的成功率分母是当前数据库 `succeeded + failed`，排除 queued/running/paused/cancelled；无终结任务返回 NaN。它不是简历“过去 30 天生产成功率”。没有时间窗日均/负载测试报告，也不从 30 多个测试推导 1K+/日。
