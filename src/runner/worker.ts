/**
 * 文档行为实现 D03/D04/O04：claim -> execute -> renew -> settle。
 * 不是 Kubernetes Operator 移植。HTTP 出错/失联即 fail closed abort，不续跑未受控任务。
 */
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Task } from "../core/contracts.js";
import { errorCode } from "../core/validation.js";
import { EarlyFinished, Paused } from "../workflow/context.js";
import { ArkClient } from "./client.js";
import { ExecutionEngine } from "./engine.js";
import { telemetry } from "../observability/tracing.js";

export class Runner {
  constructor(private readonly id: string, private readonly ark: ArkClient, private readonly engine: ExecutionEngine,
    private readonly workspaceRoot: string, private readonly heartbeatMs = 1000) {}
  async run(signal: AbortSignal, once = false): Promise<void> {
    do {
      signal.throwIfAborted();
      const task = await this.ark.claim(this.id);
      if (task) await telemetry.traced("runner.execute", task.traceparent,
        { "ark.task.id": task.id, "ark.runner.id": this.id, "ark.attempt": task.attempts },
        parent => this.execute(task, signal, parent));
      else if (!once) await sleep(300, undefined, { signal });
    } while (!once && !signal.aborted);
  }
  private async execute(task: Task, shutdown: AbortSignal, parent: string): Promise<void> {
    const client = this.ark.forTask(task);
    client.parent = parent;
    const controller = new AbortController();
    const remaining = Math.max(1, task.config.limits.activeMs - task.activeMs);
    const signal = AbortSignal.any([controller.signal, shutdown, AbortSignal.timeout(remaining)]);
    const heartbeatStop = new AbortController();
    let controlError: unknown;
    const heartbeat = (async () => {
      try {
        while (!heartbeatStop.signal.aborted) {
          const latest = await client.heartbeat();
          if (latest.cancelRequested) { controller.abort(new Error("Cancellation requested")); return; }
          await sleep(this.heartbeatMs, undefined, { signal: heartbeatStop.signal });
        }
      } catch (error) {
        if (!heartbeatStop.signal.aborted) { controlError = error; controller.abort(error); }
      }
    })();
    try {
      const workspace = resolve(this.workspaceRoot, task.config.workspaceProfile, task.id);
      await mkdir(workspace, { recursive: true });
      const result = await this.engine.execute(task, client, workspace, signal);
      signal.throwIfAborted();
      await client.action("finish", { state: "succeeded", result });
    } catch (error) {
      const latest = await client.heartbeat().catch(() => undefined);
      if (!latest || controlError) return; // Lease expiry is recovered centrally; a stale worker never writes a terminal state.
      if (latest.cancelRequested) await client.action("finish", { state: "cancelled" });
      else if (error instanceof Paused) await client.action("finish", { state: "paused" });
      else if (error instanceof EarlyFinished && !shutdown.aborted) {
        await client.action("finish", { state: "succeeded", result: error.result, evidence: error.evidence });
      } else await client.action("finish", { state: "failed", error: signal.aborted ? "EXECUTION_ABORTED" : errorCode(error) });
    } finally {
      heartbeatStop.abort();
      await heartbeat;
    }
  }
}
