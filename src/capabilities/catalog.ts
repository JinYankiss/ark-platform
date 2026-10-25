/**
 * 文档行为实现 M02/M03/A03/Z04/G04；未移植 Go registry。
 * 精确版本元数据与内嵌 Skill 字节 hash；远端实现不在此冻结保证内。
 * Tool 使用 source-qualified ref，不能用同名 builtin 假装 MCP 权限。
 */
import type { Capability, PublishedCapability, Task } from "../core/contracts.js";
import { capabilityRef } from "../core/contracts.js";
import { check, compileSchema, hash, text, validate } from "../core/validation.js";
import { capabilitySchema } from "../core/schemas.js";
import { Database } from "../storage/database.js";

export class Catalog {
  constructor(private readonly db: Database) {}
  publish(capability: Capability): PublishedCapability {
    validate(capabilitySchema, capability);
    check(/^[a-z][a-z0-9_-]{0,63}$/.test(capability.id), "INVALID_CAPABILITY", "Invalid capability name");
    check(/^\d+\.\d+\.\d+$/.test(capability.version), "INVALID_CAPABILITY", "Exact semver required, not latest");
    text(capability.source, "source");
    text(capability.description, "description", 2000);
    check(Array.isArray(capability.visibleTo) && Array.isArray(capability.executableBy),
      "INVALID_CAPABILITY", "Business-line policies required");
    check(Number.isSafeInteger(capability.timeoutMs) && capability.timeoutMs > 0 && capability.timeoutMs <= 300_000,
      "INVALID_CAPABILITY", "Invalid timeout");
    if (capability.kind === "skill") this.validateSkill(capability);
    else {
      check(capability.kind === "tool" && capability.inputSchema && capability.handler,
        "INVALID_CAPABILITY", "Tool needs schema and registered handler");
      check(capability.inputSchema.type === "object", "INVALID_CAPABILITY", "MCP Tool schema must describe an object");
      const effects = { "kb.search": false, "text.stats": false, "ticket.create": true };
      check(Object.hasOwn(effects, capability.handler), "INVALID_CAPABILITY", "Unknown handler");
      check(capability.sideEffect === effects[capability.handler], "INVALID_CAPABILITY", "Side effect flag is server-owned");
      // Compile the schema at publication; invalid contracts never reach an invocation.
      compileSchema(capability.inputSchema);
    }
    const published = { ...capability, digest: hash(capability) };
    this.db.transaction(() => {
      this.db.insert("capabilities", capabilityRef(capability), published);
      this.db.put("capability-enabled", capabilityRef(capability), true);
    });
    return published;
  }
  private validateSkill(capability: Capability): void {
    const markdown = text(capability.skillMarkdown, "SKILL.md");
    const match = markdown.match(/^---\r?\nname: ([a-z][a-z0-9_-]*)\r?\ndescription: ([^\r\n]+)\r?\n---\r?\n([\s\S]+)$/);
    check(match && match[1] === capability.id && (match[3]?.trim().length ?? 0) > 0,
      "INVALID_SKILL", "SKILL.md needs matching name, description and body");
    check(!capability.handler && !capability.inputSchema, "INVALID_SKILL", "A Skill is not a Tool");
  }
  list(businessLine: string): PublishedCapability[] {
    return this.db.list<PublishedCapability>("capabilities")
      .filter(c => c.visibleTo.includes(businessLine) && this.enabled(capabilityRef(c)));
  }
  enabled(ref: string): boolean { return this.db.get<boolean>("capability-enabled", ref) === true; }
  setEnabled(ref: string, enabled: boolean): void {
    this.db.require("capabilities", ref);
    check(typeof enabled === "boolean", "INVALID_INPUT", "enabled must be boolean");
    this.db.put("capability-enabled", ref, enabled);
  }
  freeze(refs: string[], businessLine: string, allowed: string[]): PublishedCapability[] {
    check(new Set(refs).size === refs.length, "INVALID_CAPABILITY", "Duplicate capability ref");
    const result = refs.map(ref => {
      const c = this.db.require<PublishedCapability>("capabilities", ref);
      check(allowed.includes(ref) && c.visibleTo.includes(businessLine) && c.executableBy.includes(businessLine)
        && this.enabled(ref), "CAPABILITY_DENIED", "Capability is not admitted", 403);
      const { digest, ...content } = c;
      check(digest === hash(content), "ARTIFACT_DRIFT", "Capability artifact hash changed", 409);
      return c;
    });
    check(new Set(result.map(c => `${c.kind}:${c.id}`)).size === result.length, "AMBIGUOUS_TOOL_NAME",
      "Only one version of the same named capability may be bound");
    return result;
  }
  admit(task: Task, ref: string): PublishedCapability {
    const c = task.capabilities.find(c => capabilityRef(c) === ref);
    check(c && c.executableBy.includes(task.businessLine) && this.enabled(ref)
      && (c.kind === "skill" || task.config.features.tools), "CAPABILITY_DENIED", "Execution denied", 403);
    const current = this.db.require<PublishedCapability>("capabilities", ref);
    check(current.digest === c.digest, "ARTIFACT_DRIFT", "Frozen artifact mismatch", 409);
    return c;
  }
}
