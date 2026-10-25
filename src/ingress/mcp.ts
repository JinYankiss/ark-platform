/**
 * 官方示例改写：@modelcontextprotocol/sdk@1.32.2 simpleStatelessStreamableHttp。
 * 项目适配：低层 Server 用于数据库 JSON Schema 动态目录；每次请求重新鉴权，不接受模型自报业务线。
 * MIT；见 licenses/mcp-sdk.txt。协议示例不替代实际工具准入。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { capabilityRef } from "../core/contracts.js";
import { check, hash, json } from "../core/validation.js";
import { ToolGateway } from "../capabilities/invocation.js";

export async function serveMcp(gateway: ToolGateway, secret: string, req: IncomingMessage,
  res: ServerResponse, body: unknown): Promise<void> {
  const scope = gateway.scope(secret);
  const server = new Server({ name: "ark-capability-gateway", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: gateway.scope(secret).tools.map(c => ({
      name: c.id, description: `${c.description} [${capabilityRef(c)}]`,
      inputSchema: { ...c.inputSchema, type: "object" as const },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const current = gateway.scope(secret);
    const c = current.tools.find(c => c.id === request.params.name);
    check(c, "CAPABILITY_DENIED", "Tool is not in this node scope", 403);
    const args = json(request.params.arguments ?? {});
    // A side-effecting tool can request several distinct operations with distinct args.
    // The same args within a node are deliberately idempotent, documented in the integration contract.
    const key = hash([capabilityRef(c), args]);
    const result = await gateway.invoke(scope.task.id, scope.grant.lease, scope.grant.node,
      capabilityRef(c), args, key, extra.signal);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: { result } };
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.once("close", () => { void server.close().catch(() => undefined); });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
