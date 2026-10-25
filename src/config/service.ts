/**
 * 文档行为实现 A06/G10/D07 + 项目适配：Ark 提供真正的远程配置 CRUD/版本服务。
 * 与上游区别：采用明确字段覆盖，而非声称复现 Copilot 多团队合并；运行冻结，停用实时。
 */
import type { ExecutionConfig } from "../core/contracts.js";
import { check, text, validate } from "../core/validation.js";
import { configSchema } from "../core/schemas.js";
import { Database } from "../storage/database.js";

export class ConfigService {
  constructor(private readonly db: Database) {}
  publish(config: ExecutionConfig): void {
    validate(configSchema, config);
    text(config.version, "version", 100);
    text(config.businessLine, "businessLine", 100);
    check(/^[a-z0-9_-]+$/.test(config.workspaceProfile), "INVALID_CONFIG", "Invalid workspace profile");
    check(["read-only", "workspace-write"].includes(config.sandbox), "INVALID_CONFIG", "No unrestricted sandbox");
    check(config.features && typeof config.features.draft === "boolean" && typeof config.features.tools === "boolean",
      "INVALID_CONFIG", "Feature flags must be boolean");
    for (const [key, value] of Object.entries(config.limits)) {
      check(Number.isSafeInteger(value) && value > 0, "INVALID_CONFIG", `Invalid limit ${key}`);
    }
    check(config.limits.concurrency <= 16 && config.limits.modelCalls <= 1000,
      "INVALID_CONFIG", "Limits exceed platform ceiling");
    check(Array.isArray(config.capabilities) && config.capabilities.every(v => typeof v === "string"),
      "INVALID_CONFIG", "Invalid capability allowlist");
    check(Object.values(config.validationCommands).every(argv =>
      Array.isArray(argv) && argv.length > 0 && argv.every(x => typeof x === "string" && x.length > 0)),
    "INVALID_CONFIG", "Invalid validation argv");
    this.db.transaction(() => {
      this.db.insert("configs", `${config.businessLine}@${config.version}`, config);
      this.db.put("config-head", config.businessLine, config.version);
    });
  }
  resolve(businessLine: string): ExecutionConfig {
    const version = this.db.require<string>("config-head", businessLine);
    return this.db.require("configs", `${businessLine}@${version}`);
  }
  version(businessLine: string, version: string): ExecutionConfig {
    return this.db.require("configs", `${businessLine}@${version}`);
  }
}
