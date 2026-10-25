/**
 * 文档行为实现 G04/G08/Z06/O05 + 项目适配：唯一的实际 Tool 调用边界。
 * 来源集合过滤不是授权。直接节点和 MCP 都进此网关，重新检查启停/冻结/业务线。
 * 本地 ticket 事务幂等；未来远端副作用若结果不明，只能 uncertain，不得盲重试。
 */
import { setTimeout as sleep } from "node:timers/promises";
import type { Json, PublishedCapability, Task } from "../core/contracts.js";
import { ArkError, check, errorCode, hash, json, object, text, token, validate } from "../core/validation.js";
import { TaskService } from "../core/task-service.js";

interface Invocation {
  digest: string;
  status: "started" | "completed" | "uncertain";
  result?: Json;
}
interface Grant { taskId: string; lease: string; node: string; refs: string[] }
export class ToolGateway {
  constructor(private readonly tasks: TaskService) {}
  grant(taskId: string, lease: string, node: string, refs: string[]): string {
    const task = this.tasks.fenced(taskId, lease);
    check(!task.cancelRequested, "CANCELLED", "Task cancellation pending", 409);
    for (const ref of refs) this.tasks.catalog.admit(task, ref);
    check(new Set(refs).size === refs.length, "INVALID_INPUT", "Duplicate node capability");
    const secret = token();
    this.tasks.db.insert("grants", hash(secret), { taskId, lease, node, refs });
    this.tasks.db.event(task, `bindings/${task.attempts}/${node}`, "capability.bound", {
      node, refs, skillAttribution: "selected_not_proven_used",
    });
    return secret;
  }
  scope(secret: string): { grant: Grant; task: Task; tools: PublishedCapability[] } {
    const grant = this.tasks.db.require<Grant>("grants", hash(secret));
    const task = this.tasks.fenced(grant.taskId, grant.lease);
    check(!task.cancelRequested, "CANCELLED", "Task cancellation pending", 409);
    const tools = grant.refs.map(r => this.tasks.catalog.admit(task, r)).filter(c => c.kind === "tool");
    return { grant, task, tools };
  }
  async invoke(taskId: string, lease: string, node: string, ref: string, input: Json,
    invocationKey: string, signal?: AbortSignal): Promise<Json> {
    const task = this.tasks.fenced(taskId, lease);
    check(!task.cancelRequested, "CANCELLED", "Task cancellation pending", 409);
    const capability = this.tasks.catalog.admit(task, ref);
    check(capability.kind === "tool" && capability.inputSchema, "INVALID_CAPABILITY", "Not a tool");
    validate(capability.inputSchema, input);
    const key = `${taskId}/${node}/${invocationKey}`;
    const digest = hash([ref, capability.digest, input]);
    const previous = this.tasks.db.get<Invocation>("invocations", key);
    if (previous) {
      check(previous.digest === digest, "IDEMPOTENCY_CONFLICT", "Tool key reused with different args", 409);
      if (previous.status === "completed") return previous.result ?? null;
      check(!capability.sideEffect, "UNCERTAIN_SIDE_EFFECT", "Reconcile ambiguous operation before retrying", 409);
    }
    this.tasks.db.put("invocations", key, { digest, status: "started" });
    const control = new AbortController();
    const watcher = setInterval(() => {
      try {
        const latest = this.tasks.fenced(taskId, lease);
        if (latest.cancelRequested || !this.tasks.catalog.enabled(ref)) control.abort(new Error("Tool admission revoked"));
      } catch (error) { control.abort(error); }
    }, 100);
    const timeout = AbortSignal.timeout(capability.timeoutMs);
    const combined = AbortSignal.any([signal ?? new AbortController().signal, control.signal, timeout]);
    const start = Date.now();
    try {
      combined.throwIfAborted();
      const result = await this.execute(task, capability, object(input), key, combined);
      combined.throwIfAborted();
      this.tasks.fenced(taskId, lease);
      this.tasks.db.put("invocations", key, { digest, status: "completed", result });
      this.tasks.db.put("capability-usage", key, {
        taskId, node, capability: ref, kind: "tool", calls: 1, durationMs: Date.now() - start,
        inputTokens: null, outputTokens: null, attribution: "tool_call_measured_tokens_unknown",
      });
      this.tasks.db.event(task, `tool/${key}`, "tool.completed", {
        node, capability: ref, durationMs: Date.now() - start, tokenAttribution: "unknown",
      });
      return result;
    } catch (error) {
      this.tasks.db.put("invocations", key, { digest, status: capability.sideEffect ? "uncertain" : "started" });
      this.tasks.db.event(task, `tool/error/${key}/${token()}`, "tool.failed", {
        node, capability: ref, code: timeout.aborted ? "TOOL_TIMEOUT" : combined.aborted ? "TOOL_CANCELLED" : errorCode(error),
      });
      if (timeout.aborted) throw new ArkError("TOOL_TIMEOUT", "Tool deadline exceeded", 504);
      throw error;
    } finally { clearInterval(watcher); }
  }
  private async execute(task: Task, c: PublishedCapability, input: Record<string, unknown>,
    key: string, signal: AbortSignal): Promise<Json> {
    if (c.handler === "text.stats") {
      const value = text(input.text, "text");
      return { characters: value.length, words: value.trim().split(/\s+/).length };
    }
    if (c.handler === "kb.search") {
      const query = text(input.query, "query", 200).toLowerCase();
      await sleep(1, undefined, { signal });
      const documents = task.config.business.documents;
      check(Array.isArray(documents), "INVALID_BUSINESS_CONFIG", "Knowledge documents missing");
      return json(documents.filter(d => JSON.stringify(d).toLowerCase().includes(query)).slice(0, 10));
    }
    if (c.handler === "ticket.create") {
      text(input.title, "title", 200);
      return this.tasks.db.transaction(() => {
        // Persisting the local side effect and lookup key in the same DB transaction closes this local ambiguity.
        const existing = this.tasks.db.get<Json>("tickets", key);
        if (existing) return existing;
        signal.throwIfAborted();
        this.tasks.fenced(task.id, task.lease?.token ?? "");
        const ticket = { id: `ARK-${token().slice(0, 10)}`, title: String(input.title), businessLine: task.businessLine };
        this.tasks.db.insert("tickets", key, ticket);
        return ticket;
      });
    }
    throw new ArkError("UNREGISTERED_HANDLER", "No executable handler");
  }
}
