# 来源、许可与改动声明

本项目没有分发四家产品的私有 Runtime。除下面列出的官方示例用法改写，核心服务为用户明确授权的**文档行为实现和项目集成适配**。没有宣称将公开接口文件移植成完整官方引擎。

| 实际文件 | 原始依据 | 类型与改动 | 许可 |
| --- | --- | --- | --- |
| `src/runner/model.ts` | OpenAI `openai/codex@970111f6cb62cc02fe36a82ea7d71b37a2889c97`，`sdk/typescript/samples/basic_streaming.ts`、`structured_output.ts`，安装包 SDK 0.164.0 | 示例改写：去交互 readline，加入异步事件存储、abort、thread、配置、Skill、MCP；实际执行 API 以 npm 包为准 | OpenAI；Apache-2.0，`licenses/codex-Apache-2.0.txt` |
| `src/ingress/feishu.ts` | larksuite/node-sdk 固定提交见来源 L01；实际 npm 1.76.0 README 长连接和消息示例 | 示例改写：可信身份、幂等任务、通知持久化和卡片更新；未复制私有传输代码 | MIT，`licenses/lark-sdk-MIT.txt` |
| `src/ingress/mcp.ts` | MCP TypeScript SDK 1.32.2 官方 stateless HTTP server 示例 | 示例改写：动态 JSON Schema 使用低层 Server，加入 per-node grant 和统一网关 | Anthropic, PBC；MIT，`licenses/mcp-sdk.txt` |
| `src/observability/tracing.ts` | OTel Node SDK 2.8.0、OTLP HTTP exporter 0.219.0 官方包 README | 示例改写：只用手动 span/显式 parent，不采集内容 | OpenTelemetry Authors；Apache-2.0，`licenses/opentelemetry-Apache-2.0.txt` |

Copilot SDK（Copyright GitHub, Inc.，文件含 Microsoft Corporation 版权行）与 Devin Operator（Cognition）的固定提交用于**阅读机制/契约**，没有逐行移植其调度实现。仍保留其 MIT 许可副本于 `licenses/`，不删除研究副本原版权。

MCP Registry 的 Go/PostgreSQL 源码只用于研究唯一版本发布与事务约束，没有复制进应用。其多许可迁移情况见来源 M03，不能把整仓库称为 MIT。

Claude、Devin、Copilot、Zcode 的官方产品说明用于行为验收，不等于获得全部产品源码许可。`.research/` 中页面只供本地研究，不随应用发布。本文不能代替发布时的正式第三方许可审查。
