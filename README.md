# Ark Platform：官方资料驱动的企业 Agent 运行时参考实现

**2026-10-25 从零重写，Runtime 使用 Codex SDK。** 不是把 Claude/Devin/Copilot/Zcode 的私有引擎拼起来，也不声称是生产部署完成品。旧 `src/test/dist` 已移至项目外备份，新实现没有从备份复制回来。

## 对应简历的三个重点

```text
飞书长连接 Bot / HTTP 用户
          │ 可信身份、消息幂等、路由
          ▼
Ark HTTP 控制服务 ── SQLite WAL
  │ 任务、租约、事件、检查点、能力版本、配置版本、用量
  │ claim / heartbeat / cancel / checkpoint / finish（fencing）
  ▼
独立 Runner 进程
  ├─ Direct：直接执行受控模型轮次
  ├─ 固定 Workflow：冻结定义 → DAG 调度 → 审批/恢复
  └─ 动态 Draft：结构化计划 → 校验/准入 → 冻结 → 执行
          │
          ├─ Codex SDK → CLI 子进程 → 流式事件 / thread 恢复 / AbortSignal
          └─ MCP HTTP → Ark Tool 网关 → Schema / 权限 / 幂等 / 用量
```

1. **运行时**：飞书官方 SDK 长连接、可信用户/租户绑定、SQLite 持久任务、HTTP 服务边界、原子领取与过期回收、fencing、防重复提交、实时 SSE、同卡片更新、取消/完成仲裁、独立命令验证后的提前成功、W3C trace 与可选 OTLP 导出。
2. **编排**：Direct / 固定版本 / 临时 Draft；依赖校验、并发调度、结构化交接、条件、持久 journal、完成步骤重放、失败节点恢复、暂停审批、跨恢复累计预算。另提供可信程序化 `step/parallel/pipeline/phase/pause` 库，pipeline 没有全局阶段屏障。
3. **能力与配置**：Tool 与 Skill 分型，唯一版本发布、hash、目录可见与执行权限分离、启停、节点作用域 MCP grant、调用前复核、Skill 文件落盘与 SDK 配置、用量归因边界、业务线配置的远程发布与运行快照。

知识库查询、本地 Bug 建单只是验收样例。当前只发布 **3 个真实本地 Tool + 1 个 Skill**；没有造 100 个占位能力，更没有用测试倒推“日均 1K+、成功率 97%”。

## 文档导航

| 文档 | 用途 |
| --- | --- |
| [来源登记](docs/01-source-register.md) | 四家官方资料、固定提交、证据等级、失败请求 |
| [简历 71 项原始研究矩阵](docs/02-resume-evidence-matrix.md) | 每个名词的来源与验收要求；原拟路径不等于实际路径 |
| [改写边界](docs/03-adaptation-boundaries.md) | 用户授权与源码/示例/行为/适配四类边界 |
| [研究审计历史](docs/04-research-verification.md) | 重写前的取证快照，不是当前构建报告 |
| [实现与来源逐项对照](docs/05-implementation-map.md) | 实际文件、71 项覆盖、语义差异、明确缺口 |
| [架构与故障语义](docs/06-runtime-semantics.md) | 为什么这样设计、取消/恢复/冻结的实际保证 |
| [接入与 API](docs/07-integration.md) | 飞书、真实 Codex、新能力、新配置、审批与运维 |
| [验证报告](docs/08-verification.md) | 当前测试与未联调事项 |
| [面试导读](docs/09-interview-guide.md) | 面向实习生解释调用链、取舍与面试追问 |

## 本地跑通（PowerShell 7，Node 24+）

SQLite 使用 Node 内置 `node:sqlite`；不需要额外安装数据库服务。以下命令在本项目根目录执行。

```powershell
npm ci
pwsh -File ./examples/setup.ps1
npm test
```

`setup.ps1` 生成 `.data/credentials.json`（不覆盖已有文件），编译并发布样例能力/配置/流程。凭据文件被 gitignore 排除。

**终端 A：Ark**

```powershell
npm start
```

**终端 B：Runner（先离线验证服务链路，不调用模型）**

```powershell
$credentials = Get-Content -Raw .data/credentials.json | ConvertFrom-Json
$env:ARK_RUNNER_TOKEN = ($credentials | Where-Object { $_.principal.role -eq "runner" }).token
npm run demo
```

**终端 C：提交**

```powershell
./examples/submit.ps1 -Mode direct -Prompt "说明 Runner 的恢复机制"
./examples/submit.ps1 -Mode draft -Prompt "拆解检查步骤"
./examples/submit.ps1 -Mode workflow -Prompt "按钮点击后报错"
```

所有离线模型结果有 `[OFFLINE DEMO]` 标记；**没有真实推理或真实 token 数据**。固定 `bug-intake@1.0.0` 会停在审批节点，按接入文档批准并恢复后才创建本地样例工单。

切换真实运行：停止 Demo Runner，设置 `OPENAI_API_KEY`，运行 `npm run runner`。模型名称可通过远程配置的 `model` 字段指定，本项目不猜测“最新型号”。真实 Codex、飞书应用与 Collector 需要自行提供账号/网络和授权；本次没有对这些外部系统宣称联调通过。

## 必须知道的限制

- 官方 Dynamic Workflow 原型是**程序化控制流**；本项目 Draft 是经授权实现的安全计划表示适配，不是官方完整引擎或任意脚本沙箱。服务端不接受模型生成的 JS/Python 执行。
- 恢复依赖 Ark 数据库、**同一 Runner 持久工作盘/同一任务路径**及 Codex session 文件。换机器不自动迁移工作区；不要把 thread_id 当成完整环境恢复。
- MCP/Skill 的平台权限不代表能控制 Codex 所有 builtin shell/file 行为。非可信多租户必须增加 OS 用户/容器/网络边界；本地目录不是安全沙箱。
- write-tool 模型轮次中断后不自动续跑；不明副作用需要人工对账。检查点不提供外部 exactly-once。
- active timeout、模型调用预算与输出 token 软预算都有边界；中断缺失的 token 不能精确归因，也不据此估算费用。
- 配置中心是 Ark 的 HTTP+SQLite 版本服务，不是只读 JSON 加载器；尚无 SSO、配置审批 UI、HA 或大型制品仓库。
- SQLite 扫描队列与单机 WAL 适合参考实现，不声称已测得 1K+/日或支持网络共享盘集群。
- `.research/` 是研究副本，不参与构建；第三方许可见 `licenses/` 与 `THIRD_PARTY_NOTICES.md`。

旧代码备份：
`C:\Users\DKF\Documents\Codex\2026-10-18\dai-wo\ark-platform-before-rewrite-20261025-151342`
