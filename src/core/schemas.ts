/** Ark 自有协议 Schema，项目适配。上游没有这些同名企业服务 API。 */
import type { Schema } from "./contracts.js";
const strings = { type: "array", items: { type: "string" }, uniqueItems: true };
export const inputSchema: Schema = {
  type: "object", additionalProperties: false, required: ["prompt", "mode"],
  properties: {
    prompt: { type: "string", minLength: 1, maxLength: 32000 },
    mode: { enum: ["direct", "workflow", "draft"] }, workflow: { type: "string" }, capabilities: strings,
  },
};
export const capabilitySchema: Schema = {
  type: "object", additionalProperties: false,
  required: ["id", "version", "kind", "description", "source", "visibleTo", "executableBy", "timeoutMs"],
  properties: {
    id: { type: "string" }, version: { type: "string" }, kind: { enum: ["tool", "skill"] },
    description: { type: "string" }, source: { type: "string" },
    visibleTo: strings, executableBy: strings, timeoutMs: { type: "integer" },
    inputSchema: { type: "object" }, handler: { enum: ["kb.search", "ticket.create", "text.stats"] },
    sideEffect: { type: "boolean" }, skillMarkdown: { type: "string" },
  },
};
export const configSchema: Schema = {
  type: "object", additionalProperties: false,
  required: ["version", "businessLine", "workspaceProfile", "capabilities", "features", "limits", "sandbox", "validationCommands", "business"],
  properties: {
    version: { type: "string" }, businessLine: { type: "string" }, workspaceProfile: { type: "string" },
    model: { type: "string" }, capabilities: strings, sandbox: { enum: ["read-only", "workspace-write"] },
    features: {
      type: "object", additionalProperties: false, required: ["draft", "tools"],
      properties: { draft: { type: "boolean" }, tools: { type: "boolean" } },
    },
    limits: {
      type: "object", additionalProperties: false, required: ["concurrency", "modelCalls", "activeMs", "outputTokens"],
      properties: { concurrency: { type: "integer", minimum: 1 }, modelCalls: { type: "integer", minimum: 1 },
        taskAttempts: { type: "integer", minimum: 1, maximum: 10 },
        activeMs: { type: "integer", minimum: 1 }, outputTokens: { type: "integer", minimum: 1 } },
    },
    validationCommands: { type: "object", additionalProperties: { type: "array", minItems: 1, items: { type: "string" } } },
    business: { type: "object" },
  },
};
