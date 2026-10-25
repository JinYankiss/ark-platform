/**
 * 文档行为实现 A01/D01/G03 + 项目表示适配。
 * 上游是程序控制流；此处 DAG 是安全、可检查的 Draft 序列化格式，不执行模型生成 JS。
 */
import type { Json, Schema, WorkflowDefinition, WorkflowNode } from "../core/contracts.js";
import { check, compileSchema, hash, validate } from "../core/validation.js";
import { Database } from "../storage/database.js";

export const definitionSchema: Schema = {
  type: "object", additionalProperties: false, required: ["name", "version", "description", "nodes"],
  properties: {
    name: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,63}$" },
    version: { type: "string", pattern: "^\\d+\\.\\d+\\.\\d+$" },
    description: { type: "string", maxLength: 2000 },
    nodes: {
      type: "array", minItems: 1, maxItems: 100,
      items: {
        type: "object", additionalProperties: false, required: ["id", "needs", "kind"],
        properties: {
          id: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,63}$" },
          needs: { type: "array", uniqueItems: true, items: { type: "string" } },
          kind: { type: "string", enum: ["agent", "tool", "pause", "verify"] },
          prompt: { type: "string", maxLength: 32000 },
          capabilities: { type: "array", uniqueItems: true, items: { type: "string" } },
          outputSchema: { type: "object" },
          capability: { type: "string" },
          input: {},
          message: { type: "string", maxLength: 2000 },
          command: { type: "string" },
          finishEarly: { type: "boolean" },
          when: {
            type: "object", additionalProperties: false, required: ["node", "equals"],
            properties: { node: { type: "string" }, equals: {} },
          },
        },
      },
    },
  },
};
export function parseDefinition(value: unknown): WorkflowDefinition {
  validate(definitionSchema, value);
  // The AJV structural boundary is followed by discriminated node semantic checks.
  const definition = value as WorkflowDefinition;
  const byId = new Map(definition.nodes.map(n => [n.id, n]));
  check(byId.size === definition.nodes.length, "INVALID_WORKFLOW", "Duplicate node");
  for (const n of definition.nodes) {
    check(n.needs.every(id => byId.has(id) && id !== n.id), "INVALID_WORKFLOW", "Missing/self dependency");
    check(!n.when || n.needs.includes(n.when.node), "INVALID_WORKFLOW", "Condition must reference a direct dependency");
    validateNode(n);
  }
  const visiting = new Set<string>();
  const done = new Set<string>();
  function visit(n: WorkflowNode): void {
    if (done.has(n.id)) return;
    check(!visiting.has(n.id), "INVALID_WORKFLOW", "Dependency cycle");
    visiting.add(n.id);
    for (const id of n.needs) {
      const dependency = byId.get(id);
      if (dependency) visit(dependency);
    }
    visiting.delete(n.id);
    done.add(n.id);
  }
  definition.nodes.forEach(visit);
  return JSON.parse(JSON.stringify(definition)) as WorkflowDefinition;
}
function validateNode(n: WorkflowNode): void {
  if (n.kind === "agent") check(n.prompt && Array.isArray(n.capabilities), "INVALID_WORKFLOW", "Agent prompt/capabilities required");
  if (n.kind === "agent" && n.outputSchema) compileSchema(n.outputSchema);
  if (n.kind === "tool") check(n.capability && Object.hasOwn(n, "input"), "INVALID_WORKFLOW", "Tool ref/input required");
  if (n.kind === "pause") check(n.message, "INVALID_WORKFLOW", "Pause message required");
  if (n.kind === "verify") check(n.command && typeof n.finishEarly === "boolean", "INVALID_WORKFLOW", "Verification command required");
}
export class DefinitionRegistry {
  constructor(private readonly db: Database) {}
  publish(value: unknown): WorkflowDefinition {
    const d = parseDefinition(value);
    this.db.transaction(() => this.db.insert("definitions", `${d.name}@${d.version}`, { definition: d, digest: hash(d) }));
    return d;
  }
  get(ref: string): WorkflowDefinition {
    const saved = this.db.require<{ definition: WorkflowDefinition; digest: string }>("definitions", ref);
    check(hash(saved.definition) === saved.digest, "DEFINITION_DRIFT", "Definition changed", 409);
    return saved.definition;
  }
}
/** 显式引用依赖结果，禁止模板插值后误把 JSON 当代码。 */
export function resolveInput(value: Json, outputs: Record<string, Json>): Json {
  if (Array.isArray(value)) return value.map(v => resolveInput(v, outputs));
  if (value !== null && typeof value === "object") {
    if (Object.keys(value).length === 1 && typeof value.$result === "string") {
      check(Object.hasOwn(outputs, value.$result), "MISSING_RESULT", "Referenced result is unavailable");
      return outputs[value.$result] ?? null;
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveInput(v, outputs)]));
  }
  return value;
}
