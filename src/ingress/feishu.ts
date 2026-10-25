/**
 * 官方示例改写 L01：WSClient + EventDispatcher + im.message；文档行为 Z01/Z02。
 * 选择官方长连接入口，不开放自行实现的 webhook 验签；连接鉴权由 SDK 执行。
 * 项目适配：可信 open_id 绑定、消息去重、任务控制、持久通知队列、同一消息卡片更新。
 */
import * as lark from "@larksuiteoapi/node-sdk";
import type { Principal, Task, TaskInput } from "../core/contracts.js";
import { isTerminal } from "../core/contracts.js";
import { check, object, text } from "../core/validation.js";
import type { TaskService } from "../core/task-service.js";

export interface FeishuBinding { openId: string; tenantKey: string; principal: Principal }
interface Delivery { taskId: string; chatId: string; messageId?: string; revision?: string; done: boolean }
export class FeishuIngress {
  constructor(private readonly tasks: TaskService, private readonly bindings: FeishuBinding[]) {}
  accept(openId: string, tenantKey: string, messageId: string, chatId: string, content: string): Task {
    const binding = this.bindings.find(b => b.openId === openId && b.tenantKey === tenantKey);
    check(binding, "UNBOUND_IDENTITY", "Feishu user/tenant has not been bound", 403);
    const command = parseMessage(content);
    let task: Task;
    if ("control" in command) {
      this.tasks.authorize(binding.principal, command.taskId);
      if (command.control === "approve") {
        this.tasks.approve(command.taskId, command.key ?? "");
        task = this.tasks.get(command.taskId);
      } else task = command.control === "cancel" ? this.tasks.cancel(command.taskId) : this.tasks.resume(command.taskId);
    } else {
      task = this.tasks.submit(binding.principal, command, `feishu/${tenantKey}/${messageId}`);
    }
    const existing = this.tasks.db.get<Delivery>("feishu-delivery", task.id);
    if (!existing) this.tasks.db.insert("feishu-delivery", task.id, { taskId: task.id, chatId, done: false });
    else if (!isTerminal(task.state)) this.tasks.db.put("feishu-delivery", task.id, { ...existing, done: false });
    return task;
  }
}
export function parseMessage(value: string): TaskInput | { control: "cancel" | "resume" | "approve"; taskId: string; key?: string } {
  const input = text(object(JSON.parse(value)).text, "Feishu text").trim().replace(/@_user_\d+\s*/g, "");
  const control = input.match(/^\/(cancel|resume|approve) ([a-f0-9-]+)(?: ([a-z][a-z0-9_-]*))?$/);
  if (control) return { control: control[1] as "cancel" | "resume" | "approve", taskId: control[2] ?? "", key: control[3] };
  const fixed = input.match(/^\/workflow ([a-z0-9_-]+@\d+\.\d+\.\d+) ([\s\S]+)$/);
  if (fixed) return { mode: "workflow", workflow: fixed[1], prompt: fixed[2] ?? "" };
  if (input.startsWith("/draft ")) return { mode: "draft", prompt: input.slice(7) };
  return { mode: "direct", prompt: input };
}
export class FeishuBot {
  private readonly client: lark.Client;
  private readonly ws: lark.WSClient;
  private readonly ingress: FeishuIngress;
  private timer?: NodeJS.Timeout;
  private delivering = false;
  constructor(private readonly tasks: TaskService, appId: string, appSecret: string, bindings: FeishuBinding[]) {
    check(appId && appSecret && bindings.length > 0, "INVALID_FEISHU_CONFIG", "Feishu needs app credentials and identity bindings");
    this.client = new lark.Client({ appId, appSecret, appType: lark.AppType.SelfBuild, domain: lark.Domain.Feishu });
    this.ws = new lark.WSClient({ appId, appSecret, loggerLevel: lark.LoggerLevel.error });
    this.ingress = new FeishuIngress(tasks, bindings);
  }
  async start(): Promise<void> {
    const dispatcher = new lark.EventDispatcher({}).register({
      "im.message.receive_v1": async event => {
        if (event.message.message_type !== "text" || event.sender.sender_type !== "user") return;
        this.ingress.accept(event.sender.sender_id?.open_id ?? "", event.tenant_key ?? "",
          event.message.message_id, event.message.chat_id, event.message.content);
      },
    });
    await this.ws.start({ eventDispatcher: dispatcher });
    this.timer = setInterval(() => { void this.deliver(); }, 1500);
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.ws.close();
  }
  private async deliver(): Promise<void> {
    if (this.delivering) return;
    this.delivering = true;
    try {
      for (const delivery of this.tasks.db.list<Delivery>("feishu-delivery").filter(d => !d.done)) {
        try { await this.updateCard(delivery); }
        catch (error) {
          console.error(JSON.stringify({ component: "feishu", taskId: delivery.taskId,
            code: "CARD_DELIVERY_FAILED", name: error instanceof Error ? error.name : "unknown" }));
        }
      }
    } finally { this.delivering = false; }
  }
  private async updateCard(delivery: Delivery): Promise<void> {
    const task = this.tasks.get(delivery.taskId);
    const events = this.tasks.db.latestEvents(task.id);
    const revision = `${task.state}/${events.at(-1)?.seq ?? 0}`;
    if (delivery.revision === revision) return;
    const card = {
      config: { wide_screen_mode: true },
      header: { title: { tag: "plain_text", content: `Ark · ${task.state}` } },
      elements: [{ tag: "markdown", content: [
        `任务：${task.id}`, `路径：${task.input.mode}`, `状态：${task.state}`,
        ...events.map(e => `• ${e.type}`),
        task.state === "paused" ? `审批：/approve ${task.id} <节点名>；再 /resume ${task.id}` : `取消：/cancel ${task.id}`,
      ].join("\n") }],
    };
    if (!delivery.messageId) {
      const response = await this.client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: { receive_id: delivery.chatId, msg_type: "interactive", content: JSON.stringify(card), uuid: task.id },
      });
      check(response.code === 0 && response.data?.message_id, "FEISHU_SEND_FAILED", "Card creation rejected", 502);
      delivery.messageId = response.data.message_id;
    } else {
      const response = await this.client.im.message.patch({
        path: { message_id: delivery.messageId }, data: { content: JSON.stringify(card) },
      });
      check(response.code === 0, "FEISHU_SEND_FAILED", "Card patch rejected", 502);
    }
    delivery.revision = revision;
    delivery.done = isTerminal(task.state);
    this.tasks.db.put("feishu-delivery", task.id, delivery);
  }
}
