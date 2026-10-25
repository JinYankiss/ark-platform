# 实习生导读与面试讲法

不要先背“用到了 Workflow、MCP、SDK”几个名词。沿一条任务逐层看代码，能解释**状态在哪里、失败会怎样、用什么证据证明**，才是真的理解。

## 1. 建议阅读顺序

1. `src/core/contracts.ts`：先认识 Task、Lease、WorkflowNode、Capability、ExecutionConfig。
2. `src/bootstrap.ts`：看一个真实最小例子，别先陷进通用框架。
3. `src/ingress/feishu.ts` / `http.ts`：用户身份从哪里来，为什么不能信消息里的 businessLine。
4. `src/core/task-service.ts`：任务提交/领取/取消/完成是一套协议，而不是一次 HTTP await。
5. `src/runner/worker.ts` / `client.ts`：看真实进程边界和 heartbeat。
6. `src/runner/model.ts`：对照官方 SDK 示例，看实际调用和信号/thread。
7. `src/runner/engine.ts` / `workflow/context.ts`：区分计划表示、调度与持久步骤。
8. `src/capabilities/catalog.ts` / `invocation.ts` / `ingress/mcp.ts`：能力“看见”和“执行”不是同一件事。
9. 运行测试，故意让一个断言失败，再回到 06 文档解释边界。

## 2. 三条重点该怎样讲

### 第一条：端到端 Agent 运行时

可以用一条因果链说明：

> 入口按可信身份把消息映射成持久任务；Ark 只做控制状态与分配；Runner 领取带租约的任务后用 Codex SDK 执行。SDK 事件回流到中心并持久化，SSE 和飞书卡片是事件投影。取消不是断开等待，而是中心落标志、执行方 heartbeat 接收后 abort，清理后再提交终态。

再解释一个真正难点：旧 Runner 恢复网络后不能覆盖新 Runner，所以需要 fencing token，不只是 deadline。

不要说“加一个 AbortController 就实现跨服务取消”；它只解决执行进程内那一段。

### 第二条：三类路径和恢复

> Direct 避免不必要的规划调用；成熟业务走精确版本的固定流程；临时任务先输出结构化 Draft，经过依赖、能力、验证器准入后再运行。持久 step 用稳定 key 和输入 hash 记录完成结果，失败后复用完成步骤，只重跑可安全重跑的未完成步骤。

必须主动讲清：

- 官方 Dynamic Workflow 是程序化控制流。本项目安全计划层是 DAG 适配，不是假称直接复制完整引擎。
- pipeline 的快 item 可以先进入后续阶段，不等全体 item。
- thread 恢复 ≠ workflow 恢复 ≠ 工作区恢复。
- 对外建单/提交不由 journal 自动提供 exactly-once。

### 第三条：能力池和配置

> 能力不是一个工具名列表。先有类型、来源、精确版本和正文/Schema，再有目录可见、业务线 allowlist、运行冻结、节点作用域和实际调用准入。Skill 作为版本化文件投放到节点上下文；Tool 通过统一 MCP 网关执行。工具调用次数/时长可以归因，整轮 tokens 不能随便均摊给每个 Skill。统一配置由服务发布版本，任务保存快照，停用策略作为实时撤销例外。

不要用“前端隐藏了工具”解释安全；实际调用边界必须再检查。

## 3. 常见追问

| 面试问题 | 需要回答的机制/证据 |
| --- | --- |
| 两个 Runner 同时领取怎么办？ | 数据库事务+唯一任务更新；看真实双进程竞争测试，不是只跑两个 Promise |
| Runner 被 kill 后怎么办？ | heartbeat 停止、deadline 到期、重领新 token、未完成步骤判定；看 process.test |
| 取消与成功同时发生？ | 事务内先落 cancel 则取消胜出，成功先入库不改终态；是项目选择，不是官方统一规则 |
| 为什么旧版本不能修改？ | 同 ref 不覆盖，task 内嵌冻结定义/config/capability digest，避免恢复混用 |
| 为什么每次重试不退预算？ | 避免通过失败重试绕过调用上限；实际账单量与预留预算数要区分 |
| 为什么不直接执行模型写的脚本？ | 没有可靠代码沙箱和审计边界；受限计划更安全，但表达力比程序化 Runtime 少 |
| Skill 会不会真的被使用？ | 有落盘/配置/选择证据，但模型行为仍须 live 验收；“选择”不能当采用率 |
| 一个 Tool 停用后旧任务还能用吗？ | 调用时实时复核，拒绝新调用；不能追回已完成副作用或抹除已给模型的 Skill |
| token 用量如何归因？ | turn.completed 是模型轮次用量，Tool 调用次数/时长独立；每 Skill tokens 未知就 null |
| 为什么没上很多组件？ | 当前是机制可验证的单机参考实现；HA/SSO/容器/制品迁移需真实需求与验收，不能堆名词冒充完成 |

## 4. 三个实操练习

1. 运行固定 bug-intake，让它停在 approval。查看 journal，批准并恢复，证明 triage 的 modelCalls 没增加。
2. 启动两个 Runner，提交一个任务。查 attempts 和 task.claimed 事件，解释第二个为什么没有启动模型。
3. 发布能力新版本并停用旧版。比较旧任务快照、目录、实际调用；解释“版本冻结”和“权限撤销”为何不是冲突。

## 5. 简历数字的边界

这份代码只能支持“我实现并测试了这些机制”的表述。不能据此说自己已在公司实际承载日均 1K+、达到 97% 或收录 100+。若这些是你原有真实经历，应拿真实时间窗、原始任务数据、分母口径和能力清单佐证；若没有，删除或改写成明确的项目目标，而不是补一段假统计代码。
