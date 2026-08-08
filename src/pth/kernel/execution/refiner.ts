/**
 * refiner.ts — Refine 管线（解释器持久化层草案 T4）
 *
 * 任务完成后：快照（三 kernel 已实现）→ LLM 提炼（筛选工具函数 + 生成构造文档 spec
 * + 提炼洞察）→ 双通道持久化（tool-function / task-insight → memory_entries）。
 *
 * pickle 哲学（草案 §0）：函数存【源码 + spec 构造文档】双轨（当前环境 eval 重放，
 * 迁移环境按 spec 重建）；数据/洞察走记忆表。
 *
 * 降级（草案 P6）：LLM 输出解析失败 → 函数源码原样保存（无 spec），不 crash、不阻塞任务完成。
 */

import type { LlmFn } from "../interpreter/llm-fn.js";
import type { InterpreterSnapshot } from "../interpreter/types.js";
import type { PgMemoryStore } from "../storage/memory-store-pg.js";
import type { Task } from "../storage/task-store-pg.js";

export interface RefineInput {
  task: Pick<Task, "id" | "title" | "tags" | "claimed_by">;
  snapshot: InterpreterSnapshot;
  /** 任务语言（默认 typescript——vm 任务代码） */
  language?: string;
}

export interface RefinedFunction {
  key: string;
  source: string;
  spec?: { signature?: string; purpose?: string; logic?: string; examples?: unknown[]; deps?: string[] };
}

export interface RefineResult {
  ok: boolean;
  functions: RefinedFunction[];
  insights: string[];
}

export interface RefineReport {
  functionsSaved: number;
  insightsSaved: number;
  skipped: string[];
}

interface RefinerDeps {
  llm: LlmFn;
  memory: Pick<PgMemoryStore, "write" | "retrieve">;
  model?: string;   // 提炼模型（默认 deepseek-v4-flash）
}

/** 构造 refine prompt（含快照 + 任务信息 + 输出格式约束） */
export function buildRefinePrompt(input: RefineInput): string {
  const { task, snapshot, language = "typescript" } = input;
  const fnDesc = snapshot.functions
    .map((f) => `- ${f.key}: ${f.source.slice(0, 200)}`)
    .join("\n") || "（无）";
  const varDesc = snapshot.variables
    .map((v) => `- ${v.key} = ${JSON.stringify(v.value).slice(0, 100)}`)
    .join("\n") || "（无）";
  return [
    "你是 PTH 记忆维护员。任务执行完毕后，从解释器状态快照中提炼【对后续任务可能有用的】内容。",
    "",
    `任务: ${task.title} (id=${task.id}, tags=${(task.tags ?? []).join(",")})`,
    "",
    "状态快照 — 工具函数:",
    fnDesc,
    "",
    "状态快照 — 变量:",
    varDesc,
    "",
    "请输出 JSON（不要其他文字），格式:",
    `{"functions": [{"key": "<函数名>", "source": "<完整源码>", "spec": {"signature": "<签名>", "purpose": "<用途>", "logic": "<逻辑说明>", "examples": [[输入,输出]]}}], "insights": ["<经验/洞察字符串>"]}`,
    "",
    "规则:",
    `- functions: 只保留通用、可复用、后续任务可能用到的工具函数（当前语言: ${language}）；source 必须与快照一致`,
    "- spec.signature/purpose/logic/examples 是【构造文档】——迁移环境后据此重建函数（pickle 哲学）",
    "- insights: 提炼任务过程中的关键经验/结论/数据（简洁，每条 ≤100 字）",
    "- 无可用内容时输出 {\"functions\": [], \"insights\": []}",
  ].join("\n");
}

/** 容错解析 LLM 输出（合法 JSON / ```json 围栏 / 失败降级） */
export function parseRefineResult(text: string): { ok: true; functions: RefinedFunction[]; insights: string[] } | { ok: false } {
  const cleaned = text.trim().replace(/^```json?\s*/i, "").replace(/```\s*$/, "").trim();
  try {
    const parsed = JSON.parse(cleaned) as { functions?: unknown[]; insights?: unknown[] };
    const functions: RefinedFunction[] = (parsed.functions ?? [])
      .filter((f): f is Record<string, unknown> => typeof f === "object" && f !== null)
      .map((f) => ({
        key: String(f.key ?? "fn"),
        source: String(f.source ?? ""),
        spec: typeof f.spec === "object" && f.spec !== null ? (f.spec as RefinedFunction["spec"]) : undefined,
      }))
      .filter((f) => f.source.length > 0);
    const insights = (parsed.insights ?? []).filter((i): i is string => typeof i === "string");
    return { ok: true, functions, insights };
  } catch {
    return { ok: false };
  }
}

export class Refiner {
  constructor(private deps: RefinerDeps) {}

  async refine(input: RefineInput): Promise<RefineReport> {
    const report: RefineReport = { functionsSaved: 0, insightsSaved: 0, skipped: [] };

    // 1. LLM 提炼
    const prompt = buildRefinePrompt(input);
    let result: RefineResult;
    try {
      const res = await this.deps.llm.complete(
        [{ role: "system", content: prompt }],
        { model: this.deps.model ?? "deepseek-v4-flash", provider: "deepseek" },
      );
      const parsed = parseRefineResult(res.content);
      result = parsed.ok ? parsed : { ok: false, functions: [], insights: [] };
    } catch {
      result = { ok: false, functions: [], insights: [] };
    }

    // 2. 降级：解析失败 → 函数源码原样保存（无 spec）——不丢快照里的函数
    const functions: RefinedFunction[] = result.ok
      ? result.functions
      : input.snapshot.functions.map((f) => ({ key: f.key, source: f.source }));

    // 3. 双通道持久化（草案 P12：函数 → tool-function；洞察 → task-insight）
    const language = input.language ?? "typescript";
    const baseAnchors = [...new Set([...(input.task.tags ?? []), language, ...functions.map((f) => f.key)])];

    for (const fn of functions) {
      const id = `fn-${hash(fn.source).slice(0, 12)}`;
      await this.deps.memory.write({
        id,
        kind: "tool-function",
        anchors: [...new Set([fn.key, ...(input.task.tags ?? []), language])],
        content: fn.source,   // 当前语言实现（pickle：保留当前实现）
        status: "official",
        meta: {
          spec: fn.spec ?? null,             // 构造文档（迁移重建依据）
          language,
          taskId: input.task.id,
          role: input.task.claimed_by,
          model: this.deps.model ?? "deepseek-v4-flash",
        },
      });
      report.functionsSaved++;
    }

    for (const insight of result.ok ? result.insights : []) {
      if (!insight.trim()) continue;
      const id = `insight-${hash(input.task.id + insight).slice(0, 12)}`;
      await this.deps.memory.write({
        id,
        kind: "task-insight",
        anchors: baseAnchors,
        content: insight,
        status: "official",
        meta: { taskId: input.task.id, role: input.task.claimed_by },
      });
      report.insightsSaved++;
    }

    // 4. refine-report（溯源）
    await this.deps.memory.write({
      id: `refine-${input.task.id}`,
      kind: "refine-report",
      anchors: [input.task.id],
      content: `提炼 ${report.functionsSaved} 个工具函数 + ${report.insightsSaved} 条经验`,
      status: "official",
      meta: { taskId: input.task.id, language },
    });

    return report;
  }
}

/** 简易内容 hash（id 幂等：相同源码同 id → CAS 版本递增） */
function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}
