/**
 * 文档行为实现 D01 / G03 WorkflowContext.step/pause/parallel/pipeline。
 * 不是 Copilot 的 journal 实现。key + 输入 hash 是 Ark 语义；结果持久化后才能重放。
 * pipeline 每个 item 自己推进阶段，不设置全局阶段屏障；默认失败即中止，不吞成 null。
 */
import type { Json, JournalEntry } from "../core/contracts.js";
import { ArkError, check, hash } from "../core/validation.js";

export class Paused extends ArkError {
  constructor(public readonly key: string) { super("PAUSED", "Human approval required"); }
}
export class EarlyFinished extends Error {
  constructor(public readonly result: Json, public readonly evidence: Json) { super("Verified early finish"); }
}
export interface JournalPort {
  entries(): Promise<JournalEntry[]>;
  checkpoint(entry: JournalEntry): Promise<void>;
  approved(key: string): Promise<boolean>;
  log(key: string, type: string, data: Json): Promise<void>;
}
export class WorkflowContext {
  private saved = new Map<string, JournalEntry>();
  private inFlight = new Set<string>();
  private readonly failureController = new AbortController();
  readonly signal: AbortSignal;
  constructor(readonly port: JournalPort, signal: AbortSignal, readonly concurrency: number) {
    check(Number.isSafeInteger(concurrency) && concurrency > 0, "INVALID_CONCURRENCY", "Concurrency must be positive");
    this.signal = AbortSignal.any([signal, this.failureController.signal]);
  }
  async load(): Promise<void> { this.saved = new Map((await this.port.entries()).map(e => [e.key, e])); }
  async step(key: string, input: Json, producer: (previous?: JournalEntry) => Promise<Json>): Promise<Json> {
    this.signal.throwIfAborted();
    check(!this.inFlight.has(key), "DUPLICATE_STEP", "Concurrent duplicate step key");
    const digest = hash(input);
    const previous = this.saved.get(key);
    check(!previous || previous.hash === digest, "REPLAY_CONFLICT", "Step input or frozen definition changed", 409);
    if (previous?.status === "completed") return previous.result ?? null;
    this.inFlight.add(key);
    const started: JournalEntry = { key, hash: digest, status: "started", threadId: previous?.threadId };
    try {
      await this.port.checkpoint(started);
      const result = await producer(previous);
      this.signal.throwIfAborted();
      const entry: JournalEntry = { ...started, status: "completed", result };
      await this.port.checkpoint(entry);
      this.saved.set(key, entry);
      return result;
    } finally { this.inFlight.delete(key); }
  }
  async pause(key: string, message: string): Promise<Json> {
    return this.step(key, { pause: message }, async () => {
      if (!await this.port.approved(key)) {
        await this.port.log(`pause/${key}`, "workflow.paused", { key, message });
        throw new Paused(key);
      }
      return { approved: true };
    });
  }
  async parallel<T, R>(items: readonly T[], worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
    const results: R[] = [];
    let next = 0;
    let failed = false;
    let failure: unknown;
    const run = async (): Promise<void> => {
      while (!failed && next < items.length) {
        const index = next++;
        try {
          this.signal.throwIfAborted();
          results[index] = await worker(items[index] as T, index);
        }
        catch (error) {
          if (!failed) failure = error;
          failed = true;
          this.failureController.abort(error);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, items.length) }, run));
    if (failed) throw failure;
    return results;
  }
  async pipeline(items: Json[], stages: Array<(value: Json, index: number) => Promise<Json>>): Promise<Json[]> {
    return this.parallel(items, async (item, index) => {
      let value = item;
      for (const stage of stages) {
        this.signal.throwIfAborted();
        value = await stage(value, index);
      }
      return value;
    });
  }
  async phase(name: string, detail: Json = null): Promise<void> {
    await this.port.log(`phase/${name}`, "workflow.phase", { name, detail });
  }
}
