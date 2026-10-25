/** Only a process-boundary failure fixture, never used by src CLI or production. */
import { setTimeout as sleep } from "node:timers/promises";
import { ArkClient } from "../src/runner/client.js";
import { ExecutionEngine } from "../src/runner/engine.js";
import { Runner } from "../src/runner/worker.js";
const runner = new Runner("crash-fixture", new ArkClient(process.env.ARK_URL ?? "", process.env.ARK_RUNNER_TOKEN ?? ""),
  new ExecutionEngine({ run: async r => {
    process.stdout.write("MODEL_STARTED\n");
    await sleep(30_000, undefined, { signal: r.signal });
    return "not expected";
  } }), process.env.ARK_WORKSPACES ?? "", 100);
await runner.run(new AbortController().signal, true);
