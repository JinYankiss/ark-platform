# 研究记录与完整性检查

> **历史快照**：以下检查发生在重写之前。“src/test 不存在、未运行应用测试”等描述仅对应 15:51 的研究状态。当前重写验证见 `08-verification.md`；不以改写历史快照的方式制造证据。

检查时间：**2026-10-25 15:51，Asia/Shanghai**。

## 实际检查结果

| 检查项 | 实际结果 |
| --- | --- |
| 页面请求 | 53 个请求记录；48 个 HTTP 200，5 个失败 |
| HTTP 200 的局限 | 飞书文档只取得标题，没有可读协议正文；未拿它作协议证据 |
| 失败请求 | Codex SDK/Skills/MCP 官网及 `.md` 尝试返回 403；raw GitHub 的一次 README 请求 TLS 失败，后改用 GitHub API 成功取得固定提交版本 |
| 固定提交的公开文件 | 27 个，下载失败 0 |
| 内容 SHA-256 检查 | 对登记的页面和公开文件逐一核验，无不一致 |
| Git blob 检查 | 27/27 与 GitHub 返回的 blob SHA 一致；按照 Git blob 头与原字节计算，不用网页渲染文本冒充源码 |
| 简历矩阵 | 71 行平台能力映射；另有 3 个最小业务验收场景 |
| 矩阵的来源 ID | 均在资料登记中定义，没有未登记 ID |
| 当前应用代码 | `src/`、`test/`、`dist/` 均不存在；研究副本不属于应用实现 |
| 旧代码备份 | 项目外备份目录存在 |
| 实际 SDK | `@openai/codex-sdk@0.164.0`；没有安装 Claude Agent SDK |
| 应用构建/测试 | **未运行。新应用未实现，不能报告构建成功或测试通过** |
| 真实服务联调 | **未运行** Codex 模型、飞书 Bot、Devin、Copilot 服务，也未访问企业生产系统 |

`npm ls --depth=0` 实际结果：

```text
@openai/codex-sdk@0.164.0
@types/node@22.20.5
ajv@8.20.0
typescript@5.9.3
```

Ajv 目前只是遗留的已安装依赖，尚未接入新实现，不能据此声称结构化输出校验已完成。

本次完整性检查命令最初解析 `package-lock.json` 时遇到 PowerShell 的空键名限制，改用 `ConvertFrom-Json -AsHashtable` 后成功执行；这不是应用测试失败，也不能被记为应用测试通过。

## 本地可核对证据

- `.research/fetch-manifest.json`：原 URL、响应/失败、时间、文件与 SHA-256。
- `.research/upstream-manifest.json`：仓库、commit、原路径、Git blob SHA、内容 SHA-256。
- `.research/installed-codex-manifest.json`：实际包版本、锁文件 integrity、源码映射哈希、提取文件哈希。
- `.research/verification.json`：本次机器可读检查结果。
- `.research/upstream/`：原始研究文件及对应 LICENSE。

## 这份检查不能证明什么

1. 下载成功不证明协议已在真实账户上验证。
2. 校验源码哈希不证明移植后的代码正确。
3. 有官方契约不代表内部 Runtime 已开源或能独立运行。
4. 文档可以支持需求和语义，不能证明本项目已具备该能力。
5. 旧项目的 22 个通过测试与本次新实现无关。
6. 没有运行数据，不能证明 1K+、97%、100+。

## 待继续的交付

完整代码、自动化测试、启动/接入文档和真实运行边界说明仍待完成。当前等待澄清“是否允许文档行为实现与必要适配”的范围问题，**没有把调研阶段标成整个重写任务完成**。
