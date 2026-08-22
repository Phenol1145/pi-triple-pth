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

import { createHash } from "node:crypto";
import type { LlmFn } from "@away_from/pth-kernel-interpreter";
import type { InterpreterSnapshot } from "@away_from/pth-kernel-interpreter";
import type { KnowledgeProvenance, PgMemoryStore } from "@away_from/pth-memory";
import type { Task } from "@away_from/pth-kernel-storage";
import type { DomainBinding, DomainId } from "@away_from/pth-contracts";

export interface RefineInput {
  task: Pick<Task, "id" | "title" | "tags" | "claimed_by">;
  snapshot: InterpreterSnapshot;
  /** N19 Phase 1b：必填 scoped draft 租户/空间（fail-closed——缺省直接拒绝，不进 LLM）。 */
  scope: { tenantId: string; space: string };
  /** 任务语言（默认 typescript——vm 任务代码） */
  language?: string;
  /** 执行轨迹（任务 3 分化分析输入——agent 步骤/工具调用/解决的问题） */
  trace?: Array<{ type: string; step?: number; tool?: string; args?: Record<string, unknown>; contentPreview?: string; resultPreview?: string }>;
  /** 执行角色（分化建议的 parent——当前角色） */
  role?: string;
  /** F5：学科识别结果（lineage 追踪——meta.domains）。 */
  domains?: readonly DomainId[];
  /** F5：学科解析证据（合法才传；非法省略）。 */
  domainBinding?: DomainBinding;
  /** N19 Phase 1b：任务 outcome（供 provenance/诊断——可选）。 */
  outcome?: { status: string; result?: unknown };
  /** N19 Phase 1b：产物引用（provenance.sourceRefs；缺省 ["task:<id>"]）。 */
  artifactRefs?: string[];
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
  /** 自定义 refine 任务输出（persistAs=raw——清单 outputField → 原样值） */
  extra?: Record<string, unknown>;
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

/**
 * RefineTask 定义（refine 解硬编码——2026-08-10 用户方向）：
 * refine 的"分析什么/输出什么/存到哪"从代码搬到 memory（kind='refine-task'——数据化可演化——
 * 新增 refine 任务 = memory 加一条定义，不改代码）。持久化器（persistAs）保持代码内建——稳定机制。
 */
export interface RefineTaskDef {
  id: string;                 // 任务 id（functions/insights/differentiation/自定义）
  promptRules: string[];      // prompt 规则段落（buildRefinePrompt 动态拼接）
  outputField: string;        // LLM 输出 JSON 字段名
  outputSchema: string;       // 输出格式描述（prompt schema 段落）
  persistKind: string;        // 持久化 memory kind
  persistAs: "functions" | "insights" | "differentiation" | "raw";  // 内建持久化器
  enabled: boolean;
}

/** 默认三任务（启动 seed 到 memory——memory 缺失时的 fallback——与历史硬编码行为一致） */
export const DEFAULT_REFINE_TASKS: RefineTaskDef[] = [
  {
    id: "functions",
    promptRules: [
      "- functions: 只保留通用、可复用、后续任务可能用到的工具函数；source 必须与快照一致",
      "- spec.signature/purpose/logic/examples 是【构造文档】——迁移环境后据此重建函数（pickle 哲学）",
    ],
    outputField: "functions",
    outputSchema: `"functions": [{"key": "<函数名>", "source": "<完整源码>", "spec": {"signature": "<签名>", "purpose": "<用途>", "logic": "<逻辑说明>", "examples": [[输入,输出]]}}]`,
    persistKind: "tool-function",
    persistAs: "functions",
    enabled: true,
  },
  {
    id: "insights",
    promptRules: ["- insights: 提炼任务过程中的关键经验/结论/数据（简洁，每条 ≤100 字）"],
    outputField: "insights",
    outputSchema: `"insights": ["<经验/洞察字符串>"]`,
    persistKind: "task-insight",
    persistAs: "insights",
    enabled: true,
  },
  {
    id: "differentiation",
    promptRules: [
      "- differentiation（任务 3——角色分化分析）：分析本次任务是否可以分化成更小更具体的子任务——",
      "  若任务执行过程中反复出现某类可区分的子任务模式（探索/实现/验证/调研等有明显能力差异的阶段），",
      "  且该模式的能力需求与当前执行角色的定位不完全匹配，则建议分化（differentiable=true）——",
      "  给出子任务类型清单 + 建议新角色（parent=当前角色，specialization=特化方向，rationale=分化理由）。",
      "  若任务单一同质（无明显的可分化子任务模式）则 differentiable=false。",
      "  分化建议是【有监督】的——仅记录待确认，不会自动创建角色。",
    ],
    outputField: "differentiation",
    outputSchema: `"differentiation": {"differentiable": true|false, "subtasks": [{"type": "<子任务类型>", "description": "<描述>", "capabilityNeeds": ["<能力>"], "frequency": "<出现频率>"}], "suggestedRole": {"id": "<建议角色id>", "parent": "<父角色>", "specialization": "<特化方向>", "rationale": "<分化理由>"}, "confidence": "high|medium|low", "rationale": "<总体判断>"}`,
    persistKind: "differentiation-proposal",
    persistAs: "differentiation",
    enabled: true,
  },
];

/** 构造 refine prompt（含快照 + 任务信息 + 输出格式约束——tasks 缺省=默认清单） */
export function buildRefinePrompt(input: RefineInput, tasks: RefineTaskDef[] = DEFAULT_REFINE_TASKS): string {
  const { task, snapshot, language = "typescript" } = input;
  const enabled = tasks.filter((t) => t.enabled);
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
    `{${enabled.map((t) => t.outputSchema).join(", ")}}`,
    "",
    "规则:",
    ...enabled.flatMap((t) => t.promptRules.map((r) => r.replace("${language}", language))),
    `- 无可用内容时输出空结构（各字段给空值——如 ${enabled.map((t) => `"${t.outputField}": ${t.persistAs === "differentiation" ? '{"differentiable": false, "subtasks": []}' : "[]"}`).join(", ")}）`,
  ].join("\n");
}

/** 容错解析 LLM 输出（合法 JSON / ```json 围栏 / 失败降级）
 *  extra：自定义 refine 任务的输出字段（persistAs=raw——按 tasks 清单 outputField 原样提取） */
export function parseRefineResult(text: string, tasks?: RefineTaskDef[]): { ok: true; functions: RefinedFunction[]; insights: string[]; differentiation?: DifferentiationProposal; extra: Record<string, unknown> } | { ok: false } {
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
    // 自定义任务字段（persistAs=raw——清单里非三内建 outputField 的原样提取）
    const extra: Record<string, unknown> = {};
    if (tasks) {
      const builtins = new Set(["functions", "insights", "differentiation"]);
      for (const t of tasks) {
        if (t.enabled && !builtins.has(t.outputField)) {
          const v = (parsed as Record<string, unknown>)[t.outputField];
          if (v !== undefined) extra[t.outputField] = v;
        }
      }
    }
    return { ok: true, functions, insights, differentiation, extra };
  } catch {
    return { ok: false };
  }
}

export class Refiner {
  constructor(private deps: RefinerDeps) {}

  /** fail-closed：scope 缺失/字段非法 → 不调 LLM。 */
  private assertScope(input: RefineInput): void {
    const scope = input?.scope;
    if (!scope || typeof scope.tenantId !== "string" || scope.tenantId.length === 0
      || typeof scope.space !== "string" || scope.space.length === 0) {
      throw new Error("refine scope required");
    }
  }

  /** provenance.sourceRefs：artifactRefs 优先（过滤空串）；缺省/全空 → ["task:<id>"]。 */
  private sourceRefsOf(input: RefineInput): string[] {
    const refs = (input.artifactRefs ?? []).filter((r): r is string => typeof r === "string" && r.length > 0);
    return refs.length > 0 ? refs : [`task:${input.task.id}`];
  }

  /** meta.provenance 六字段（contentHash 真实 sha256——本地计算，避免 fork 子进程依赖 pth-memory dist 新导出）。 */
  private provenanceOf(input: RefineInput, content: string): KnowledgeProvenance {
    return {
      sourceTaskId: input.task.id,
      producerRole: input.role ?? input.task.claimed_by ?? "origin",
      producerModel: this.deps.model ?? "deepseek-v4-flash",
      sourceRefs: this.sourceRefsOf(input),
      contentHash: createHash("sha256").update(content).digest("hex"),
      createdAt: Date.now(),
    };
  }

  /** scoped draft 公共 meta：tenantId + spaceScope:{space,visibility:"private"} + provenance + lineage。 */
  private scopedMeta(input: RefineInput, content: string, extra: Record<string, unknown>): Record<string, unknown> {
    return {
      ...extra,
      tenantId: input.scope.tenantId,
      spaceScope: { space: input.scope.space, visibility: "private" as const },
      provenance: this.provenanceOf(input, content),
      domains: [...(input.domains ?? [])],
      ...(input.domainBinding ? { domainBinding: input.domainBinding } : {}),
      ...(input.outcome ? { outcomeStatus: input.outcome.status } : {}),
      artifactRefs: [...(input.artifactRefs ?? [])],
    };
  }

  /**
   * 加载 refine 任务清单（解硬编码——memory kind='refine-task' 是真相源——
   * 每次 refine 现读（演化即时生效——refine 频率低无性能问题）——缺失/异常 fallback 代码默认。
   */
  async loadTasks(tenantId: string): Promise<RefineTaskDef[]> {
    try {
      const entries = await this.deps.memory.retrieve({ kinds: ["refine-task"], tenantId });
      const tasks = entries
        .map((e) => { try { return JSON.parse(e.content) as RefineTaskDef; } catch { return null; } })
        .filter((t): t is RefineTaskDef => !!t && typeof t.id === "string" && typeof t.outputField === "string");
      return tasks.length > 0 ? tasks : DEFAULT_REFINE_TASKS;
    } catch {
      return DEFAULT_REFINE_TASKS;
    }
  }

  async refine(input: RefineInput): Promise<RefineReport> {
    const report: RefineReport = { functionsSaved: 0, insightsSaved: 0, differentiationProposed: false, skipped: [] };
    const refineStart = Date.now();

    // 0. fail-closed：scope 非法直接拒绝（不调 LLM、不落库）——N19 Phase 1b 设计 3.1/3.2。
    this.assertScope(input);

    // 0.1 任务清单（memory 真相源——解硬编码）
    const tasks = await this.loadTasks(input.scope.tenantId);
    const enabled = tasks.filter((t) => t.enabled);
    const taskOf = (persistAs: RefineTaskDef["persistAs"]) => enabled.find((t) => t.persistAs === persistAs);

    // 1. LLM 提炼
    const prompt = buildRefinePrompt(input, tasks);
    let result: RefineResult;
    try {
      const res = await this.deps.llm.complete(
        [{ role: "system", content: prompt }],
        { model: this.deps.model ?? "deepseek-v4-flash", provider: "deepseek" },
      );
      const parsed = parseRefineResult(res.content, tasks);
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

    const functionsTask = taskOf("functions");
    for (const fn of functionsTask ? functions : []) {
      const id = `fn-${hash(fn.source).slice(0, 12)}`;
      await this.deps.memory.write({
        id,
        kind: functionsTask!.persistKind,
        anchors: [...new Set([fn.key, ...(input.task.tags ?? []), language])],
        content: fn.source,   // 当前语言实现（pickle：保留当前实现）
        status: "draft",      // N19 Phase 1b：refiner 只写 scoped draft
        tenantId: input.scope.tenantId,
        meta: this.scopedMeta(input, fn.source, {
          spec: fn.spec ?? null,             // 构造文档（迁移重建依据）
          language,
          taskId: input.task.id,
          role: input.task.claimed_by,
          model: this.deps.model ?? "deepseek-v4-flash",
        }),
      });
      report.functionsSaved++;
    }

    const insightsTask = taskOf("insights");
    for (const insight of result.ok && insightsTask ? result.insights : []) {
      if (!insight.trim()) continue;
      const id = `insight-${hash(input.task.id + insight).slice(0, 12)}`;
      await this.deps.memory.write({
        id,
        kind: insightsTask!.persistKind,
        anchors: baseAnchors,
        content: insight,
        status: "draft",      // N19 Phase 1b：refiner 只写 scoped draft
        tenantId: input.scope.tenantId,
        meta: this.scopedMeta(input, insight, { taskId: input.task.id, role: input.task.claimed_by }),
      });
      report.insightsSaved++;
    }

    // 3.5 分化建议持久化（任务 3——有监督自动化：仅记录待确认——不自动创建角色）
    const diffTask = taskOf("differentiation");
    const diff = result.ok && diffTask ? result.differentiation : undefined;
    if (diff?.differentiable && diff.subtasks.length > 0) {
      const parent = diff.suggestedRole?.parent || input.role || input.task.claimed_by || "origin";
      const id = `diff-${hash(input.task.id + parent + diff.subtasks.map((s) => s.type).join(",")).slice(0, 12)}`;
      const diffContent = JSON.stringify({
        taskId: input.task.id,
        parent,
        subtasks: diff.subtasks,
        suggestedRole: diff.suggestedRole ?? null,
        confidence: diff.confidence ?? null,
        rationale: diff.rationale ?? null,
        status: "pending-review",   // 有监督——待确认（approved → 执行分化注册新角色）
      }, null, 2);
      await this.deps.memory.write({
        id,
        kind: diffTask!.persistKind,
        anchors: [...new Set([parent, ...(input.task.tags ?? []), ...diff.subtasks.map((s) => s.type)])],
        content: diffContent,
        status: "draft",            // draft=待审核（official=已确认——监督层流转）
        tenantId: input.scope.tenantId,
        meta: this.scopedMeta(input, diffContent, { taskId: input.task.id, parent, confidence: diff.confidence ?? null }),
      });
      report.differentiationProposed = true;
      this.deps.onMetric?.({ type: "differentiation-proposed", parent, subtaskCount: diff.subtasks.length });
    }

    // 3.6 自定义 refine 任务持久化（persistAs=raw——解硬编码的演化面：新任务不改代码）
    for (const t of enabled.filter((x) => x.persistAs === "raw")) {
      const v = result.ok ? result.extra?.[t.outputField] : undefined;
      if (v === undefined || v === null) continue;
      if (Array.isArray(v) && v.length === 0) continue;
      const id = `${t.id}-${hash(input.task.id + JSON.stringify(v)).slice(0, 12)}`;
      const rawContent = typeof v === "string" ? v : JSON.stringify(v, null, 2);
      await this.deps.memory.write({
        id,
        kind: t.persistKind,
        anchors: [...new Set([t.id, input.task.id, ...(input.task.tags ?? [])])],
        content: rawContent,
        status: "draft",            // 自定义任务产物默认 draft（监督层审——与分化建议同治理）
        tenantId: input.scope.tenantId,
        meta: this.scopedMeta(input, rawContent, { taskId: input.task.id, role: input.task.claimed_by, refineTask: t.id }),
      });
    }

    // 4. refine-report（溯源）——N19 Phase 1b：保持 official + tenantId + 显式 spaceScope private（诊断自用）
    await this.deps.memory.write({
      id: `refine-${input.task.id}`,
      kind: "refine-report",
      anchors: [input.task.id],
      content: `提炼 ${report.functionsSaved} 个工具函数 + ${report.insightsSaved} 条经验${report.differentiationProposed ? " + 1 条分化建议（待审核）" : ""}`,
      status: "official",
      tenantId: input.scope.tenantId,
      meta: {
        taskId: input.task.id,
        language,
        tenantId: input.scope.tenantId,
        spaceScope: { space: input.scope.space, visibility: "private" as const },
      },
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
