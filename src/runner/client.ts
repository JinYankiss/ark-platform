/** 项目跨服务适配 D03/G07。所有写入携带 fencing token；不把客户端超时当服务端取消。 */
import type { JournalEntry, Json, Task } from "../core/contracts.js";
import { ArkError } from "../core/validation.js";
import type { JournalPort } from "../workflow/context.js";

export class ArkClient {
  constructor(readonly baseUrl: string, private readonly credential: string, readonly timeoutMs = 5000) {}
  async request<T>(path: string, body?: unknown, signal?: AbortSignal, parent?: string): Promise<T> {
    const response = await fetch(new URL(path, this.baseUrl), {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${this.credential}`, "content-type": "application/json", ...(parent ? { traceparent: parent } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([AbortSignal.timeout(this.timeoutMs), signal ?? new AbortController().signal]),
    });
    if (!response.ok) {
      const error = await response.json() as { code?: string };
      throw new ArkError(error.code ?? "HTTP_ERROR", "Ark request rejected", response.status);
    }
    return await response.json() as T;
  }
  claim(runnerId: string): Promise<Task | null> { return this.request("/internal/claim", { runnerId }); }
  forTask(task: Task): TaskClient { return new TaskClient(this, task); }
}
export class TaskClient implements JournalPort {
  parent?: string;
  constructor(private readonly ark: ArkClient, readonly task: Task) {}
  withParent(parent: string): TaskClient {
    const client = new TaskClient(this.ark, this.task);
    client.parent = parent;
    return client;
  }
  action<T>(action: string, data: Record<string, unknown> = {}): Promise<T> {
    return this.ark.request(`/internal/tasks/${this.task.id}`, {
      action, lease: this.task.lease?.token, ...data,
    }, undefined, this.parent ?? this.task.traceparent);
  }
  entries(): Promise<JournalEntry[]> { return this.action("journal"); }
  async checkpoint(entry: JournalEntry): Promise<void> { await this.action("checkpoint", { entry }); }
  approved(key: string): Promise<boolean> { return this.action("approved", { key }); }
  async log(key: string, type: string, data: Json): Promise<void> { await this.action("event", { key, type, data }); }
  heartbeat(): Promise<Task> { return this.action("heartbeat"); }
}
