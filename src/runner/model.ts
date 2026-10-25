/**
 * 官方示例改写 O01–O05：basic_streaming.ts / structured_output.ts (Apache-2.0)。
 * 改动：事件脱敏落库、thread 绑定、signal、独立 CODEX_HOME、MCP 网关与精确 Skill 制品。
 * 没有 registerTool/hook/workflow 等虚构的 Codex API。来源与许可见 licenses/ 和 docs/05。
 */
import { Codex, type CodexOptions, type Thread, type ThreadOptions, type ThreadEvent } from "@openai/codex-sdk";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Json, JournalEntry, Schema, Task } from "../core/contracts.js";
import { capabilityRef } from "../core/contracts.js";
import { check, hash, json, validate } from "../core/validation.js";
import type { TaskClient } from "./client.js";
import { telemetry } from "../observability/tracing.js";

export interface ModelRequest {
  task: Task;
  node: string;
  prompt: string;
  refs: string[];
  schema?: Schema;
  previous?: JournalEntry;
  workspace: string;
  signal: AbortSignal;
  client: TaskClient;
}
export interface ModelAdapter { run(request: ModelRequest): Promise<Json> }
export interface CodexPort {
  startThread(options: ThreadOptions): Pick<Thread, "runStreamed">;
  resumeThread(id: string, options: ThreadOptions): Pick<Thread, "runStreamed">;
}
export class CodexModel implements ModelAdapter {
  constructor(private readonly arkUrl: string, private readonly apiKey: string,
    private readonly createCodex: (options: CodexOptions) => CodexPort = options => new Codex(options)) {
    check(apiKey, "MISSING_API_KEY", "Live mode requires OPENAI_API_KEY");
  }
  async run(r: ModelRequest): Promise<Json> {
    return telemetry.traced("codex.turn", r.client.parent ?? r.task.traceparent,
      { "ark.task.id": r.task.id, "ark.node": r.node }, parent =>
        this.runTurn({ ...r, client: r.client.withParent(parent) }));
  }
  private async runTurn(r: ModelRequest): Promise<Json> {
    const grant = await r.client.action<string>("grant", { node: r.node, refs: r.refs });
    const home = resolve(r.workspace, ".ark", "codex-home");
    await mkdir(home, { recursive: true });
    const nodeWorkspace = resolve(r.workspace, ".ark", "contexts", r.node);
    await mkdir(nodeWorkspace, { recursive: true });
    const skillPaths = await this.materializeSkills(r);
    const config: NonNullable<CodexOptions["config"]> = {
      mcp_servers: {
        ark: {
          url: new URL("/mcp", this.arkUrl).toString(), bearer_token_env_var: "ARK_MCP_GRANT",
          enabled_tools: r.task.capabilities.filter(c => c.kind === "tool" && r.refs.includes(capabilityRef(c))).map(c => c.id),
          startup_timeout_sec: 15, tool_timeout_sec: 120,
        },
      },
      skills: { config: skillPaths.map(path => ({ path, enabled: true })), bundled: { enabled: false } },
    };
    const env: Record<string, string> = {
      CODEX_HOME: home, OPENAI_API_KEY: this.apiKey, ARK_MCP_GRANT: grant,
    };
    for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE"]) {
      const value = process.env[key];
      if (value) env[key] = value;
    }
    const codex = this.createCodex({ env, config });
    const options = {
      workingDirectory: nodeWorkspace, sandboxMode: r.task.config.sandbox, additionalDirectories: [r.workspace],
      approvalPolicy: "never" as const, networkAccessEnabled: false, webSearchMode: "disabled" as const,
      skipGitRepoCheck: true, model: r.task.config.model,
    };
    // A half-finished turn with admitted write-tools may have had unjournaled effects.
    check(!r.previous || !r.task.capabilities.some(c => c.sideEffect && r.refs.includes(capabilityRef(c))),
      "UNCERTAIN_SIDE_EFFECT", "Review incomplete model turn with write-tools before recovery", 409);
    const thread = r.previous?.threadId ? codex.resumeThread(r.previous.threadId, options) : codex.startThread(options);
    const { events } = await thread.runStreamed(
      `${r.prompt}\nShared task workspace: ${r.workspace}\nSelected Skills: ${
        r.task.capabilities.filter(c => c.kind === "skill" && r.refs.includes(capabilityRef(c))).map(c => `$${c.id}`).join(", ")
      }`, { outputSchema: r.schema, signal: r.signal });
    let answer = "";
    let completed = false;
    let seq = 0;
    for await (const event of events) {
      r.signal.throwIfAborted();
      await this.record(r, event, seq++);
      if (event.type === "item.completed" && event.item.type === "agent_message") answer = event.item.text;
      if (event.type === "turn.completed") completed = true;
      check(event.type !== "turn.failed" && event.type !== "error", "MODEL_FAILED", "Codex reported execution failure", 502);
    }
    check(completed, "MODEL_DISCONNECTED", "Stream ended without a completed turn", 502);
    const result: Json = r.schema ? json(JSON.parse(answer)) : answer;
    if (r.schema) validate(r.schema, result);
    return result;
  }
  private async materializeSkills(r: ModelRequest): Promise<string[]> {
    const paths: string[] = [];
    for (const c of r.task.capabilities.filter(c => c.kind === "skill" && r.refs.includes(capabilityRef(c)))) {
      const { digest, ...content } = c;
      check(hash(content) === digest && c.skillMarkdown, "ARTIFACT_DRIFT", "Skill artifact changed");
      const directory = resolve(r.workspace, ".ark", "contexts", r.node, ".agents", "skills", c.id);
      await mkdir(directory, { recursive: true });
      const path = resolve(directory, "SKILL.md");
      await writeFile(path, c.skillMarkdown, "utf8");
      paths.push(path);
    }
    return paths;
  }
  private async record(r: ModelRequest, event: ThreadEvent, seq: number): Promise<void> {
    const prefix = `${r.task.attempts}/${r.node}/${seq}`;
    if (event.type === "thread.started") {
      const entries = await r.client.entries();
      const entry = entries.find(e => e.key === r.node);
      if (entry) await r.client.checkpoint({ ...entry, threadId: event.thread_id });
    }
    if (event.type === "turn.completed") {
      await r.client.action("usage", {
        key: prefix, usage: { input: event.usage.input_tokens, cached: event.usage.cached_input_tokens, output: event.usage.output_tokens },
      });
    }
    // Deliberately no prompts, arguments, tool output, reasoning, credentials or full command lines in progress events.
    const itemType = "item" in event ? event.item.type : null;
    await r.client.log(`sdk/${prefix}`, event.type, { node: r.node, itemType });
  }
}

/** 显式离线验收替身，绝不宣称调用过 Codex 或产生真实 token 用量。 */
export class DemoModel implements ModelAdapter {
  async run(r: ModelRequest): Promise<Json> {
    r.signal.throwIfAborted();
    if (r.node === "__draft") return {
      name: "temporary-draft", version: "1.0.0", description: "Offline demonstration plan",
      nodes: [{ id: "answer", needs: [], kind: "agent", prompt: r.task.input.prompt, capabilities: [] }],
    };
    await r.client.log(`demo/${r.node}/${r.task.attempts}`, "demo.model", { node: r.node, simulated: true });
    return `[OFFLINE DEMO] ${r.prompt}`;
  }
}
