import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { hash } from "../src/core/validation.js";
import { fixture, user } from "./helpers.js";

test("published Tool and Skill versions are immutable, hashed and independently enabled", async () => {
  const f = await fixture();
  try {
    const skill = f.tasks.catalog.list("engineering").find(c => c.kind === "skill");
    assert.ok(skill);
    const { digest, ...definition } = skill;
    assert.equal(digest, hash(definition));
    assert.throws(() => f.tasks.catalog.publish(definition), /immutable/);
    const task = f.tasks.submit(user, { mode: "direct", prompt: "x", capabilities: ["skill:bug-triage@1.0.0"] }, "x");
    f.tasks.catalog.setEnabled("skill:bug-triage@1.0.0", false);
    assert.equal(f.tasks.catalog.list("engineering").filter(c => c.kind === "skill").length, 0);
    assert.throws(() => f.tasks.catalog.admit(task, "skill:bug-triage@1.0.0"), /denied/);
    assert.throws(() => f.tasks.catalog.publish({ ...definition, version: "2.0.0", skillMarkdown: "not a SKILL.md" }), /SKILL.md/);
  } finally { await f.close(); }
});
test("directory discovery, executable policy and source-qualified names cannot bypass admission", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(f.tasks.catalog.list("sales"), []);
    assert.throws(() => f.tasks.submit({ ...user, businessLine: "sales" }, { mode: "direct", prompt: "x" }, "sales"), /not found/);
    assert.throws(() => f.tasks.submit(user, { mode: "direct", prompt: "x", capabilities: ["builtin:ticket-create@1.0.0"] }, "spoof"), /not found/);
    const original = f.tasks.catalog.list("engineering").find(c => c.id === "text-stats");
    assert.ok(original);
    const { digest: _, ...definition } = original;
    f.tasks.catalog.publish({ ...definition, version: "2.0.0" });
    const config = f.tasks.configs.resolve("engineering");
    f.tasks.configs.publish({ ...config, version: "v2", capabilities: [...config.capabilities, "tool:text-stats@2.0.0"] });
    assert.throws(() => f.tasks.submit(user, { mode: "direct", prompt: "x",
      capabilities: ["tool:text-stats@1.0.0", "tool:text-stats@2.0.0"] }, "ambiguous"), /one version/);
  } finally { await f.close(); }
});
test("one frozen Skill can be reused by two explicitly permitted business lines", async () => {
  const f = await fixture();
  try {
    const skill = f.tasks.catalog.list("engineering").find(c => c.kind === "skill");
    assert.ok(skill);
    const { digest: _old, ...definition } = skill;
    const shared = f.tasks.catalog.publish({ ...definition, version: "2.0.0",
      visibleTo: ["engineering", "sales"], executableBy: ["engineering", "sales"] });
    const config = f.tasks.configs.resolve("engineering");
    const refs = ["skill:bug-triage@2.0.0"];
    f.tasks.configs.publish({ ...config, businessLine: "sales", version: "1", capabilities: refs });
    f.tasks.configs.publish({ ...config, version: "shared", capabilities: refs });
    const a = f.tasks.submit(user, { mode: "direct", prompt: "a" }, "shared-a");
    const b = f.tasks.submit({ ...user, id: "sales-user", businessLine: "sales" }, { mode: "direct", prompt: "b" }, "shared-b");
    assert.equal(a.capabilities[0]?.digest, shared.digest);
    assert.equal(b.capabilities[0]?.digest, shared.digest);
  } finally { await f.close(); }
});
test("Tool cancellation is a failed invocation and cannot create a side effect or be recorded as success", async () => {
  const f = await fixture();
  try {
    const task = f.tasks.submit(user, { mode: "direct", prompt: "x" }, "tool-abort");
    const active = f.tasks.claim("r");
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(f.server.gateway.invoke(task.id, active?.lease?.token ?? "", "n",
      "tool:ticket-create@1.0.0", { title: "Cancelled" }, "cancel", controller.signal));
    assert.equal(f.tasks.db.list("tickets").length, 0);
    assert.equal(f.tasks.db.list("capability-usage").length, 0);
    assert.ok(f.tasks.db.events(task.id).some(e => e.type === "tool.failed"));
  } finally { await f.close(); }
});
test("unified config is published remotely, frozen per run and publication does not drift queued runs", async () => {
  const f = await fixture();
  try {
    const initial = f.tasks.configs.resolve("engineering");
    const first = f.tasks.submit(user, { mode: "direct", prompt: "x" }, "before");
    f.tasks.configs.publish({ ...initial, version: "2", features: { draft: false, tools: false }, business: { label: "new" } });
    assert.equal(f.tasks.get(first.id).config.features.draft, true);
    const second = f.tasks.submit(user, { mode: "direct", prompt: "x" }, "after");
    assert.equal(second.config.version, "2");
    assert.throws(() => f.tasks.submit(user, { mode: "draft", prompt: "x" }, "disabled"), /disabled/);
    assert.throws(() => f.tasks.catalog.admit(second, "tool:text-stats@1.0.0"), /denied/);
    assert.throws(() => f.tasks.configs.publish(initial), /immutable/);
  } finally { await f.close(); }
});
test("Tool gateway validates input, enforces current policy, returns durable idempotent side effects", async () => {
  const f = await fixture();
  try {
    const task = f.tasks.submit(user, { mode: "direct", prompt: "x" }, "tool");
    const active = f.tasks.claim("r");
    const lease = active?.lease?.token ?? "";
    await assert.rejects(f.server.gateway.invoke(task.id, lease, "n", "tool:ticket-create@1.0.0", {}, "one"), /required/);
    const a = await f.server.gateway.invoke(task.id, lease, "n", "tool:ticket-create@1.0.0", { title: "Bug" }, "one");
    const b = await f.server.gateway.invoke(task.id, lease, "n", "tool:ticket-create@1.0.0", { title: "Bug" }, "one");
    assert.deepEqual(a, b);
    assert.equal(f.tasks.db.list("tickets").length, 1);
    await assert.rejects(f.server.gateway.invoke(task.id, lease, "n", "tool:ticket-create@1.0.0", { title: "Changed" }, "one"), /different/);
    f.tasks.catalog.setEnabled("tool:ticket-create@1.0.0", false);
    await assert.rejects(f.server.gateway.invoke(task.id, lease, "n", "tool:ticket-create@1.0.0", { title: "Bug" }, "one"), /denied/);
    const ledger = f.tasks.db.list<{ status: string }>("invocations");
    assert.equal(ledger[0]?.status, "completed");
  } finally { await f.close(); }
});
test("uncertain side effect is not silently rerun; recorded model usage is deduplicated", async () => {
  const f = await fixture();
  try {
    const task = f.tasks.submit(user, { mode: "direct", prompt: "x" }, "uncertain");
    const active = f.tasks.claim("r");
    const lease = active?.lease?.token ?? "";
    const c = f.tasks.catalog.admit(task, "tool:ticket-create@1.0.0");
    f.tasks.db.put("invocations", `${task.id}/n/uncertain`, {
      digest: hash(["tool:ticket-create@1.0.0", c.digest, { title: "Bug" }]), status: "uncertain",
    });
    await assert.rejects(f.server.gateway.invoke(task.id, lease, "n", "tool:ticket-create@1.0.0", { title: "Bug" }, "uncertain"), /Reconcile/);
    f.tasks.recordUsage(task.id, lease, "turn1", { input: 10, cached: 2, output: 20 });
    f.tasks.recordUsage(task.id, lease, "turn1", { input: 10, cached: 2, output: 20 });
    assert.equal(f.tasks.get(task.id).outputTokens, 20);
    assert.equal(f.tasks.db.list("usage").length, 1);
  } finally { await f.close(); }
});
test("real MCP client lists only node-scoped Tools and invokes the same enforced gateway", async () => {
  const f = await fixture();
  const client = new Client({ name: "ark-offline-protocol-test", version: "1.0.0" });
  try {
    const task = f.tasks.submit(user, { mode: "direct", prompt: "x" }, "mcp");
    const active = f.tasks.claim("r");
    const secret = f.server.gateway.grant(task.id, active?.lease?.token ?? "", "model", ["tool:text-stats@1.0.0"]);
    const transport = new StreamableHTTPClientTransport(new URL("/mcp", f.url), {
      requestInit: { headers: { authorization: `Bearer ${secret}` } },
    });
    await client.connect(transport);
    const list = await client.listTools();
    assert.deepEqual(list.tools.map(t => t.name), ["text-stats"]);
    const result = await client.callTool({ name: "text-stats", arguments: { text: "hello world" } });
    assert.deepEqual(result.structuredContent, { result: { characters: 11, words: 2 } });
    await assert.rejects(client.callTool({ name: "ticket-create", arguments: { title: "Spoof" } }));
    f.tasks.cancel(task.id);
    await assert.rejects(client.listTools());
    assert.equal(f.tasks.db.list("tickets").length, 0);
  } finally { await client.close(); await f.close(); }
});
