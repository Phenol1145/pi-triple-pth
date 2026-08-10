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
  /** 执行轨迹（任务 3 分化分析输入——agent 步骤/工具调用/解决的问题） */
  trace?: Array<{ type: string; step?: number; tool?: string; args?: Record<string, unknown>; contentPreview?: string; resultPreview?: string }>;
  /** 执行角色（分化建议的 parent——当前角色） */
  role?: string;
}

/** 分化建议（任务 3 输出——有监督自动化：建议持久化待确认——不自动执行分化） */
export interface DifferentiationProposal {
  differentiable: boolean;
  subtasks: Array<{ type: string; description: string; capabilityNeeds?: string[]; frequency?: string }>;
  suggestedRole?: { id: string; parent: string; specialization: string; rationale: string };
  confidence?: "high" | "medium" | "low";
  rationale?: string;
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
  differentiation?: DifferentiationProposal;
}

export interface RefineReport {
  functionsSaved: number;
  insightsSaved: number;
  differentiationProposed: boolean;
  skipped: string[];
}

interface RefinerDeps {
  llm: LlmFn;
  memory: Pick<PgMemoryStore, "write" | "retrieve">;
  model?: string;   // 提炼模型（默认 deepseek-v4-flash）
  /** 性能计量（SPEC L3）：refine 事件 → IPC 转发主进程 */
  onMetric?: (m: Record<string, unknown>) => void;
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
    ...(input.role ? [`执行角色: ${input.role}`] : []),
    "",
    ...(input.trace && input.trace.length > 0 ? [
      "执行轨迹（步骤摘要——分化分析依据）:",
      input.trace.slice(0, 60).map((e) => {
        if (e.type === "tool-call") return `- step ${e.step} [${e.tool}] ${JSON.stringify(e.args ?? {}).slice(0, 120)}`;
        if (e.type === "tool-result") return `  step ${e.step} [${e.tool}] → ${(e.resultPreview ?? "").slice(0, 100)}`;
        if (e.type === "llm-call") return `- step ${e.step} [llm] ${(e.contentPreview ?? "").slice(0, 120)}`;
        return `- step ${e.step ?? "?"} [${e.type}]`;
      }).join("\n"),
      "",
    ] : []),
    "状态快照 — 工具函数:",
    fnDesc,
    "",
    "状态快照 — 变量:",
    varDesc,
    "",
    "请输出 JSON（不要其他文字），格式:",
    `{"functions": [{"key": "<函数名>", "source": "<完整源码>", "spec": {"signature": "<签名>", "purpose": "<用途>", "logic": "<逻辑说明>", "examples": [[输入,输出]]}}], "insights": ["<经验/洞察字符串>"], "differentiation": {"differentiable": true|false, "subtasks": [{"type": "<子任务类型>", "description": "<描述>", "capabilityNeeds": ["<能力>"], "frequency": "<出现频率>"}], "suggestedRole": {"id": "<建议角色id>", "parent": "<父角色>", "specialization": "<特化方向>", "rationale": "<分化理由>"}, "confidence": "high|medium|low", "rationale": "<总体判断>"}}`,
    "",
    "规则:",
    `- functions: 只保留通用、可复用、后续任务可能用到的工具函数（当前语言: ${language}）；source 必须与快照一致`,
    "- spec.signature/purpose/logic/examples 是【构造文档】——迁移环境后据此重建函数（pickle 哲学）",
    "- insights: 提炼任务过程中的关键经验/结论/数据（简洁，每条 ≤100 字）",
    "- differentiation（任务 3——角色分化分析）：分析本次任务是否可以分化成更小更具体的子任务——",
    "  若任务执行过程中反复出现某类可区分的子任务模式（探索/实现/验证/调研等有明显能力差异的阶段），",
    "  且该模式的能力需求与当前执行角色的定位不完全匹配，则建议分化（differentiable=true）——",
    "  给出子任务类型清单 + 建议新角色（parent=当前角色，specialization=特化方向，rationale=分化理由）。",
    "  若任务单一同质（无明显的可分化子任务模式）则 differentiable=false。",
    "  分化建议是【有监督】的——仅记录待确认，不会自动创建角色。",
    "- 无可用内容时输出 {\"functions\": [], \"insights\": [], \"differentiation\": {\"differentiable\": false, \"subtasks\": []}}",
  ].join("\n");
}

/** 容错解析 LLM 输出（合法 JSON / ```json 围栏 / 失败降级） */
export function parseRefineResult(text: string): { ok: true; functions: RefinedFunction[]; insights: string[]; differentiation?: DifferentiationProposal } | { ok: false } {
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
    // 任务 3（分化分析）解析——结构容错（缺字段降级 undefined）
    const dRaw = (parsed as { differentiation?: unknown }).differentiation;
    let differentiation: DifferentiationProposal | undefined;
    if (typeof dRaw === "object" && dRaw !== null) {
      const d = dRaw as Record<string, unknown>;
      const subtasks = Array.isArray(d.subtasks)
        ? (d.subtasks as unknown[]).filter((s): s is Record<string, unknown> => typeof s === "object" && s !== null)
            .map((s) => ({
              type: String(s.type ?? "unknown"),
              description: String(s.description ?? ""),
              capabilityNeeds: Array.isArray(s.capabilityNeeds) ? (s.capabilityNeeds as unknown[]).map(String) : undefined,
              frequency: typeof s.frequency === "string" ? s.frequency : undefined,
            }))
        : [];
      const sr = d.suggestedRole as Record<string, unknown> | undefined;
      differentiation = {
        differentiable: d.differentiable === true,
        subtasks,
        suggestedRole: sr && typeof sr === "object"
          ? { id: String(sr.id ?? ""), parent: String(sr.parent ?? ""), specialization: String(sr.specialization ?? ""), rationale: String(sr.rationale ?? "") }
          : undefined,
        confidence: d.confidence === "high" || d.confidence === "medium" || d.confidence === "low" ? d.confidence : undefined,
        rationale: typeof d.rationale === "string" ? d.rationale : undefined,
      };
    }
    return { ok: true, functions, insights, differentiation };
  } catch {
    return { ok: false };
  }
}

export class Refiner {
  constructor(private deps: RefinerDeps) {}

  async refine(input: RefineInput): Promise<RefineReport> {
    const report: RefineReport = { functionsSaved: 0, insightsSaved: 0, differentiationProposed: false, skipped: [] };
    const refineStart = Date.now();

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
      if (!parsed.ok) {
        // 性能计量（SPEC L3）：解析降级
        this.deps.onMetric?.({ type: "refine-degraded", reason: "parse-failed" });
      }
    } catch {
      result = { ok: false, functions: [], insights: [] };
      this.deps.onMetric?.({ type: "refine-degraded", reason: "llm-error" });
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

    // 3.5 分化建议持久化（任务 3——有监督自动化：仅记录待确认——不自动创建角色）
    const diff = result.ok ? result.differentiation : undefined;
    if (diff?.differentiable && diff.subtasks.length > 0) {
      const parent = diff.suggestedRole?.parent || input.role || input.task.claimed_by || "origin";
      const id = `diff-${hash(input.task.id + parent + diff.subtasks.map((s) => s.type).join(",")).slice(0, 12)}`;
      await this.deps.memory.write({
        id,
        kind: "differentiation-proposal",
        anchors: [...new Set([parent, ...(input.task.tags ?? []), ...diff.subtasks.map((s) => s.type)])],
        content: JSON.stringify({
          taskId: input.task.id,
          parent,
          subtasks: diff.subtasks,
          suggestedRole: diff.suggestedRole ?? null,
          confidence: diff.confidence ?? null,
          rationale: diff.rationale ?? null,
          status: "pending-review",   // 有监督——待确认（approved → 执行分化注册新角色）
        }, null, 2),
        status: "draft",            // draft=待审核（official=已确认——监督层流转）
        meta: { taskId: input.task.id, parent, confidence: diff.confidence ?? null },
      });
      report.differentiationProposed = true;
      this.deps.onMetric?.({ type: "differentiation-proposed", parent, subtaskCount: diff.subtasks.length });
    }

    // 4. refine-report（溯源）
    await this.deps.memory.write({
      id: `refine-${input.task.id}`,
      kind: "refine-report",
      anchors: [input.task.id],
      content: `提炼 ${report.functionsSaved} 个工具函数 + ${report.insightsSaved} 条经验${report.differentiationProposed ? " + 1 条分化建议（待审核）" : ""}`,
      status: "official",
      meta: { taskId: input.task.id, language },
    });

    // 性能计量（SPEC L3）：耗时 + 提炼量
    this.deps.onMetric?.({ type: "refine-duration", durationMs: Date.now() - refineStart });
    this.deps.onMetric?.({ type: "refine-yield", kind: "functions", count: report.functionsSaved });
    this.deps.onMetric?.({ type: "refine-yield", kind: "insights", count: report.insightsSaved });

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
