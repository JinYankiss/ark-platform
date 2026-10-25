import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { CodexOptions, ThreadEvent, ThreadOptions } from "@openai/codex-sdk";
import { CodexModel, type CodexPort } from "../src/runner/model.js";
import { fixture, user } from "./helpers.js";
import { Telemetry } from "../src/observability/tracing.js";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-node";

function completedEvents(): ThreadEvent[] {
  return [
    { type: "thread.started", thread_id: "test-thread" },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "answer", type: "agent_message", text: "verified adapter answer" } },
    { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 2, cache_write_input_tokens: 0, output_tokens: 4, reasoning_output_tokens: 0 } },
  ];
}
test("Codex adapter uses real typed SDK contract, materializes selected Skill and injects scoped MCP config", async () => {
  const f = await fixture();
  let config: CodexOptions | undefined;
  let threadOptions: ThreadOptions | undefined;
  let receivedPrompt = "";
  let signal: AbortSignal | undefined;
  const factory = (options: CodexOptions): CodexPort => {
    config = options;
    return {
      startThread: options => {
        threadOptions = options;
        return { runStreamed: async (prompt, options) => {
          receivedPrompt = String(prompt);
          signal = options?.signal;
          return { events: (async function* () { for (const e of completedEvents()) yield e; })() };
        } };
      },
      resumeThread: () => { throw new Error("Not a recovery turn"); },
    };
  };
  try {
    const task = f.tasks.submit(user, { mode: "direct", prompt: "triage",
      capabilities: ["skill:bug-triage@1.0.0", "tool:text-stats@1.0.0"] }, "sdk");
    const model = new CodexModel(f.url, "test-key-not-real", factory);
    await f.runner(model).run(new AbortController().signal, true);
    assert.equal(f.tasks.get(task.id).state, "succeeded");
    assert.equal(f.tasks.get(task.id).result, "verified adapter answer");
    assert.equal(f.tasks.get(task.id).outputTokens, 4);
    assert.equal(threadOptions?.sandboxMode, "read-only");
    assert.equal(threadOptions?.approvalPolicy, "never");
    assert.equal(threadOptions?.networkAccessEnabled, false);
    assert.equal(config?.env?.OPENAI_API_KEY, "test-key-not-real");
    assert.equal(config?.env?.FEISHU_APP_SECRET, undefined);
    assert.ok(signal instanceof AbortSignal);
    assert.match(receivedPrompt, /\$bug-triage/);
    const workspace = threadOptions?.workingDirectory;
    assert.ok(workspace);
    const skill = await readFile(resolve(workspace, ".agents/skills/bug-triage/SKILL.md"), "utf8");
    assert.match(skill, /Never claim a fix/);
    assert.deepEqual(config?.config?.mcp_servers, {
      ark: { url: `${f.url}/mcp`, bearer_token_env_var: "ARK_MCP_GRANT",
        enabled_tools: ["text-stats"], startup_timeout_sec: 15, tool_timeout_sec: 120 },
    });
    assert.ok(f.tasks.db.events(task.id).every(e => !JSON.stringify(e).includes("test-key-not-real")));
  } finally { await f.close(); }
});
test("incomplete read-only SDK turn persists thread id and resumes it after failure, not a fresh session", async () => {
  const f = await fixture();
  let starts = 0, resumes = 0;
  const factory = (): CodexPort => ({
    startThread: () => { starts++; return { runStreamed: async () => ({
      events: (async function* () {
        yield { type: "thread.started" as const, thread_id: "saved-thread" };
        throw new Error("simulated runtime disconnect");
      })(),
    }) }; },
    resumeThread: id => {
      assert.equal(id, "saved-thread"); resumes++;
      return { runStreamed: async () => ({ events: (async function* () { for (const e of completedEvents()) yield e; })() }) };
    },
  });
  try {
    const task = f.tasks.submit(user, { mode: "direct", prompt: "x", capabilities: [] }, "resume-sdk");
    const model = new CodexModel(f.url, "test-only", factory);
    await f.runner(model).run(new AbortController().signal, true);
    assert.equal(f.tasks.get(task.id).state, "failed");
    assert.equal(f.tasks.journal(task.id)[0]?.threadId, "saved-thread");
    f.tasks.resume(task.id);
    await f.runner(model).run(new AbortController().signal, true);
    assert.equal(f.tasks.get(task.id).state, "succeeded");
    assert.equal(starts, 1);
    assert.equal(resumes, 1);
    assert.equal(f.tasks.get(task.id).modelCalls, 2);
  } finally { await f.close(); }
});
test("telemetry exports parent/child spans without recording prompt or credentials", async () => {
  const exporter = new InMemorySpanExporter();
  const telemetry = new Telemetry(undefined, exporter);
  try {
    const parent = "00-12345678901234567890123456789012-1234567890123456-01";
    await telemetry.traced("runner.execute", parent, { "ark.task.id": "t1" }, child =>
      telemetry.traced("ark.checkpoint", child, { "ark.task.id": "t1" }, async () => 42));
    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 2);
    assert.equal(spans[0]?.spanContext().traceId, spans[1]?.spanContext().traceId);
    assert.equal(spans[0]?.parentSpanContext?.spanId, spans[1]?.spanContext().spanId);
    assert.deepEqual(spans[0]?.attributes, { "ark.task.id": "t1" });
  } finally { await telemetry.close(); }
});
