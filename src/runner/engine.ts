/** 文档行为实现 A01/D01/G03/Z02 + 项目 DAG 适配。编排只调用受控 Runner 内的模型/工具。 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import type { Json, Task, WorkflowDefinition, WorkflowNode } from "../core/contracts.js";
import { check, hash, json } from "../core/validation.js";
import { definitionSchema, parseDefinition, resolveInput } from "../workflow/definition.js";
import { EarlyFinished, WorkflowContext } from "../workflow/context.js";
import type { ModelAdapter } from "./model.js";
import type { TaskClient } from "./client.js";

const exec = promisify(execFile);
export class ExecutionEngine {
  constructor(private readonly model: ModelAdapter) {}
  async execute(task: Task, client: TaskClient, workspace: string, signal: AbortSignal): Promise<Json> {
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    const ctx = new WorkflowContext(client, combined, task.config.limits.concurrency);
    await ctx.load();
    if (task.input.mode === "direct") {
      return this.agent(task, client, ctx, "__direct", task.input.prompt,
        task.capabilities.map(c => `${c.kind}:${c.id}@${c.version}`), workspace);
    }
    let definition = task.definition;
    if (!definition) {
      const draft = await ctx.step("__draft", { prompt: task.input.prompt, config: hash(task.config) }, async previous => {
        await client.action("model-start", { node: "__draft" });
        return this.model.run({
          task, node: "__draft", refs: [], workspace, signal: combined, client, previous,
          prompt: `Create a minimal workflow plan for this request. Use only capabilities in this list: ${
            JSON.stringify(task.capabilities.map(c => ({ ref: `${c.kind}:${c.id}@${c.version}`, description: c.description })))
          }. No scripts, no arbitrary shell commands. Verification commands allowed: ${
            Object.keys(task.config.validationCommands).join(",")
          }. Request: ${task.input.prompt}`,
          schema: definitionSchema,
        });
      });
      definition = parseDefinition(draft);
      await client.action("definition", { definition });
    }
    await ctx.phase(definition.name);
    return this.runGraph(task, client, ctx, definition, workspace, controller);
  }
  private async agent(task: Task, client: TaskClient, ctx: WorkflowContext, key: string,
    prompt: string, refs: string[], workspace: string, outputSchema?: WorkflowNode & { kind: "agent" }): Promise<Json> {
    return ctx.step(key, json({ prompt, refs, config: hash(task.config), schema: outputSchema?.outputSchema ?? null }), async previous => {
      // Admission is checked remotely even when the node uses only a Skill and no MCP calls.
      await client.action("grant", { node: key, refs });
      await client.action("model-start", { node: key });
      return this.model.run({ task, node: key, prompt, refs, schema: outputSchema?.outputSchema,
        previous, workspace, signal: ctx.signal, client });
    });
  }
  private async runGraph(task: Task, client: TaskClient, ctx: WorkflowContext, definition: WorkflowDefinition,
    workspace: string, controller: AbortController): Promise<Json> {
    const outputs: Record<string, Json> = {};
    const pending = new Map(definition.nodes.map(n => [n.id, n]));
    const running = new Map<string, Promise<{ id: string; result: Json }>>();
    try {
      while (pending.size || running.size) {
        ctx.signal.throwIfAborted();
        for (const [id, node] of pending) {
          if (running.size >= ctx.concurrency) break;
          if (!node.needs.every(key => Object.hasOwn(outputs, key))) continue;
          pending.delete(id);
          running.set(id, this.executeNode(task, client, ctx, node, outputs, workspace)
            .then(result => ({ id, result })));
        }
        check(running.size > 0, "WORKFLOW_STALLED", "No runnable nodes");
        const completed = await Promise.race(running.values());
        running.delete(completed.id);
        outputs[completed.id] = completed.result;
      }
      return outputs;
    } catch (error) {
      // Stop sibling execution and await cleanup before Runner may mark a terminal state.
      controller.abort(error);
      await Promise.allSettled(running.values());
      throw error;
    }
  }
  private async executeNode(task: Task, client: TaskClient, ctx: WorkflowContext, node: WorkflowNode,
    outputs: Record<string, Json>, workspace: string): Promise<Json> {
    if (node.when && hash(outputs[node.when.node]) !== hash(node.when.equals)) return { skipped: true };
    if (node.kind === "pause") return ctx.pause(node.id, node.message);
    const dependencies = Object.fromEntries(node.needs.map(id => [id, outputs[id] ?? null]));
    if (node.kind === "agent") return this.agent(task, client, ctx, node.id,
      `${node.prompt}\nRequest: ${task.input.prompt}\nDependency results: ${JSON.stringify(dependencies)}`,
      node.capabilities, workspace, node);
    if (node.kind === "tool") {
      const input = resolveInput(node.input, dependencies);
      return ctx.step(node.id, { node: json(node), input }, () => client.action<Json>("tool", {
        node: node.id, ref: node.capability, input, invocationKey: node.id,
      }));
    }
    const proof = await ctx.step(node.id, { node: json(node), config: hash(task.config) }, async () => {
      const argv = task.config.validationCommands[node.command];
      check(argv?.[0], "INVALID_VERIFIER", "Verifier is not registered");
      const { stdout, stderr } = await exec(argv[0], argv.slice(1), {
        cwd: workspace, signal: ctx.signal, timeout: 60_000, maxBuffer: 256 * 1024,
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
      });
      const evidence = {
        kind: "command", command: node.command, exitCode: 0,
        outputDigest: createHash("sha256").update(stdout).update(stderr).digest("hex"),
      };
      await client.action("verification", { evidence });
      return evidence;
    });
    if (node.finishEarly) {
      // Replayed proof must also exist in central storage; finish checks the same digest.
      throw new EarlyFinished(outputs, proof);
    }
    return proof;
  }
}
