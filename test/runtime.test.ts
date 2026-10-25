import test from "node:test";
import assert from "node:assert/strict";
import { hash } from "../src/core/validation.js";
import { seed, services } from "../src/bootstrap.js";
import { FeishuIngress, parseMessage } from "../src/ingress/feishu.js";
import { metrics } from "../src/observability/metrics.js";
import { fixture, user, userToken, adminToken, waitUntil } from "./helpers.js";
import type { ModelAdapter } from "../src/runner/model.js";
import type { Task } from "../src/core/contracts.js";
import { setTimeout as sleep } from "node:timers/promises";

test("message idempotency detects changed input and retains trace identity", async () => {
  const f = await fixture();
  try {
    const input = { mode: "direct" as const, prompt: "hello" };
    const a = f.tasks.submit(user, input, "a", "00-12345678901234567890123456789012-1234567890123456-01");
    assert.equal(a.id, f.tasks.submit(user, input, "a").id);
    assert.match(a.traceparent, /^00-12345678901234567890123456789012-/);
    assert.throws(() => f.tasks.submit(user, { ...input, prompt: "different" }, "a"), /different input/);
    assert.equal(f.tasks.db.list("tasks").length, 1);
  } finally { await f.close(); }
});
test("lease reclaim changes fencing token and stale runner cannot commit", async () => {
  let now = 1000;
  const tasks = services(":memory:", 100, () => now);
  seed(tasks);
  const submitted = tasks.submit(user, { mode: "direct", prompt: "x" }, "x");
  const a = tasks.claim("a");
  assert.ok(a?.lease);
  assert.equal(tasks.claim("b"), null);
  now = 1101;
  const b = tasks.claim("b");
  assert.ok(b?.lease);
  assert.notEqual(a.lease.token, b.lease.token);
  assert.throws(() => tasks.finish(submitted.id, a.lease?.token ?? "", "succeeded", "stale"), /lease/);
  tasks.checkpoint(submitted.id, b.lease.token, { key: "step", hash: hash("x"), status: "completed", result: "durable" });
  assert.equal(tasks.journal(submitted.id)[0]?.result, "durable");
  tasks.db.close();
});
test("automatic lease recovery has a bounded attempt count instead of infinite reclaims", () => {
  let now = 1000;
  const tasks = services(":memory:", 100, () => now);
  try {
    seed(tasks);
    const task = tasks.submit(user, { mode: "direct", prompt: "bounded" }, "bounded");
    assert.ok(tasks.claim("one"));
    now += 101; assert.ok(tasks.claim("two"));
    now += 101; assert.ok(tasks.claim("three"));
    now += 101; assert.equal(tasks.claim("four"), null);
    assert.equal(tasks.get(task.id).state, "failed");
    assert.equal(tasks.get(task.id).error, "ATTEMPT_LIMIT");
    assert.equal(tasks.get(task.id).attempts, 3);
  } finally { tasks.db.close(); }
});
test("Direct traverses Ark HTTP and Runner; no draft; success result and no fabricated demo tokens", async () => {
  const f = await fixture();
  try {
    const task = f.tasks.submit(user, { mode: "direct", prompt: "read this" }, "direct");
    await f.runner().run(new AbortController().signal, true);
    const done = f.tasks.get(task.id);
    assert.equal(done.state, "succeeded");
    assert.match(String(done.result), /OFFLINE DEMO/);
    assert.equal(done.definition, undefined);
    assert.equal(done.modelCalls, 1);
    assert.equal(done.outputTokens, 0);
    assert.ok(f.tasks.db.events(task.id).some(e => e.type === "demo.model"));
  } finally { await f.close(); }
});
test("cross-service cancel reaches model AbortSignal and waits for execution cleanup", async () => {
  const f = await fixture();
  let entered = false, cleaned = false;
  const model: ModelAdapter = { run: async r => {
    entered = true;
    try { await sleep(30_000, undefined, { signal: r.signal }); return "should not complete"; }
    finally { cleaned = true; }
  } };
  try {
    const task = f.tasks.submit(user, { mode: "direct", prompt: "block", capabilities: [] }, "cancel");
    const running = f.runner(model).run(new AbortController().signal, true);
    await waitUntil(() => entered);
    const res = await fetch(`${f.url}/tasks/${task.id}/cancel`, {
      method: "POST", headers: { authorization: `Bearer ${userToken}`, "content-type": "application/json" }, body: "{}",
    });
    assert.equal(res.status, 200);
    await running;
    assert.equal(f.tasks.get(task.id).state, "cancelled");
    assert.equal(cleaned, true);
    assert.throws(() => f.tasks.resume(task.id), /resum/);
  } finally { await f.close(); }
});
test("transaction terminal arbitration: cancellation wins if persisted first; terminal success remains success", async () => {
  const f = await fixture();
  try {
    const a = f.tasks.submit(user, { mode: "direct", prompt: "a" }, "a");
    const claimed = f.tasks.claim("r");
    f.tasks.cancel(a.id);
    assert.equal(f.tasks.finish(a.id, claimed?.lease?.token ?? "", "succeeded", "late").state, "cancelled");
    const b = f.tasks.submit(user, { mode: "direct", prompt: "b" }, "b");
    const next = f.tasks.claim("r");
    f.tasks.finish(b.id, next?.lease?.token ?? "", "succeeded", "first");
    assert.equal(f.tasks.cancel(b.id).state, "succeeded");
  } finally { await f.close(); }
});
test("HTTP authenticates roles/ownership, validates bodies and supports durable cursor events", async () => {
  const f = await fixture();
  try {
    assert.equal((await fetch(`${f.url}/capabilities`)).status, 401);
    const headers = { authorization: `Bearer ${userToken}`, "content-type": "application/json", "idempotency-key": "http" };
    assert.equal((await fetch(`${f.url}/tasks`, { method: "POST", headers, body: '{"mode":"hacked"}' })).status, 400);
    const created = await fetch(`${f.url}/tasks`, { method: "POST", headers, body: JSON.stringify({ mode: "direct", prompt: "hi" }) });
    const task = await created.json() as Task;
    assert.equal(created.status, 200);
    const events = await (await fetch(`${f.url}/tasks/${task.id}/events`, { headers })).json() as Array<{ seq: number }>;
    const after = await (await fetch(`${f.url}/tasks/${task.id}/events?after=${events.at(-1)?.seq}`, { headers })).json();
    assert.deepEqual(after, []);
    assert.equal((await fetch(`${f.url}/admin/configs`, { method: "POST", headers, body: "{}" })).status, 403);
    assert.equal((await fetch(`${f.url}/admin/configs`, { method: "POST",
      headers: { authorization: `Bearer ${adminToken}` }, body: "{}" })).status, 400);
    assert.throws(() => f.tasks.authorize({ ...user, id: "other" }, task.id), /another/);
    assert.match(metrics(f.tasks.db), /ark_success_ratio NaN/);
  } finally { await f.close(); }
});
test("Feishu trusted tenant/user binding, duplicate delivery, commands and bot ownership", async () => {
  const f = await fixture();
  try {
    const ingress = new FeishuIngress(f.tasks, [{ openId: "ou_1", tenantKey: "tenant", principal: user }]);
    const content = JSON.stringify({ text: "/draft inspect" });
    const first = ingress.accept("ou_1", "tenant", "om_1", "chat_1", content);
    assert.equal(ingress.accept("ou_1", "tenant", "om_1", "chat_1", content).id, first.id);
    assert.equal(f.tasks.db.list("feishu-delivery").length, 1);
    assert.throws(() => ingress.accept("ou_1", "spoof", "om_1", "chat_1", content), /bound/);
    ingress.accept("ou_1", "tenant", "om_2", "chat_1", JSON.stringify({ text: `/cancel ${first.id}` }));
    assert.equal(f.tasks.get(first.id).state, "cancelled");
    const parsed = parseMessage('{"text":"/workflow bug-intake@1.0.0 issue"}');
    assert.ok("mode" in parsed);
    assert.equal(parsed.mode, "workflow");
  } finally { await f.close(); }
});
test("card event projection shows the latest progress beyond the first 1000 events without mixing tasks", () => {
  const tasks = services(":memory:");
  try {
    seed(tasks);
    const task = tasks.submit(user, { mode: "direct", prompt: "long" }, "long");
    const other = tasks.submit(user, { mode: "direct", prompt: "other" }, "other");
    assert.deepEqual(tasks.db.latestEvents("missing"), []);
    for (let i = 0; i < 1005; i++) tasks.db.event(task, `progress/${i}`, `progress.${i}`);
    tasks.db.event(other, "foreign", "must.not.appear");
    const latest = tasks.db.latestEvents(task.id);
    assert.equal(latest.length, 8);
    assert.equal(latest[0]?.type, "progress.997");
    assert.equal(latest.at(-1)?.type, "progress.1004");
    assert.ok(latest.every((event, i) => event.taskId === task.id && (i === 0 || event.seq > (latest[i - 1]?.seq ?? 0))));
    assert.equal(tasks.db.latestEvents(task.id, 1)[0]?.type, "progress.1004");
    assert.throws(() => tasks.db.latestEvents(task.id, -1), /between 1 and 1000/);
  } finally { tasks.db.close(); }
});
