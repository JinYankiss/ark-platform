import test from "node:test";
import assert from "node:assert/strict";
import type { Json, JournalEntry } from "../src/core/contracts.js";
import { WorkflowContext, type JournalPort } from "../src/workflow/context.js";
import { parseDefinition } from "../src/workflow/definition.js";
import { services } from "../src/bootstrap.js";
import { fixture, user } from "./helpers.js";
import { DemoModel, type ModelAdapter } from "../src/runner/model.js";
import { setTimeout as sleep } from "node:timers/promises";

test("DAG rejects missing deps, cycle, duplicate ids and malformed nodes", () => {
  const make = (nodes: unknown[]) => ({ name: "test", version: "1.0.0", description: "", nodes });
  const node = { id: "a", kind: "pause", needs: [], message: "check" };
  assert.throws(() => parseDefinition(make([node, node])), /Duplicate/);
  assert.throws(() => parseDefinition(make([{ ...node, needs: ["missing"] }])), /dependency/);
  assert.throws(() => parseDefinition(make([{ ...node, needs: ["b"] }, { ...node, id: "b", needs: ["a"] }])), /cycle/);
  assert.throws(() => parseDefinition(make([{ id: "x", needs: [], kind: "agent" }])), /required/);
});
test("fixed workflow pauses, resumes after approval and replays completed model step without new call", async () => {
  const f = await fixture();
  try {
    const task = f.tasks.submit(user, { mode: "workflow", workflow: "bug-intake@1.0.0", prompt: "button broken" }, "fixed");
    await f.runner().run(new AbortController().signal, true);
    assert.equal(f.tasks.get(task.id).state, "paused");
    assert.equal(f.tasks.get(task.id).modelCalls, 1);
    f.tasks.approve(task.id, "approval");
    f.tasks.resume(task.id);
    await f.runner().run(new AbortController().signal, true);
    assert.equal(f.tasks.get(task.id).state, "succeeded");
    assert.equal(f.tasks.get(task.id).modelCalls, 1);
    assert.equal(f.tasks.db.list("tickets").length, 1);
    assert.throws(() => f.tasks.definitions.publish(task.definition), /immutable/);
  } finally { await f.close(); }
});
test("Draft saves a validated frozen plan; no executable generated source is evaluated", async () => {
  const f = await fixture();
  try {
    const task = f.tasks.submit(user, { mode: "draft", prompt: "inspect", capabilities: [] }, "draft");
    await f.runner().run(new AbortController().signal, true);
    const done = f.tasks.get(task.id);
    assert.equal(done.state, "succeeded");
    assert.equal(done.definition?.name, "temporary-draft");
    assert.equal(done.modelCalls, 2);
    assert.equal(f.tasks.journal(task.id).filter(e => e.status === "completed").length, 2);
  } finally { await f.close(); }
});
test("invalid Draft capability rejected before executing any draft nodes", async () => {
  const f = await fixture();
  const malicious: ModelAdapter = { run: async () => ({
    name: "bad", version: "1.0.0", description: "",
    nodes: [{ id: "steal", needs: [], kind: "tool", capability: "tool:secret@1.0.0", input: {} }],
  }) };
  try {
    const task = f.tasks.submit(user, { mode: "draft", prompt: "bad", capabilities: [] }, "bad");
    await f.runner(malicious).run(new AbortController().signal, true);
    assert.equal(f.tasks.get(task.id).state, "failed");
    assert.equal(f.tasks.get(task.id).error, "CAPABILITY_DENIED");
    assert.equal(f.tasks.db.list("invocations").length, 0);
  } finally { await f.close(); }
});
test("durable steps reload from a newly opened DB; changed input conflicts and pending steps rerun", async () => {
  const f = await fixture();
  try {
    const task = f.tasks.submit(user, { mode: "direct", prompt: "x" }, "x");
    const claimed = f.tasks.claim("a");
    const lease = claimed?.lease?.token ?? "";
    const port = (): JournalPort => ({
      entries: async () => f.tasks.journal(task.id), checkpoint: async entry => f.tasks.checkpoint(task.id, lease, entry),
      approved: async () => false, log: async () => undefined,
    });
    const ctx = new WorkflowContext(port(), new AbortController().signal, 2);
    await ctx.load();
    await ctx.step("saved", { version: 1 }, async () => "persisted");
    const reopened = services(`${f.root}/ark.sqlite`);
    try {
      assert.equal(reopened.journal(task.id)[0]?.result, "persisted");
      const ctx2 = new WorkflowContext(port(), new AbortController().signal, 2);
      await ctx2.load();
      assert.equal(await ctx2.step("saved", { version: 1 }, async () => { throw new Error("must not execute"); }), "persisted");
      await assert.rejects(ctx2.step("saved", { version: 2 }, async () => null), /changed/);
    } finally { reopened.db.close(); }
  } finally { await f.close(); }
});
test("programmatic pipeline advances each item without global stage barrier and respects concurrency", async () => {
  const stored = new Map<string, JournalEntry>();
  const port: JournalPort = {
    entries: async () => [...stored.values()], checkpoint: async e => { stored.set(e.key, e); },
    approved: async () => false, log: async () => undefined,
  };
  const ctx = new WorkflowContext(port, new AbortController().signal, 2);
  await ctx.load();
  const order: string[] = [];
  let active = 0, peak = 0;
  const stages = [
    async (value: Json, index: number) => ctx.step(`one-${index}`, value, async () => {
      active++; peak = Math.max(peak, active);
      await sleep(index === 0 ? 5 : 40);
      order.push(`first-${index}`); active--; return value;
    }),
    async (value: Json, index: number) => ctx.step(`two-${index}`, value, async () => {
      order.push(`second-${index}`); return value;
    }),
  ];
  assert.deepEqual(await ctx.pipeline(["fast", "slow"], stages), ["fast", "slow"]);
  assert.ok(order.indexOf("second-0") < order.indexOf("first-1"));
  assert.equal(peak, 2);
  await ctx.pipeline(["fast", "slow"], stages);
  assert.equal(order.length, 4);
});
test("verified early finish executes registered check and never launches dependent model", async () => {
  const f = await fixture();
  try {
    const config = f.tasks.configs.resolve("engineering");
    f.tasks.configs.publish({ ...config, version: "2", validationCommands: { test: [process.execPath, "-e", "process.exit(0)"] } });
    f.tasks.definitions.publish({ name: "verified", version: "1.0.0", description: "", nodes: [
      { id: "check", needs: [], kind: "verify", command: "test", finishEarly: true },
      { id: "never", needs: ["check"], kind: "agent", prompt: "do not run", capabilities: [] },
    ] });
    const task = f.tasks.submit(user, { mode: "workflow", workflow: "verified@1.0.0", prompt: "x" }, "early");
    await f.runner().run(new AbortController().signal, true);
    const done = f.tasks.get(task.id);
    assert.equal(done.state, "succeeded");
    assert.ok(done.earlyEvidence);
    assert.equal(done.modelCalls, 0);
  } finally { await f.close(); }
});
test("verified early finish aborts active sibling and waits for its finally cleanup", async () => {
  const f = await fixture();
  let cleaned = false, entered = false;
  const model: ModelAdapter = { run: async r => {
    entered = true;
    try { await sleep(30_000, undefined, { signal: r.signal }); return "late"; }
    finally { cleaned = true; }
  } };
  try {
    f.tasks.configs.publish({ ...f.tasks.configs.resolve("engineering"), version: "early-sibling",
      validationCommands: { test: [process.execPath, "-e", "setTimeout(()=>process.exit(0),200)"] } });
    f.tasks.definitions.publish({ name: "siblings", version: "1.0.0", description: "", nodes: [
      { id: "slow", needs: [], kind: "agent", prompt: "block", capabilities: [] },
      { id: "check", needs: [], kind: "verify", command: "test", finishEarly: true },
    ] });
    const task = f.tasks.submit(user, { mode: "workflow", workflow: "siblings@1.0.0", prompt: "x", capabilities: [] }, "siblings");
    await f.runner(model).run(new AbortController().signal, true);
    assert.equal(entered, true);
    assert.equal(cleaned, true);
    assert.equal(f.tasks.get(task.id).state, "succeeded");
    assert.ok(f.tasks.get(task.id).earlyEvidence);
    assert.ok(!f.tasks.journal(task.id).some(e => e.key === "slow" && e.status === "completed"));
  } finally { await f.close(); }
});
test("programmatic parallel propagates the original error, aborts siblings and awaits cleanup", async () => {
  const port: JournalPort = {
    entries: async () => [], checkpoint: async () => undefined, approved: async () => false, log: async () => undefined,
  };
  const ctx = new WorkflowContext(port, new AbortController().signal, 2);
  let cleaned = false;
  await assert.rejects(ctx.parallel([0, 1], async value => {
    if (value === 0) { await sleep(10); throw new Error("original failure"); }
    try { await sleep(30_000, undefined, { signal: ctx.signal }); }
    finally { cleaned = true; }
  }), /original failure/);
  assert.equal(cleaned, true);
});
test("resume keeps model call budgets rather than resetting them", async () => {
  const f = await fixture();
  try {
    f.tasks.configs.publish({ ...f.tasks.configs.resolve("engineering"), version: "small", limits: {
      concurrency: 1, modelCalls: 1, activeMs: 5000, outputTokens: 100,
    } });
    const task = f.tasks.submit(user, { mode: "draft", prompt: "x", capabilities: [] }, "budget");
    await f.runner(new DemoModel()).run(new AbortController().signal, true);
    assert.equal(f.tasks.get(task.id).error, "BUDGET_EXCEEDED");
    f.tasks.resume(task.id);
    await f.runner().run(new AbortController().signal, true);
    assert.equal(f.tasks.get(task.id).modelCalls, 1);
    assert.equal(f.tasks.get(task.id).state, "failed");
  } finally { await f.close(); }
});
