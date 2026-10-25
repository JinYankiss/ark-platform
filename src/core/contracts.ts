/**
 * 项目集成适配；来源 O01/D03/G03/G04/M02，见 docs/05-implementation-map.md。
 * 这些是 Ark 的跨进程协议，不是任何一家 SDK 的扩展 API。
 */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Schema = { [key: string]: Json };
export type TaskState = "queued" | "running" | "paused" | "succeeded" | "failed" | "cancelled";
export type CapabilityRef = string;
export interface Capability {
  id: string;
  version: string;
  kind: "tool" | "skill";
  description: string;
  source: string;
  visibleTo: string[];
  executableBy: string[];
  inputSchema?: Schema;
  handler?: "kb.search" | "ticket.create" | "text.stats";
  sideEffect?: boolean;
  timeoutMs: number;
  skillMarkdown?: string;
}
export interface PublishedCapability extends Capability { digest: string }
export interface ExecutionConfig {
  version: string;
  businessLine: string;
  workspaceProfile: string;
  model?: string;
  capabilities: CapabilityRef[];
  features: { draft: boolean; tools: boolean };
  limits: { concurrency: number; modelCalls: number; activeMs: number; outputTokens: number; taskAttempts?: number };
  sandbox: "read-only" | "workspace-write";
  validationCommands: Record<string, string[]>;
  business: { [key: string]: Json };
}
export interface NodeBase { id: string; needs: string[]; when?: { node: string; equals: Json } }
export type WorkflowNode = NodeBase & (
  | { kind: "agent"; prompt: string; capabilities: CapabilityRef[]; outputSchema?: Schema }
  | { kind: "tool"; capability: CapabilityRef; input: Json }
  | { kind: "pause"; message: string }
  | { kind: "verify"; command: string; finishEarly: boolean }
);
export interface WorkflowDefinition {
  name: string;
  version: string;
  description: string;
  nodes: WorkflowNode[];
}
export interface TaskInput {
  prompt: string;
  mode: "direct" | "workflow" | "draft";
  workflow?: string;
  capabilities?: CapabilityRef[];
}
export interface Lease { token: string; runnerId: string; deadline: number; attempt: number }
export interface Task {
  id: string;
  owner: string;
  businessLine: string;
  input: TaskInput;
  state: TaskState;
  createdAt: number;
  updatedAt: number;
  traceparent: string;
  config: ExecutionConfig;
  capabilities: PublishedCapability[];
  definition?: WorkflowDefinition;
  lease?: Lease;
  attempts: number;
  cancelRequested: boolean;
  activeMs: number;
  modelCalls: number;
  outputTokens: number;
  result?: Json;
  error?: string;
  earlyEvidence?: Json;
}
export interface JournalEntry {
  key: string;
  hash: string;
  status: "started" | "completed";
  result?: Json;
  threadId?: string;
}
export interface TaskEvent {
  seq: number;
  taskId: string;
  key: string;
  type: string;
  at: number;
  traceparent: string;
  data: Json;
}
export interface Principal { id: string; businessLine: string; role: "user" | "admin" | "runner" }
export const capabilityRef = (c: Capability): string => `${c.kind}:${c.id}@${c.version}`;
export const isTerminal = (s: TaskState): boolean => ["succeeded", "failed", "cancelled"].includes(s);
