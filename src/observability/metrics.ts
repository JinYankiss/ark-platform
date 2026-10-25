/** 文档行为实现 A05/D04/Z09。真实数据库投影；分母明确，不生成简历运营指标。 */
import type { Task } from "../core/contracts.js";
import type { Database } from "../storage/database.js";
export function metrics(db: Database): string {
  const tasks = db.list<Task>("tasks");
  const lines = ["# HELP ark_tasks Task count by current state", "# TYPE ark_tasks gauge"];
  for (const state of ["queued", "running", "paused", "succeeded", "failed", "cancelled"]) {
    lines.push(`ark_tasks{state="${state}"} ${tasks.filter(t => t.state === state).length}`);
  }
  const completed = tasks.filter(t => t.state === "succeeded" || t.state === "failed");
  lines.push("# HELP ark_success_ratio succeeded/(succeeded+failed), excluding cancelled and paused");
  lines.push(`ark_success_ratio ${completed.length ? completed.filter(t => t.state === "succeeded").length / completed.length : "NaN"}`);
  lines.push(`ark_model_calls_total ${tasks.reduce((sum, t) => sum + t.modelCalls, 0)}`);
  lines.push(`ark_output_tokens_total ${tasks.reduce((sum, t) => sum + t.outputTokens, 0)}`);
  return `${lines.join("\n")}\n`;
}
