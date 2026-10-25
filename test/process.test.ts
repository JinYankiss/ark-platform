import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fixture, runnerToken, user, waitUntil } from "./helpers.js";

test("two actual Runner processes compete for one task: only one claim and one model reservation", async () => {
  const f = await fixture();
  const children = [];
  try {
    const task = f.tasks.submit(user, { mode: "direct", prompt: "compete", capabilities: [] }, "process");
    const env = { ...process.env, ARK_URL: f.url, ARK_RUNNER_TOKEN: runnerToken, ARK_WORKSPACES: `${f.root}/workspaces`, ARK_HEARTBEAT_MS: "100" };
    const exits: Promise<number | null>[] = [];
    for (const id of ["runner-a", "runner-b"]) {
      const child = spawn(process.execPath, [resolve("dist/src/index.js"), "runner", "--demo", "--once"], {
        env: { ...env, RUNNER_ID: id }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      });
      children.push(child);
      let stderr = "";
      child.stderr.on("data", data => { stderr += String(data); });
      exits.push(new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", code => code === 0 ? resolve(code) : reject(new Error(stderr)));
      }));
    }
    await Promise.all(exits);
    assert.equal(f.tasks.get(task.id).state, "succeeded");
    assert.equal(f.tasks.get(task.id).attempts, 1);
    assert.equal(f.tasks.get(task.id).modelCalls, 1);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    await f.close();
  }
});
test("killed Runner is recovered by another process after lease expiry; incomplete step is retried", async () => {
  const f = await fixture(700);
  const env = { ...process.env, ARK_URL: f.url, ARK_RUNNER_TOKEN: runnerToken, ARK_WORKSPACES: `${f.root}/workspaces`, ARK_HEARTBEAT_MS: "100" };
  const child = spawn(process.execPath, [resolve("dist/test/slow-runner.js")], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let started = false;
  child.stdout.on("data", data => { if (String(data).includes("MODEL_STARTED")) started = true; });
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  try {
    const task = f.tasks.submit(user, { mode: "direct", prompt: "recover", capabilities: [] }, "crash");
    await waitUntil(() => started, 10_000);
    const oldToken = f.tasks.get(task.id).lease?.token ?? "";
    child.kill("SIGKILL");
    await exited;
    await waitUntil(() => (f.tasks.get(task.id).lease?.deadline ?? 0) < Date.now());
    const recovered = spawn(process.execPath, [resolve("dist/src/index.js"), "runner", "--demo", "--once"], {
      env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise<void>((resolve, reject) => {
      recovered.once("error", reject);
      recovered.once("exit", code => code === 0 ? resolve() : reject(new Error(`Recovery exited ${code}`)));
    });
    const done = f.tasks.get(task.id);
    assert.equal(done.state, "succeeded");
    assert.equal(done.attempts, 2);
    assert.throws(() => f.tasks.finish(task.id, oldToken, "succeeded", "stale"), /lease/);
    assert.ok(f.tasks.journal(task.id).some(e => e.status === "completed"));
  } finally {
    if (child.exitCode === null) child.kill();
    await f.close();
  }
});
