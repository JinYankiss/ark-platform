/** 项目集成适配 D03/G07/G09：独立控制服务、JSON API、可重放 SSE，不是 SDK 自带服务器。 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Capability, ExecutionConfig, JournalEntry, Principal, Task, TaskInput, TaskState } from "../core/contracts.js";
import { ArkError, check, decode, json, object, text } from "../core/validation.js";
import { capabilitySchema, configSchema, inputSchema } from "../core/schemas.js";
import { TaskService } from "../core/task-service.js";
import { ToolGateway } from "../capabilities/invocation.js";
import { serveMcp } from "./mcp.js";
import { metrics } from "../observability/metrics.js";
import { telemetry } from "../observability/tracing.js";

export interface Credential { token: string; principal: Principal }
function equal(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export class ArkServer {
  readonly server: Server;
  readonly gateway: ToolGateway;
  constructor(readonly tasks: TaskService, private readonly credentials: Credential[]) {
    check(credentials.length > 0 && credentials.every(c => c.token.length >= 24),
      "INVALID_CREDENTIALS", "Use at least 24 character API credentials");
    check(new Set(credentials.map(c => c.token)).size === credentials.length,
      "INVALID_CREDENTIALS", "Duplicate credentials");
    this.gateway = new ToolGateway(tasks);
    this.server = createServer((req, res) => { void this.handle(req, res).catch(error => this.failure(res, error)); });
    this.server.requestTimeout = 30_000;
  }
  async listen(port = 0, host = "127.0.0.1"): Promise<string> {
    await new Promise<void>(resolve => this.server.listen(port, host, resolve));
    const address = this.server.address();
    check(address && typeof address !== "string", "BIND_FAILED", "No TCP address");
    return `http://${host}:${address.port}`;
  }
  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()));
  }
  private principal(req: IncomingMessage): Principal {
    const bearer = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
    const credential = this.credentials.find(c => equal(bearer, c.token));
    check(credential, "UNAUTHENTICATED", "Credential required", 401);
    return credential.principal;
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://ark.local");
    if (url.pathname === "/health") return this.reply(res, { status: "ok" });
    if (url.pathname === "/mcp") {
      check(req.method === "POST", "METHOD_NOT_ALLOWED", "Stateless MCP only accepts POST", 405);
      const secret = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      await serveMcp(this.gateway, secret, req, res, await this.body(req));
      return;
    }
    const p = this.principal(req);
    if (url.pathname.startsWith("/internal/")) {
      check(p.role === "runner", "FORBIDDEN", "Runner credential required", 403);
      check(req.method === "POST", "METHOD_NOT_ALLOWED", "POST required", 405);
      return this.reply(res, await this.internal(url.pathname, object(await this.body(req)), String(req.headers.traceparent ?? "")));
    }
    if (req.method === "GET") return this.getRoute(url, p, req, res);
    check(req.method === "POST", "METHOD_NOT_ALLOWED", "POST required", 405);
    const result = await this.postRoute(url.pathname, p, object(await this.body(req)), req);
    if (result !== null && typeof result === "object" && "lease" in result) {
      const { lease: _secret, ...publicResult } = result;
      this.reply(res, publicResult);
    } else this.reply(res, result);
  }
  private getRoute(url: URL, p: Principal, req: IncomingMessage, res: ServerResponse): void {
    if (url.pathname === "/capabilities") return this.reply(res, this.tasks.catalog.list(p.businessLine).map(c => {
      const { skillMarkdown: _body, ...metadata } = c;
      return metadata;
    }));
    if (url.pathname === "/config") return this.reply(res, this.tasks.configs.resolve(p.businessLine));
    if (url.pathname === "/metrics") {
      check(p.role === "admin", "FORBIDDEN", "Admin required", 403);
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      res.end(metrics(this.tasks.db));
      return;
    }
    const match = url.pathname.match(/^\/tasks\/([a-f0-9-]+)(?:\/(events|stream|usage|journal))?$/);
    check(match?.[1], "NOT_FOUND", "Unknown route", 404);
    const task = this.tasks.authorize(p, match[1]);
    if (match[2] === "usage") return this.reply(res, {
      modelCalls: task.modelCalls, outputTokens: task.outputTokens,
      perCapabilityTokenCost: null, attribution: "model_turn_only",
      modelTurnUsage: this.tasks.db.list<{ taskId: string }>("usage").filter(u => u.taskId === task.id).length === task.modelCalls
        ? "complete" : "partial_or_unavailable",
      capabilities: this.tasks.db.list<{ taskId: string }>("capability-usage").filter(u => u.taskId === task.id),
    });
    if (match[2] === "journal") return this.reply(res, this.tasks.journal(task.id));
    const after = Number(url.searchParams.get("after") ?? req.headers["last-event-id"] ?? 0);
    check(Number.isSafeInteger(after) && after >= 0, "INVALID_CURSOR", "Invalid event cursor");
    if (match[2] === "stream") return this.stream(task.id, after, req, res);
    if (match[2] === "events") return this.reply(res, this.tasks.db.events(task.id, after));
    const { lease: _secret, ...publicTask } = task;
    this.reply(res, publicTask);
  }
  private async postRoute(path: string, p: Principal, data: Record<string, unknown>, req: IncomingMessage): Promise<unknown> {
    if (path === "/tasks") return this.tasks.submit(p, decode<TaskInput>(inputSchema, data),
      text(req.headers["idempotency-key"], "Idempotency-Key", 200), String(req.headers.traceparent ?? ""));
    if (path.startsWith("/admin/")) {
      check(p.role === "admin", "FORBIDDEN", "Admin required", 403);
      if (path === "/admin/configs") { this.tasks.configs.publish(decode<ExecutionConfig>(configSchema, data)); return { published: true }; }
      if (path === "/admin/capabilities") return this.tasks.catalog.publish(decode<Capability>(capabilitySchema, data));
      if (path === "/admin/definitions") return this.tasks.definitions.publish(data);
      if (path === "/admin/capability-state") {
        this.tasks.catalog.setEnabled(text(data.ref, "ref"), data.enabled as boolean);
        return { updated: true };
      }
    }
    const match = path.match(/^\/tasks\/([a-f0-9-]+)\/(cancel|resume|approve)$/);
    check(match?.[1], "NOT_FOUND", "Unknown route", 404);
    this.tasks.authorize(p, match[1]);
    if (match[2] === "approve") {
      this.tasks.approve(match[1], text(data.key, "approval key", 100));
      return { approved: true };
    }
    return match[2] === "cancel" ? this.tasks.cancel(match[1]) : this.tasks.resume(match[1]);
  }
  private async internal(path: string, data: Record<string, unknown>, parent: string): Promise<unknown> {
    if (path === "/internal/claim") return this.tasks.claim(text(data.runnerId, "runnerId", 100));
    const match = path.match(/^\/internal\/tasks\/([a-f0-9-]+)$/);
    check(match?.[1], "NOT_FOUND", "Unknown runner route", 404);
    const id = match[1], lease = text(data.lease, "lease", 100);
    const task = this.tasks.fenced(id, lease);
    return telemetry.traced(`ark.${text(data.action, "action", 100)}`, parent || task.traceparent,
      { "ark.task.id": id, "ark.service": "ark" }, () => this.dispatch(task, lease, data));
  }
  private async dispatch(task: Task, lease: string, data: Record<string, unknown>): Promise<unknown> {
    const id = task.id;
    switch (data.action) {
      case "heartbeat": return this.tasks.heartbeat(id, lease);
      case "journal": return this.tasks.journal(id);
      case "checkpoint": this.tasks.checkpoint(id, lease, data.entry as JournalEntry); return true;
      case "approved": return this.tasks.approved(id, text(data.key, "key", 100));
      case "event": this.tasks.db.event(task, text(data.key, "key"), text(data.type, "event type", 100), json(data.data)); return true;
      case "definition": return this.tasks.saveDefinition(id, lease, data.definition);
      case "model-start": this.tasks.modelStart(id, lease, text(data.node, "node")); return true;
      case "usage": this.tasks.recordUsage(id, lease, text(data.key, "key"), data.usage as { input: number; output: number; cached: number }); return true;
      case "grant": {
        check(Array.isArray(data.refs) && data.refs.every(v => typeof v === "string"), "INVALID_INPUT", "Invalid refs");
        return this.gateway.grant(id, lease, text(data.node, "node"), data.refs);
      }
      case "tool": return this.gateway.invoke(id, lease, text(data.node, "node"), text(data.ref, "ref"),
        json(data.input), text(data.invocationKey, "invocation key"));
      case "verification": {
        const proof = object(data.evidence);
        check(proof.kind === "command" && proof.exitCode === 0 && typeof proof.command === "string"
          && task.config.validationCommands[proof.command], "INVALID_EVIDENCE", "Unregistered verification evidence");
        this.tasks.db.put("verification", id, json(proof));
        return true;
      }
      case "finish": return this.tasks.finish(id, lease, data.state as TaskState,
        data.result === undefined ? undefined : json(data.result), typeof data.error === "string" ? data.error : undefined,
        data.evidence === undefined ? undefined : json(data.evidence));
      default: throw new ArkError("INVALID_ACTION", "Unknown runner action");
    }
  }
  private stream(id: string, after: number, req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    let cursor = after;
    const tick = (): void => {
      for (const event of this.tasks.db.events(id, cursor)) {
        const writable = res.write(`id: ${event.seq}\nevent: progress\ndata: ${JSON.stringify(event)}\n\n`);
        cursor = event.seq;
        if (!writable) { res.end(); return; } // reconnect with last delivered ID rather than unbounded buffering
      }
      res.write(": keepalive\n\n");
    };
    tick();
    const timer = setInterval(tick, 1000);
    req.once("close", () => clearInterval(timer));
  }
  private async body(req: IncomingMessage): Promise<unknown> {
    const buffers: Buffer[] = [];
    let size = 0;
    for await (const value of req) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
      size += chunk.length;
      check(size <= 256 * 1024, "PAYLOAD_TOO_LARGE", "Body exceeds 256KiB", 413);
      buffers.push(chunk);
    }
    try { return json(JSON.parse(Buffer.concat(buffers).toString("utf8"))); }
    catch (error) {
      if (error instanceof ArkError) throw error;
      throw new ArkError("INVALID_JSON", "Malformed JSON body");
    }
  }
  private reply(res: ServerResponse, body: unknown): void {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body ?? null));
  }
  private failure(res: ServerResponse, error: unknown): void {
    if (res.headersSent) { res.end(); return; }
    const code = error instanceof ArkError ? error.code : "INTERNAL_ERROR";
    const status = error instanceof ArkError ? error.status : 500;
    if (status === 500) console.error(JSON.stringify({ level: "error", code, name: error instanceof Error ? error.name : "unknown" }));
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ code })); // no upstream response, token, prompt, stack or SQL in client errors
  }
}
