import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { fixture, user, userToken, waitUntil } from "./helpers.js";
import { hash } from "../src/core/validation.js";
import type { ModelAdapter } from "../src/runner/model.js";

test("failure recovery replays a completed dependency; failed node alone reruns", async () => {
  const f = await fixture();
  let a = 0, b = 0;
  const model: ModelAdapter = { run: async r => {
    if (r.node === "first") { a++; return "first-output"; }
    b++;
    if (b === 1) throw new Error("temporary failure");
    return "recovered";
  } };
  try {
    f.tasks.definitions.publish({ name: "recovery", version: "1.0.0", description: "", nodes: [
      { id: "first", kind: "agent", needs: [], prompt: "first", capabilities: [] },
      { id: "second", kind: "agent", needs: ["first"], prompt: "second", capabilities: [] },
    ] });
    const task = f.tasks.submit(user, { mode: "workflow", workflow: "recovery@1.0.0", prompt: "x", capabilities: [] }, "recover");
    await f.runner(model).run(new AbortController().signal, true);
    assert.equal(f.tasks.get(task.id).state, "failed");
    f.tasks.resume(task.id);
    await f.runner(model).run(new AbortController().signal, true);
    assert.equal(f.tasks.get(task.id).state, "succeeded");
    assert.equal(a, 1);
    assert.equal(b, 2);
  } finally { await f.close(); }
});
test("independent verification failure is failed, never early success; arbitrary evidence is rejected", async () => {
  const f = await fixture();
  try {
    f.tasks.configs.publish({ ...f.tasks.configs.resolve("engineering"), version: "failed-check",
      validationCommands: { fail: [process.execPath, "-e", "process.exit(1)"] } });
    f.tasks.definitions.publish({ name: "verify-failure", version: "1.0.0", description: "",
      nodes: [{ id: "check", needs: [], kind: "verify", command: "fail", finishEarly: true }] });
    const task = f.tasks.submit(user, { mode: "workflow", workflow: "verify-failure@1.0.0", prompt: "x" }, "verify-fail");
    await f.runner().run(new AbortController().signal, true);
    assert.equal(f.tasks.get(task.id).state, "failed");
    assert.equal(f.tasks.get(task.id).earlyEvidence, undefined);
    const second = f.tasks.submit(user, { mode: "direct", prompt: "y" }, "fake-proof");
    const claimed = f.tasks.claim("r");
    assert.throws(() => f.tasks.finish(second.id, claimed?.lease?.token ?? "", "succeeded", "fake", undefined,
      { kind: "command", exitCode: 0 }), /verification evidence/);
  } finally { await f.close(); }
});
test("active timeout aborts model and waits for cleanup", async () => {
  const f = await fixture(1500);
  let cleaned = false;
  const blocked: ModelAdapter = { run: async r => {
    try { await sleep(60_000, undefined, { signal: r.signal }); return "wrong"; }
    finally { cleaned = true; }
  } };
  try {
    f.tasks.configs.publish({ ...f.tasks.configs.resolve("engineering"), version: "timeout",
      limits: { concurrency: 1, modelCalls: 5, activeMs: 150, outputTokens: 50 } });
    const task = f.tasks.submit(user, { mode: "direct", prompt: "x", capabilities: [] }, "timeout");
    await f.runner(blocked).run(new AbortController().signal, true);
    assert.equal(f.tasks.get(task.id).state, "failed");
    assert.equal(f.tasks.get(task.id).error, "EXECUTION_ABORTED");
    assert.equal(cleaned, true);
  } finally { await f.close(); }
});
test("replaced lease aborts old Runner locally; stale execution never writes success", async () => {
  const f = await fixture();
  let entered = false, cleaned = false;
  const blocked: ModelAdapter = { run: async r => {
    entered = true;
    try { await sleep(60_000, undefined, { signal: r.signal }); return "stale"; }
    finally { cleaned = true; }
  } };
  try {
    const task = f.tasks.submit(user, { mode: "direct", prompt: "x", capabilities: [] }, "lost-lease");
    const running = f.runner(blocked).run(new AbortController().signal, true);
    await waitUntil(() => entered);
    const latest = f.tasks.get(task.id);
    assert.ok(latest.lease);
    f.tasks.db.put("tasks", task.id, { ...latest, lease: { ...latest.lease, token: "replaced" } });
    await running;
    assert.equal(cleaned, true);
    assert.equal(f.tasks.get(task.id).state, "running");
    assert.equal(f.tasks.get(task.id).result, undefined);
  } finally { await f.close(); }
});
test("SSE is real streaming, cursor-based reconnection skips previously acknowledged events", async () => {
  const f = await fixture();
  const controller = new AbortController();
  try {
    const task = f.tasks.submit(user, { mode: "direct", prompt: "events" }, "sse");
    const last = f.tasks.db.events(task.id).at(-1);
    assert.ok(last);
    f.tasks.db.event(task, "new-event", "custom.progress", { stage: "testing" });
    const response = await fetch(`${f.url}/tasks/${task.id}/stream`, {
      headers: { authorization: `Bearer ${userToken}`, "last-event-id": String(last.seq) }, signal: controller.signal,
    });
    assert.match(response.headers.get("content-type") ?? "", /event-stream/);
    const reader = response.body?.getReader();
    assert.ok(reader);
    const result = await reader.read();
    const data = new TextDecoder().decode(result.value);
    assert.match(data, /custom.progress/);
    assert.doesNotMatch(data, /task.queued/);
    await reader.cancel();
  } finally { controller.abort(); await f.close(); }
});
test("artifact drift fails closed, event ids deduplicate and immutable checkpoints reject replacement", async () => {
  const f = await fixture();
  try {
    const task = f.tasks.submit(user, { mode: "direct", prompt: "x" }, "tamper");
    const claimed = f.tasks.claim("r");
    const lease = claimed?.lease?.token ?? "";
    const entry = { key: "a", hash: hash("input"), status: "completed" as const, result: "first" };
    f.tasks.checkpoint(task.id, lease, entry);
    assert.throws(() => f.tasks.checkpoint(task.id, lease, { ...entry, result: "second" }), /immutable/);
    f.tasks.db.event(task, "idempotent-event", "test", null);
    f.tasks.db.event(task, "idempotent-event", "test", null);
    assert.equal(f.tasks.db.events(task.id).filter(e => e.key === "idempotent-event").length, 1);
    const original = f.tasks.catalog.list("engineering").find(c => c.id === "text-stats");
    assert.ok(original);
    f.tasks.db.put("capabilities", "tool:text-stats@1.0.0", { ...original, digest: "tampered" });
    assert.throws(() => f.tasks.catalog.admit(task, "tool:text-stats@1.0.0"), /mismatch/);
  } finally { await f.close(); }
});
