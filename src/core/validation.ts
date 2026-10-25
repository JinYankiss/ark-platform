/** 项目集成适配：边界校验使用 AJV，而非冒充 G03 的部分 JSON shape validator。 */
import { createHash, randomBytes } from "node:crypto";
import { Ajv } from "ajv";
import type { Json, Schema } from "./contracts.js";

export class ArkError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
    this.name = "ArkError";
  }
}
export function check(condition: unknown, code: string, message: string, status = 400): asserts condition {
  if (!condition) throw new ArkError(code, message, status);
}
export function object(value: unknown): Record<string, unknown> {
  check(value !== null && typeof value === "object" && !Array.isArray(value), "INVALID_INPUT", "Expected object");
  return value as Record<string, unknown>;
}
export function text(value: unknown, label: string, max = 32_000): string {
  check(typeof value === "string" && value.length > 0 && value.length <= max, "INVALID_INPUT", `Invalid ${label}`);
  return value;
}
export function json(value: unknown): Json {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(json);
  const record = object(value);
  const result: Record<string, Json> = {};
  for (const [k, v] of Object.entries(record)) {
    check(!["__proto__", "constructor", "prototype"].includes(k), "INVALID_KEY", "Unsafe object key");
    result[k] = json(v);
  }
  return result;
}
export function canonical(value: unknown): string {
  const v = json(value);
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
}
// JSON roundtrip deliberately strips optional undefined properties before canonical hashing.
export const serializable = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
export const hash = (v: unknown): string => createHash("sha256").update(canonical(serializable(v))).digest("hex");
export const token = (): string => randomBytes(24).toString("hex");
const ajv = new Ajv({ allErrors: true, strict: true });
function compiled(schema: Schema): ReturnType<Ajv["compile"]> {
  try { return ajv.compile(schema); }
  catch { throw new ArkError("INVALID_SCHEMA", "Schema cannot be compiled"); }
}
export function validate(schema: Schema, value: unknown): void {
  const guard = compiled(schema);
  check(guard(value), "SCHEMA_MISMATCH", ajv.errorsText(guard.errors));
}
export function compileSchema(schema: Schema): void { compiled(schema); }
/** 单一的已验证协议解码边界，禁止业务代码使用双重类型断言绕过检查。 */
export function decode<T>(schema: Schema, value: unknown): T {
  validate(schema, value);
  return value as T;
}
export function traceparent(incoming?: string): string {
  const match = incoming?.match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-0[01]$/);
  const traceId = match && !/^0+$/.test(match[1] ?? "") ? match[1] : randomBytes(16).toString("hex");
  return `00-${traceId}-${randomBytes(8).toString("hex")}-01`;
}
export function errorCode(error: unknown): string {
  return error instanceof ArkError ? error.code : error instanceof Error && error.name === "AbortError" ? "ABORTED" : "EXECUTION_ERROR";
}
