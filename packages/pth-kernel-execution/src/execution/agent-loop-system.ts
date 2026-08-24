/**
 * agent-loop-system.ts —— agent system prompt 装配段（模块专项：自 agent-loop.ts 抽出）。
 *
 * 包含：buildAgentSystemPrompt 调用、根目标/发布者澄清/ASP_BLOCK 追加、环境 prelude 装配。
 */
import type { WorkerRole } from "./worker-cluster.js";
import { buildAgentSystemPrompt, ASP_BLOCK } from "./agent-loop-prompt.js";
import { buildEnvironmentPrelude } from "./agent-loop-guards.js";
import { pthConfig } from "@away_from/pth-config";

export interface AgentLoopSystemInput {
  role?: WorkerRole;
  task: { title: string; text: string };
  goal?: string;
  publisherClarification?: string;
  asp: boolean;
  allowlist?: ReadonlySet<string>;
  caps: Record<string, unknown>;
}

export interface AgentLoopSystemAssembly {
  system: string;
  prelude: string;
}

/** system prompt 装配（根目标/发布者澄清/ASP_BLOCK/环境 prelude——压缩压不掉的恒定段）。 */
export async function buildAgentLoopSystem(input: AgentLoopSystemInput): Promise<AgentLoopSystemAssembly> {
  const { role, task, goal, publisherClarification, asp, allowlist, caps } = input;
  let system = await buildAgentSystemPrompt(role, task.title, {
    // 2026-08-14 T2：仅显式 env 覆盖才传入——缺省交由角色类策略（规划系 eager/其余 lazy）
    mode: (() => {
      const m = pthConfig().str("PTH_AGENT_MODE");
      return (m === "lazy" || m === "eager" ? m : undefined) as "eager" | "lazy" | undefined;
    })(),
    // 2026-08-15 审计 MEDIUM：非 ASP 模式 prompt 工具面与 schema 同源（剔除 ASP-only）
    asp,
    ...(allowlist && allowlist.size > 0 ? { allowlist: [...allowlist] } : {}),
    memory: (caps as { memory?: { query(sql: string): Promise<Array<{ content: string }>> } }).memory,
  });
  // 生命周期 P0：根目标段（system prompt 恒定——不进消息数组，压缩压不掉）
  if (goal && goal.trim() !== "") {
    system = `${system}\n\n【根目标】${goal.trim()}`;
  }
  // 生命周期 P1：发布者澄清（pause 恢复重跑时注入——答案作为新事实）
  if (publisherClarification && publisherClarification.trim() !== "") {
    system = `${system}\n\n【发布者澄清】${publisherClarification.trim()}`;
  }
  if (asp) system = `${system}\n\n${ASP_BLOCK}`;
  // 静态环境注入（②）：任务开始时拉环境预置（toolstore 文件 + 记忆概览）——LLM 一上来就知道可用资产
  const prelude = await buildEnvironmentPrelude(caps);
  return { system, prelude };
}
