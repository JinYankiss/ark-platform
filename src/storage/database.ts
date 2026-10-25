/**
 * 项目集成适配，依据 D03 原子 claim 与 M03 事务/唯一约束。
 * 没有移植 Devin 私有 queue 后端。SQLite BEGIN IMMEDIATE 保证本地多连接原子写入。
 * 限同机磁盘，不支持网络共享盘/多区域；生产迁移需保留唯一键和 fencing 语义。
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { check } from "../core/validation.js";
import type { Json, Task, TaskEvent } from "../core/contracts.js";

export class Database {
  readonly sql: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.sql = new DatabaseSync(path);
    this.sql.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS records (
        collection TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY(collection,id)
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL,
        event_key TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(task,event_key)
      );
      CREATE INDEX IF NOT EXISTS events_task_seq ON events(task,seq);
    `);
  }
  close(): void { this.sql.close(); }
  transaction<T>(body: () => T): T {
    this.sql.exec("BEGIN IMMEDIATE");
    try {
      const result = body();
      this.sql.exec("COMMIT");
      return result;
    } catch (error) {
      this.sql.exec("ROLLBACK");
      throw error;
    }
  }
  get<T>(collection: string, id: string): T | undefined {
    const row = this.sql.prepare("SELECT body FROM records WHERE collection=? AND id=?").get(collection, id);
    return row ? JSON.parse(String(row.body)) as T : undefined;
  }
  require<T>(collection: string, id: string): T {
    const value = this.get<T>(collection, id);
    check(value !== undefined, "NOT_FOUND", `${collection} not found`, 404);
    return value;
  }
  list<T>(collection: string): T[] {
    return this.sql.prepare("SELECT body FROM records WHERE collection=? ORDER BY rowid").all(collection)
      .map(row => JSON.parse(String(row.body)) as T);
  }
  insert(collection: string, id: string, body: unknown): void {
    check(!this.get(collection, id), "VERSION_CONFLICT", `${collection} key is immutable`, 409);
    this.sql.prepare("INSERT INTO records VALUES (?,?,?)").run(collection, id, JSON.stringify(body));
  }
  put(collection: string, id: string, body: unknown): void {
    this.sql.prepare("INSERT INTO records VALUES (?,?,?) ON CONFLICT(collection,id) DO UPDATE SET body=excluded.body")
      .run(collection, id, JSON.stringify(body));
  }
  event(task: Task, key: string, type: string, data: Json = null, at = Date.now()): void {
    const body = { taskId: task.id, key, type, at, traceparent: task.traceparent, data };
    this.sql.prepare("INSERT OR IGNORE INTO events(task,event_key,body) VALUES(?,?,?)")
      .run(task.id, key, JSON.stringify(body));
  }
  events(taskId: string, after = 0, limit = 200): TaskEvent[] {
    return this.sql.prepare("SELECT seq,body FROM events WHERE task=? AND seq>? ORDER BY seq LIMIT ?")
      .all(taskId, after, Math.min(limit, 1000)).map(row => ({
        ...JSON.parse(String(row.body)) as Omit<TaskEvent, "seq">, seq: Number(row.seq),
      }));
  }
  /** 卡片是最新状态投影，不能复用从头分页，否则长任务会一直显示旧事件。 */
  latestEvents(taskId: string, limit = 8): TaskEvent[] {
    check(Number.isSafeInteger(limit) && limit > 0 && limit <= 1000,
      "INVALID_LIMIT", "Latest event limit must be between 1 and 1000");
    return this.sql.prepare("SELECT seq,body FROM events WHERE task=? ORDER BY seq DESC LIMIT ?")
      .all(taskId, limit).reverse().map(row => ({
        ...JSON.parse(String(row.body)) as Omit<TaskEvent, "seq">, seq: Number(row.seq),
      }));
  }
}
