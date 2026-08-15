/**
 * thinking-path.ts —— 思考路径图重建器（2026-08-15 E1 / 账本 N13，concepts 0.15）。
 *
 * 从 trace 事件流还原三层对位底图：
 *   - 发现链（discoveries）：每一步新发现的信息（按时间序，去重指纹）；
 *   - 决策链（decisions）：每个行为 + 其前置发现（decision.discoveryIndex；null = 盲试）；
 *   - 意图链（intents）：行为序列按工具族语义归纳（探索→验证→实现→提交）。
 * 岔路口（forks）：重复探测（信息已到手仍重查）/ 盲试（无信息依据的动作）。
 * 缺口（gaps）：记忆缺口（检索侧失败）/ 工具缺口（未知工具）。
 * 本模块是纯函数——D1 护栏观测与下一代 JIT collect 共用同一轨迹数据。
 */

import type { AgentTraceEvent } from "./agent-loop.js";

export interface ThinkingPathDiscovery {
  step: number;
  tool: string;
  preview: string;
  fingerprint: string;
}

export interface ThinkingPathDecision {
  step: number;
  tool: string;
  argsSummary: string;
  /** 该行为依赖的最新发现索引；null = 盲试（信息缺失却直接动作） */
  discoveryIndex: number | null;
}

export type ThinkingIntentPhase = "explore" | "verify" | "implement" | "submit" | "other";

export interface ThinkingPathIntent {
  phase: ThinkingIntentPhase;
  startStep: number;
  endStep: number;
  decisions: number;
}

export interface ThinkingPathForks {
  repeatedProbes: Array<{ step: number; tool: string; preview: string }>;
  blindAttempts: Array<{ step: number; tool: string }>;
}

export interface ThinkingPathGaps {
  /** 检索侧失败（memory.* 工具返回失败）——候选记忆缺口 */
  memoryGaps: Array<{ step: number; tool: string; preview: string }>;
  /** 执行侧缺口（未知工具引导）——候选工具缺口 */
  toolGaps: Array<{ step: number; tool: string; preview: string }>;
}

export interface ThinkingPath {
  discoveries: ThinkingPathDiscovery[];
  decisions: ThinkingPathDecision[];
  intents: ThinkingPathIntent[];
  forks: ThinkingPathForks;
  gaps: ThinkingPathGaps;
}

const MEMORY_TOOLS = new Set(["memory.query", "memory.retrieve", "memory.get", "memory_index", "asp_index"]);
const VERIFY_TOOLS = new Set(["dev.run", "dev.list", "debug", "asp.cd"]);
const IMPLEMENT_TOOLS = new Set(["dev.write", "dev.edit", "dev.build", "write.create", "write.edit", "write.save", "fs.task", "fs.write", "python", "bash"]);
const SUBMIT_TOOLS = new Set(["done"]);

function phaseOf(tool: string): ThinkingIntentPhase {
  if (MEMORY_TOOLS.has(tool) || tool.startsWith("fs.read") || tool.startsWith("readSource") || tool === "web.fetchText" || tool === "ext.use") return "explore";
  if (VERIFY_TOOLS.has(tool) || tool.startsWith("dev.run") || tool.startsWith("dev.list")) return "verify";
  if (IMPLEMENT_TOOLS.has(tool) || tool.startsWith("dev.") || tool.startsWith("write.") || tool.startsWith("fs.") || tool === "python" || tool === "bash") return "implement";
  if (SUBMIT_TOOLS.has(tool)) return "submit";
  return "other";
}

function argsSummary(args: Record<string, unknown>): string {
  return JSON.stringify(args).slice(0, 160);
}

/** 轨迹 → 思考路径图（纯函数；events 应为单任务全量 trace） */
export function reconstructThinkingPath(events: AgentTraceEvent[]): ThinkingPath {
  const discoveries: ThinkingPathDiscovery[] = [];
  const decisions: ThinkingPathDecision[] = [];
  const forks: ThinkingPathForks = { repeatedProbes: [], blindAttempts: [] };
  const gaps: ThinkingPathGaps = { memoryGaps: [], toolGaps: [] };
  const seen = new Set<string>();

  for (const e of events) {
    if (e.type === "tool-result") {
      if (e.ok && e.resultPreview.trim() !== "") {
        const fingerprint = `${e.tool}|${e.resultPreview.slice(0, 160)}`;
        if (seen.has(fingerprint)) {
          forks.repeatedProbes.push({ step: e.step, tool: e.tool, preview: e.resultPreview.slice(0, 120) });
        } else {
          seen.add(fingerprint);
          discoveries.push({ step: e.step, tool: e.tool, preview: e.resultPreview.slice(0, 300), fingerprint });
        }
      }
      if (!e.ok) {
        if (MEMORY_TOOLS.has(e.tool) || e.tool.startsWith("memory.")) {
          gaps.memoryGaps.push({ step: e.step, tool: e.tool, preview: e.resultPreview.slice(0, 200) });
        }
        if (e.resultPreview.includes("未知工具")) {
          gaps.toolGaps.push({ step: e.step, tool: e.tool, preview: e.resultPreview.slice(0, 200) });
        }
      }
    } else if (e.type === "tool-call") {
      let discoveryIndex: number | null = null;
      for (let i = discoveries.length - 1; i >= 0; i--) {
        if (discoveries[i]!.step <= e.step) { discoveryIndex = i; break; }
      }
      decisions.push({ step: e.step, tool: e.tool, argsSummary: argsSummary(e.args), discoveryIndex });
      if (discoveryIndex === null) forks.blindAttempts.push({ step: e.step, tool: e.tool });
    }
  }

  const intents: ThinkingPathIntent[] = [];
  for (const d of decisions) {
    const phase = phaseOf(d.tool);
    const last = intents[intents.length - 1];
    if (last && last.phase === phase) {
      last.endStep = d.step;
      last.decisions++;
    } else {
      intents.push({ phase, startStep: d.step, endStep: d.step, decisions: 1 });
    }
  }

  return { discoveries, decisions, intents, forks, gaps };
}
