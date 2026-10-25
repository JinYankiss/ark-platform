# 运行、业务接入与 API

## 1. 准备与进程

- Node 24+；当前验证 Node 24.16.0 / Windows / PowerShell 7。
- `npm ci` 安装锁定依赖；`npm run build`；`npm test`。
- `pwsh -File ./examples/setup.ps1` 创建本地随机开发凭据并 seed。已有文件不覆盖。
- Ark：`npm start`，默认 `127.0.0.1:8787`。
- Runner：设置 `ARK_RUNNER_TOKEN` 后，`npm run demo` 或设置 `OPENAI_API_KEY` 后 `npm run runner`。
- 单次领取并退出：`node dist/src/index.js runner --demo --once`。
- 可启动多个 Runner 进程。每进程一任务；任务内的节点并发来自配置。
- Ctrl+C 触发本地 shutdown/abort；不是向所有任务发送取消。正在运行的执行会尝试收敛为失败；失联则等待租约过期回收。

用环境变量 `ARK_URL` 指定控制服务；`ARK_DB` 指定 Ark 数据库；`ARK_WORKSPACES` 是 Runner 持久工作盘。**多个执行机恢复同一任务须拥有同一路径/文件与 session 文件，当前没有自动迁移。**

`.env.example` 只是示例，不会自动加载。用 PowerShell `$env:NAME="..."` 或 Node 的 `--env-file`。密钥不得写进 Git、Skill、Workflow 定义、business config 或日志。权限配置文件由启动环境安全挂载，开发 bearer credential 不能替代真实 SSO。

## 2. 最小 HTTP 调用

```powershell
$creds = Get-Content -Raw .data/credentials.json | ConvertFrom-Json
$user = ($creds | Where-Object { $_.principal.role -eq "user" }).token
$admin = ($creds | Where-Object { $_.principal.role -eq "admin" }).token
$h = @{ Authorization = "Bearer $user" }
$ah = @{ Authorization = "Bearer $admin" }

$task = ./examples/submit.ps1 -Mode workflow -Prompt "按钮点击后报错"
Invoke-RestMethod "http://127.0.0.1:8787/tasks/$($task.id)" -Headers $h
Invoke-RestMethod "http://127.0.0.1:8787/tasks/$($task.id)/events" -Headers $h
```

等状态 paused 后：

```powershell
Invoke-RestMethod "http://127.0.0.1:8787/tasks/$($task.id)/approve" -Method Post -Headers $h `
  -ContentType application/json -Body '{"key":"approval"}'
Invoke-RestMethod "http://127.0.0.1:8787/tasks/$($task.id)/resume" -Method Post -Headers $h `
  -ContentType application/json -Body '{}'
```

取消：

```powershell
Invoke-RestMethod "http://127.0.0.1:8787/tasks/$($task.id)/cancel" -Method Post -Headers $h `
  -ContentType application/json -Body '{}'
```

实时流（curl.exe 显式指定，避免 PowerShell 别名）：

```powershell
curl.exe -N -H "Authorization: Bearer $user" "http://127.0.0.1:8787/tasks/$($task.id)/stream"
# 断线后携带 -H "Last-Event-ID: 123" 续看。
```

## 3. 公开 API 清单

| 方法/路径 | 权限 | 契约 |
| --- | --- | --- |
| GET `/health` | 无 | 仅存活状态 |
| POST `/tasks` | user/admin | Idempotency-Key 必填；body: prompt/mode/workflow?/capabilities?；业务线不接受正文覆盖 |
| GET `/tasks/:id` | owner/admin | 状态、快照、结果，不返回 lease token |
| GET `/tasks/:id/events?after=seq` | owner/admin | 持久事件分页，最多 200 默认 |
| GET `/tasks/:id/stream` | owner/admin | SSE，Last-Event-ID/after，at-least-once 消费应按 seq 去重 |
| GET `/tasks/:id/journal` | owner/admin | 检查点；结果可能含业务内容，不对其他用户公开 |
| GET `/tasks/:id/usage` | owner/admin | 已观测 output token、用量完整性、工具计量；能力 token 成本未知为 null |
| POST `/tasks/:id/cancel` | owner/admin | `{}`；running 请求取消后等 Runner 确认 |
| POST `/tasks/:id/approve` | owner/admin | `{key:"node-id"}`；只能批准已经到达的 pause |
| POST `/tasks/:id/resume` | owner/admin | `{}`；仅 paused/failed，cancelled 不可恢复 |
| GET `/capabilities` | 已认证 | 按凭据的业务线过滤，目录省略 Skill 正文 |
| GET `/config` | 已认证 | 当前业务线有效配置，不得存放密钥 |
| POST `/admin/capabilities` | admin | 新精确版本；重复 ref 409 |
| POST `/admin/capability-state` | admin | `{ref:"tool:...",enabled:false}`，实时执行撤销 |
| POST `/admin/configs` | admin | 发布完整业务线有效配置，新 version 不覆盖 |
| POST `/admin/definitions` | admin | 发布固定 Workflow 新版本，重复 ref 409 |
| GET `/metrics` | admin | Prometheus text，成功率口径见 06 |
| POST `/mcp` | node grant | SDK stateless Streamable HTTP；用户 bearer/Runner bearer 不能代替 grant |
| POST `/internal/claim` | runner | 任务领取；冲突不启动执行 |
| POST `/internal/tasks/:id` | runner+lease | heartbeat/checkpoint/journal/grant/tool/definition/usage/finish 等受 fencing 控制 |

输入正文上限 256KiB；JSON、Schema、版本、身份、状态错误返回机器可读 code。不要从客户端错误推断执行没有发生；请求超时后查询 task/ledger。

## 4. 真实 Codex

`CodexModel` 使用真实 `new Codex`、`startThread/resumeThread`、`runStreamed`、outputSchema、signal。SDK 精确 0.164.0；不是普通聊天 API，也没有使用 Claude/Copilot Runtime 代替它。

环境白名单与专有 CODEX_HOME 不继承宿主全部配置。默认 sandbox read-only、approval never、network disabled、web search disabled；企业修复若需要写入，管理员发布 `sandbox:"workspace-write"` 的新配置。**禁止为了调试改成 unrestricted 全宿主权限。**

当前任务工作区初始为空；需要对真实仓库修复时，由可信宿主在该任务目录准备授权 checkout，再运行受审 Workflow。没有实现任意用户输入仓库 URL 自动克隆，也不会自动 push/merge。节点模型上下文在 `.ark/contexts/<node>`，共享目录通过 additionalDirectories 明确传入。

真实联调验收应保存：

1. thread.started、turn.completed 和实际 usage；
2. Codex 发起 MCP tool call → Ark ledger 的同一 task/node；
3. Skill 文件 hash、实际 `$skill` 调用及模型遵循证据；
4. 取消后 CLI 已退出、没有继续执行工具；
5. 恢复时相同工作盘、thread、已保存步骤未重新执行。

本次没有上述真实外部证据；SDK factory 测试不能替代 live 验收。

## 5. 飞书接入

采用 SDK **长连接**，不配置自写 HTTP webhook。因此不要求在本服务开放 challenge/signature 路由；app 凭据与连接协议交给官方 SDK。

1. 企业自建飞书应用，启用机器人、长连接事件订阅，授权收消息/发消息/更新消息所需权限。
2. 在安全环境设置 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`。
3. 创建 `.data/feishu-bindings.json`，由管理员建立真实租户、open_id 到内部身份映射：

```json
[
  {
    "openId": "真实 ou_xxx",
    "tenantKey": "真实 tenant key",
    "principal": { "id": "employee-001", "businessLine": "engineering", "role": "user" }
  }
]
```

4. 设置 `FEISHU_BINDINGS_FILE` 指向此文件，重启 Ark。未知用户/租户 fail closed，不能从消息正文指定业务线。
5. 普通文本 → direct；`/draft 内容`；`/workflow bug-intake@1.0.0 内容`；`/cancel UUID`；`/approve UUID approval`；`/resume UUID`。

接收消息先入队，后台轮询通知存储，约 1.5 秒更新同一 interactive card。错误投递保留待重试，卡片创建使用任务 UUID 去重。**卡片限流、复杂跨群转发、审批按钮、真实网络故障尚未联调**；当前审批是文本命令，不把它说成已完成全功能飞书审批卡。

## 6. 新 Tool 与 Skill 接入

### Tool

当前可执行 handler 是 allowlist：`kb.search`、`ticket.create`、`text.stats`。发布不能注入任意 JS、子进程命令或任意后端 URL。

新增真实企业后端的顺序：

1. 阅读对应后端的一手 API/幂等/取消文档；编写受审 adapter（不要把 HTTP 拼装放 Workflow 主干）。
2. 扩展 `Capability.handler`、协议 Schema、Gateway handler 分派和 sideEffect 分类校验。
3. 定义严格 inputSchema、timeout、source、visibleTo/executableBy 与精确版本。
4. 用管理员 API 发布；新的业务线配置 capabilities 引用该 ref。
5. 固定/Draft 节点显式选择 ref；模型通过 scoped MCP 发现/调用，与直接节点共用网关。
6. 对只读错误、超时/取消、重复调用、副作用结果不明、停用、业务线越权补测试。

发布示例（复用 text.stats 的第二个业务版本，不是新造执行器）：

```json
{
  "id": "text-stats", "version": "2.0.0", "kind": "tool",
  "description": "Count characters and words",
  "source": "internal-reviewed-text-adapter",
  "visibleTo": ["engineering"], "executableBy": ["engineering"],
  "handler": "text.stats", "sideEffect": false, "timeoutMs": 5000,
  "inputSchema": {
    "type": "object", "required": ["text"], "additionalProperties": false,
    "properties": { "text": { "type": "string", "minLength": 1 } }
  }
}
```

同一任务不能绑定同名 Tool 的多个版本，避免 MCP wire name 歧义。版本冻结保证元数据/正文，不保证未来重新部署的 handler 可执行字节不变；生产需另做制品版本和部署锁定。

### Skill

发布 kind=skill，skillMarkdown 使用本项目支持的最小 front matter：

```markdown
---
name: bug-triage
description: Evidence-first bug triage
---
Collect reproduction steps and a failing test before proposing a fix.
```

name 必须等于 capability.id。Skill 不设置 Tool handler/inputSchema。代码会验证并 hash 正文，按节点落到 `.agents/skills/<name>/SKILL.md`，通过 Codex skills 配置和 `$name` 选择。当前不是完整 YAML/插件包解析器。

允许复用同一精确版本给多个业务线；必须同时放开 visibleTo/executableBy，并在各自配置 capabilities 允许。**暴露/选择 Skill 不等于精确观测其 token 成本或证明模型确实采纳。**

## 7. 固定 Workflow 与验证命令

节点：agent/tool/pause/verify；needs 明确依赖；when 可按一个直接依赖结果精确比较；Tool 输入的 `{"$result":"node-id"}` 引用依赖结果。

复杂循环只能由可信宿主使用程序化库；不要上传脚本让 Ark eval。示例见 `examples/programmatic-workflow.ts`，已参与 TypeScript 编译，但不冒充第四条远程执行模式。

注册 verifier 只允许管理员在完整配置 `validationCommands` 写 argv，例如 `{"unit-tests":["node","--test","tests/fix.test.js"]}`。Windows 上 execFile 不自动展开 `.cmd`，优先使用真实可执行路径或 Node 脚本；不要用不受审 shell 拼接替代。

verify 节点的 `finishEarly:true` 只在命令通过且证据入库后停后续节点。管理员必须保证命令检查足够强；命令 exit 0 本身不能证明“用户的一切目标都达成”。

## 8. 配置、日志、部署与清理

发布配置时读取 GET `/config` 的完整对象，修改 version 后 POST `/admin/configs`；必填字段以 `src/core/schemas.ts` 为准。没有多团队配置自动合并；不在 Skill/Spec 另藏功能开关。

可选 trace：

```powershell
$env:OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "http://127.0.0.1:4318/v1/traces"
# Ark 和 Runner 都设置，然后重新启动。Collector 地址须真实可达。
```

默认没有 exporter。事件与 trace 不记录 prompt、reasoning、Tool 参数/正文和密钥；journal/task result 仍可能含业务数据，应设访问控制、备份和保留策略。当前没有自动归档/清理/脱敏 DLP 服务，不要长期无限累积生产敏感信息。

生产化前需要：TLS、SSO、OS/容器隔离、外部幂等对账、工作区/制品持久化与迁移、数据库备份/HA、真实负载与运营报告、飞书限流和重试策略、审计/保留机制。当前实现不能替代这些验收。
