import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal } from "../src/core/contracts.js";
import { seed, services } from "../src/bootstrap.js";
import { ArkServer } from "../src/ingress/http.js";
import { ArkClient } from "../src/runner/client.js";
import { ExecutionEngine } from "../src/runner/engine.js";
import { DemoModel, type ModelAdapter } from "../src/runner/model.js";
import { Runner } from "../src/runner/worker.js";

export const user: Principal = { id: "intern", businessLine: "engineering", role: "user" };
export const admin: Principal = { id: "operator", businessLine: "engineering", role: "admin" };
export const userToken = "test-user-credential-not-production-000";
export const runnerToken = "test-runner-credential-not-production-000";
export const adminToken = "test-admin-credential-not-production-000";
export async function fixture(leaseMs = 5000) {
  const root = await mkdtemp(join(tmpdir(), "ark-rewrite-"));
  const tasks = services(join(root, "ark.sqlite"), leaseMs);
  seed(tasks);
  const server = new ArkServer(tasks, [
    { token: userToken, principal: user }, { token: adminToken, principal: admin },
    { token: runnerToken, principal: { id: "worker", businessLine: "engineering", role: "runner" } },
  ]);
  const url = await server.listen();
  const client = new ArkClient(url, runnerToken);
  return {
    root, tasks, server, url, client,
    runner: (model: ModelAdapter = new DemoModel()) => new Runner("test-runner", client, new ExecutionEngine(model), join(root, "workspaces"), 50),
    close: async () => { await server.close(); tasks.db.close(); },
  };
}
export async function waitUntil(predicate: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for assertion");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
