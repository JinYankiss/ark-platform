/**
 * 文档行为示例改写 A01/D01/G03：可信宿主代码可用循环/条件和逐项 pipeline。
 * 不由模型生成并 eval；该示例是库接口，不是已注册到服务的第四条执行路径。
 */
import type { Json } from "../src/core/contracts.js";
import type { WorkflowContext } from "../src/workflow/context.js";

export async function inspectItems(ctx: WorkflowContext, items: Json[],
  inspect: (item: Json, signal: AbortSignal) => Promise<Json>,
  summarize: (item: Json, signal: AbortSignal) => Promise<Json>): Promise<Json[]> {
  await ctx.phase("inspect-and-summarize");
  return ctx.pipeline(items, [
    (item, index) => ctx.step(`inspect-${index}`, { item, definitionVersion: "1" }, () => inspect(item, ctx.signal)),
    (item, index) => ctx.step(`summarize-${index}`, { item, definitionVersion: "1" }, () => summarize(item, ctx.signal)),
  ]);
}
