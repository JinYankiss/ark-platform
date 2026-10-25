import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { services, seed } from "./bootstrap.js";
import { ArkServer, type Credential } from "./ingress/http.js";
import { FeishuBot, type FeishuBinding } from "./ingress/feishu.js";
import { ArkClient } from "./runner/client.js";
import { CodexModel, DemoModel } from "./runner/model.js";
import { Runner } from "./runner/worker.js";
import { ExecutionEngine } from "./runner/engine.js";
import { ArkError, check } from "./core/validation.js";
import { telemetry } from "./observability/tracing.js";

const stop = new AbortController();
process.once("SIGINT", () => stop.abort());
process.once("SIGTERM", () => stop.abort());
async function main(): Promise<void> {
  const command = process.argv[2] ?? "server";
  if (command === "runner") {
    const url = process.env.ARK_URL ?? "http://127.0.0.1:8787";
    const credential = process.env.ARK_RUNNER_TOKEN ?? "";
    check(credential.length >= 24, "MISSING_TOKEN", "ARK_RUNNER_TOKEN required");
    const model = process.argv.includes("--demo") ? new DemoModel() : new CodexModel(url, process.env.OPENAI_API_KEY ?? "");
    const worker = new Runner(process.env.RUNNER_ID ?? randomUUID(), new ArkClient(url, credential),
      new ExecutionEngine(model), resolve(process.env.ARK_WORKSPACES ?? ".data/workspaces"),
      Number(process.env.ARK_HEARTBEAT_MS ?? 1000));
    try { await worker.run(stop.signal, process.argv.includes("--once")); }
    finally { await telemetry.close(); }
    return;
  }
  check(command === "server" || command === "seed", "UNKNOWN_COMMAND", "Use server | seed | runner [--demo] [--once]");
  const tasks = services(resolve(process.env.ARK_DB ?? ".data/ark.sqlite"), Number(process.env.ARK_LEASE_MS ?? 10_000));
  if (command === "seed") {
    seed(tasks);
    tasks.db.close();
    console.log("Published local demonstration capabilities/config/workflow; no model invoked.");
    return;
  }
  let server: ArkServer | undefined;
  let bot: FeishuBot | undefined;
  try {
    const credentials = JSON.parse(await readFile(process.env.ARK_CREDENTIALS_FILE ?? ".data/credentials.json", "utf8")) as Credential[];
    server = new ArkServer(tasks, credentials);
    const url = await server.listen(Number(process.env.PORT ?? 8787));
    console.log(JSON.stringify({ component: "ark", url }));
    if (process.env.FEISHU_BINDINGS_FILE) {
      const bindings = JSON.parse(await readFile(process.env.FEISHU_BINDINGS_FILE, "utf8")) as FeishuBinding[];
      bot = new FeishuBot(tasks, process.env.FEISHU_APP_ID ?? "", process.env.FEISHU_APP_SECRET ?? "", bindings);
      await bot.start();
    }
    if (!stop.signal.aborted) await new Promise<void>(resolve => stop.signal.addEventListener("abort", () => resolve(), { once: true }));
  } finally {
    await bot?.stop();
    if (server?.server.listening) await server.close();
    tasks.db.close();
    await telemetry.close();
  }
}
main().catch(error => {
  if (!stop.signal.aborted) {
    console.error(error instanceof ArkError ? `${error.code}: ${error.message}` : error instanceof Error ? error.name : "Startup failed");
    process.exitCode = 1;
  }
});
