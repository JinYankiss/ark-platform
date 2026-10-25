/** 项目接入样例，只发布真实的 3 个本地 Tool 与 1 个 Skill，不制造 100+ 占位资产。 */
import { Database } from "./storage/database.js";
import { ConfigService } from "./config/service.js";
import { Catalog } from "./capabilities/catalog.js";
import { DefinitionRegistry } from "./workflow/definition.js";
import { TaskService } from "./core/task-service.js";
import type { Capability } from "./core/contracts.js";

export function services(path: string, leaseMs = 10_000, now = Date.now): TaskService {
  const db = new Database(path);
  return new TaskService(db, new ConfigService(db), new Catalog(db), new DefinitionRegistry(db), leaseMs, now);
}
export function seed(tasks: TaskService): void {
  if (tasks.db.get("config-head", "engineering")) return;
  const tools: Array<Pick<Capability, "id" | "handler" | "description" | "inputSchema" | "sideEffect">> = [
    { id: "kb-search", handler: "kb.search" as const, description: "Search configured internal demo documents",
      inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1 } }, required: ["query"], additionalProperties: false }, sideEffect: false },
    { id: "ticket-create", handler: "ticket.create" as const, description: "Create a local demo bug ticket (not Jira/Feishu ticketing)",
      inputSchema: { type: "object", properties: { title: { type: "string", minLength: 1 } }, required: ["title"], additionalProperties: false }, sideEffect: true },
    { id: "text-stats", handler: "text.stats" as const, description: "Count characters and words",
      inputSchema: { type: "object", properties: { text: { type: "string", minLength: 1 } }, required: ["text"], additionalProperties: false }, sideEffect: false },
  ];
  for (const capability of tools) tasks.catalog.publish({
    ...capability, kind: "tool", version: "1.0.0", source: "ark/local-handlers",
    visibleTo: ["engineering"], executableBy: ["engineering"], timeoutMs: 5000,
  });
  tasks.catalog.publish({
    id: "bug-triage", version: "1.0.0", kind: "skill", description: "Evidence-first bug triage",
    source: "ark/curated-skill", visibleTo: ["engineering"], executableBy: ["engineering"], timeoutMs: 5000,
    skillMarkdown: "---\nname: bug-triage\ndescription: Triage a bug using reproducible evidence\n---\nIdentify reproduction steps, expected behavior, actual behavior and a minimal test. Never claim a fix without a passing check. Do not push or merge code.\n",
  });
  tasks.configs.publish({
    version: "1", businessLine: "engineering", workspaceProfile: "default",
    capabilities: ["tool:kb-search@1.0.0", "tool:ticket-create@1.0.0", "tool:text-stats@1.0.0", "skill:bug-triage@1.0.0"],
    features: { draft: true, tools: true }, limits: { concurrency: 3, modelCalls: 20, activeMs: 300_000, outputTokens: 100_000 },
    sandbox: "read-only", validationCommands: {},
    business: { documents: [{ title: "Runner recovery", content: "Expired leases are reclaimed with a new fencing token." }] },
  });
  tasks.definitions.publish({
    name: "bug-intake", version: "1.0.0", description: "Minimal approval-gated local ticket intake",
    nodes: [
      { id: "triage", needs: [], kind: "agent", prompt: "Triage the request and give a concise ticket title.", capabilities: ["skill:bug-triage@1.0.0"] },
      { id: "approval", needs: ["triage"], kind: "pause", message: "Review triage result before creating a local demo ticket" },
      { id: "ticket", needs: ["triage", "approval"], kind: "tool", capability: "tool:ticket-create@1.0.0", input: { title: { $result: "triage" } } },
    ],
  });
}
