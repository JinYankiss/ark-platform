/**
 * 文档行为实现 D03/D04/G03/O04/Z02 + 项目集成适配。
 * 取消先落库，heartbeat 到达 Runner 后 abort；仅 Runner 收敛后确认 cancelled。
 * 完成/取消的裁决：数据库事务内先写入的 cancel 优先；终态不可改写。
 */
import { randomUUID } from "node:crypto";
import type { Json, JournalEntry, Principal, Task, TaskInput, TaskState, WorkflowDefinition } from "./contracts.js";
import { capabilityRef, isTerminal } from "./contracts.js";
import { check, hash, json, text, token, traceparent, validate } from "./validation.js";
import { inputSchema } from "./schemas.js";
import { Database } from "../storage/database.js";
import { ConfigService } from "../config/service.js";
import { Catalog } from "../capabilities/catalog.js";
import { DefinitionRegistry, parseDefinition } from "../workflow/definition.js";

export class TaskService {
  constructor(readonly db: Database, readonly configs: ConfigService, readonly catalog: Catalog,
    readonly definitions: DefinitionRegistry, readonly leaseMs = 10_000, private readonly now = Date.now) {}

  submit(principal: Principal, input: TaskInput, idempotency: string, parent?: string): Task {
    validate(inputSchema, input);
    text(idempotency, "Idempotency-Key", 200);
    text(input.prompt, "prompt");
    check(["direct", "workflow", "draft"].includes(input.mode), "INVALID_INPUT", "Invalid execution mode");
    return this.db.transaction(() => {
      const key = hash([principal.id, idempotency]);
      const existing = this.db.get<{ id: string; digest: string }>("submissions", key);
      if (existing) {
        check(existing.digest === hash(input), "IDEMPOTENCY_CONFLICT", "Key was used with different input", 409);
        return this.get(existing.id);
      }
      const config = this.configs.resolve(principal.businessLine);
      check(input.mode !== "draft" || config.features.draft, "DRAFT_DISABLED", "Draft disabled", 403);
      const definition = input.mode === "workflow" ? this.definitions.get(text(input.workflow, "workflow ref", 200)) : undefined;
      const refs = input.capabilities ?? config.capabilities;
      const capabilities = this.catalog.freeze(refs, principal.businessLine, config.capabilities);
      const task: Task = {
        id: randomUUID(), owner: principal.id, businessLine: principal.businessLine, input,
        state: "queued", createdAt: this.now(), updatedAt: this.now(), traceparent: traceparent(parent),
        config, capabilities, definition, attempts: 0, cancelRequested: false, activeMs: 0, modelCalls: 0, outputTokens: 0,
      };
      if (definition) this.admitDefinition(task, definition);
      this.db.insert("tasks", task.id, task);
      this.db.insert("submissions", key, { id: task.id, digest: hash(input) });
      this.db.event(task, "created", "task.queued", { mode: input.mode });
      return task;
    });
  }
  get(id: string): Task { return this.db.require("tasks", id); }
  authorize(principal: Principal, id: string): Task {
    const task = this.get(id);
    check(principal.role === "admin" || task.owner === principal.id, "FORBIDDEN", "Task belongs to another user", 403);
    return task;
  }
  claim(runnerId: string): Task | null {
    text(runnerId, "runnerId", 100);
    return this.db.transaction(() => {
      const tasks = this.db.list<Task>("tasks").sort((a, b) => a.createdAt - b.createdAt);
      for (const task of tasks) {
        const expired = task.state === "running" && (task.lease?.deadline ?? 0) <= this.now();
        if (expired && task.cancelRequested) {
          task.state = "cancelled";
          this.save(task, "task.cancelled", { reason: "lease_expired_after_cancel" });
          continue;
        }
        if (task.state !== "queued" && !expired) continue;
        if (expired) task.activeMs += Math.max(0, (task.lease?.deadline ?? this.now()) - task.updatedAt);
        if (expired && task.attempts >= (task.config.limits.taskAttempts ?? 3)) {
          task.state = "failed";
          task.error = "ATTEMPT_LIMIT";
          this.save(task, "task.failed", { errorCode: "ATTEMPT_LIMIT" });
          continue;
        }
        task.attempts++;
        task.state = "running";
        task.lease = { token: token(), runnerId, deadline: this.now() + this.leaseMs, attempt: task.attempts };
        this.save(task, "task.claimed", { runnerId, attempt: task.attempts, recovered: expired });
        return task;
      }
      return null;
    });
  }
  fenced(id: string, lease: string): Task {
    const task = this.get(id);
    check(task.state === "running" && task.lease?.token === lease && task.lease.deadline > this.now(),
      "LEASE_LOST", "Expired or replaced runner lease", 409);
    return task;
  }
  heartbeat(id: string, lease: string): Task {
    return this.db.transaction(() => {
      const task = this.fenced(id, lease);
      const delta = Math.max(0, this.now() - task.updatedAt);
      task.activeMs += delta;
      if (task.lease) task.lease.deadline = this.now() + this.leaseMs;
      task.updatedAt = this.now();
      this.db.put("tasks", id, task);
      return task;
    });
  }
  cancel(id: string): Task {
    return this.db.transaction(() => {
      const task = this.get(id);
      if (isTerminal(task.state)) return task;
      task.cancelRequested = true;
      if (task.state === "running") task.activeMs += Math.max(0, this.now() - task.updatedAt);
      if (task.state !== "running") task.state = "cancelled";
      this.save(task, "task.cancel_requested");
      return task;
    });
  }
  resume(id: string): Task {
    return this.db.transaction(() => {
      const task = this.get(id);
      check(["paused", "failed"].includes(task.state) && !task.cancelRequested,
        "NOT_RESUMABLE", "Only paused/failed tasks may resume", 409);
      task.state = "queued";
      task.error = undefined;
      this.save(task, "task.resumed");
      return task;
    });
  }
  finish(id: string, lease: string, state: TaskState, result?: Json, error?: string, evidence?: Json): Task {
    return this.db.transaction(() => {
      const task = this.fenced(id, lease);
      check(["succeeded", "failed", "paused", "cancelled"].includes(state), "INVALID_STATE", "Invalid terminal state");
      if (evidence !== undefined) {
        const proof = this.db.get<Json>("verification", id);
        check(proof && hash(proof) === hash(evidence), "UNVERIFIED_EARLY_FINISH", "Missing verification evidence", 409);
      }
      task.activeMs += Math.max(0, this.now() - task.updatedAt);
      task.state = task.cancelRequested ? "cancelled" : state;
      check(task.state !== "cancelled" || task.cancelRequested, "INVALID_STATE", "Cancellation must be requested");
      task.result = task.state === "succeeded" ? result : undefined;
      task.error = error;
      task.earlyEvidence = task.state === "succeeded" ? evidence : undefined;
      this.save(task, `task.${task.state}`, { errorCode: error ?? null, early: evidence !== undefined });
      return task;
    });
  }
  saveDefinition(id: string, lease: string, value: unknown): WorkflowDefinition {
    return this.db.transaction(() => {
      const task = this.fenced(id, lease);
      const definition = parseDefinition(value);
      this.admitDefinition(task, definition);
      if (task.definition) check(hash(task.definition) === hash(definition), "DEFINITION_DRIFT", "Draft is frozen", 409);
      task.definition = definition;
      this.db.put("tasks", id, task);
      this.db.event(task, "definition", "workflow.draft_saved", json(definition));
      return definition;
    });
  }
  admitDefinition(task: Task, definition: WorkflowDefinition): void {
    const bound = new Set(task.capabilities.map(capabilityRef));
    for (const n of definition.nodes) {
      const refs = n.kind === "agent" ? n.capabilities : n.kind === "tool" ? [n.capability] : [];
      check(refs.every(r => bound.has(r)), "CAPABILITY_DENIED", "Workflow references an unbound capability", 403);
      if (n.kind === "verify") check(task.config.validationCommands[n.command], "INVALID_VERIFIER", "Unregistered verifier");
      if (n.kind === "tool") check(n.capability.startsWith("tool:"), "INVALID_CAPABILITY", "Tool node requires a Tool");
    }
  }
  journal(id: string): JournalEntry[] {
    return this.db.list<JournalEntry & { taskId: string }>("journal").filter(j => j.taskId === id);
  }
  checkpoint(id: string, lease: string, entry: JournalEntry): void {
    this.db.transaction(() => {
      const task = this.fenced(id, lease);
      text(entry.key, "step key", 200);
      check(/^[a-f0-9]{64}$/.test(entry.hash) && ["started", "completed"].includes(entry.status),
        "INVALID_CHECKPOINT", "Malformed journal entry");
      const key = `${id}/${entry.key}`;
      const previous = this.db.get<JournalEntry>("journal", key);
      check(!previous || previous.hash === entry.hash, "REPLAY_CONFLICT", "Step input changed", 409);
      if (previous?.status === "completed") {
        check(entry.status === "completed" && hash(previous.result ?? null) === hash(entry.result ?? null),
          "REPLAY_CONFLICT", "Completed step is immutable", 409);
        return;
      }
      this.db.put("journal", key, { ...entry, taskId: id });
      this.db.event(task, `${task.attempts}/${entry.key}/${entry.status}/${entry.threadId ?? ""}`,
        `step.${entry.status}`, { key: entry.key });
    });
  }
  approve(id: string, key: string): void {
    const task = this.get(id);
    check(task.state === "paused", "NOT_PAUSED", "Task is not paused", 409);
    check(task.definition?.nodes.some(n => n.kind === "pause" && n.id === key),
      "INVALID_APPROVAL", "No such approval point");
    check(this.journal(id).some(e => e.key === key && e.status === "started"),
      "INVALID_APPROVAL", "Approval point has not been reached");
    this.db.put("approvals", `${id}/${key}`, true);
  }
  approved(id: string, key: string): boolean { return this.db.get("approvals", `${id}/${key}`) === true; }
  modelStart(id: string, lease: string, node: string): void {
    this.db.transaction(() => {
      const task = this.fenced(id, lease);
      check(!task.cancelRequested, "CANCELLED", "Cancellation pending", 409);
      check(task.modelCalls < task.config.limits.modelCalls && task.outputTokens < task.config.limits.outputTokens,
        "BUDGET_EXCEEDED", "Model budget exhausted", 409);
      task.modelCalls++;
      this.db.put("tasks", id, task);
      this.db.event(task, `model/${task.attempts}/${node}/${task.modelCalls}`, "model.started", { node });
    });
  }
  recordUsage(id: string, lease: string, key: string, usage: { input: number; output: number; cached: number }): void {
    this.db.transaction(() => {
      const task = this.fenced(id, lease);
      check(Object.values(usage).every(n => Number.isSafeInteger(n) && n >= 0), "INVALID_USAGE", "Invalid token counters");
      const existing = this.db.get<{ input: number; output: number; cached: number }>("usage", `${id}/${key}`);
      if (existing) {
        check(hash({ input: existing.input, output: existing.output, cached: existing.cached }) === hash(usage),
          "USAGE_CONFLICT", "Usage event key has different counters", 409);
        return;
      }
      this.db.insert("usage", `${id}/${key}`, { taskId: id, key, ...usage, attribution: "model_turn" });
      task.outputTokens += usage.output;
      this.db.put("tasks", id, task);
      this.db.event(task, `usage/${key}`, "model.usage", json(usage));
    });
  }
  private save(task: Task, type: string, data: Json = null): void {
    task.updatedAt = this.now();
    this.db.put("tasks", task.id, task);
    this.db.event(task, `${type}/${token()}`, type, data, this.now());
  }
}
