/**
 * kernel/execution/tool-registry.ts —— N14 P2：tool-reg 注册表运行时读取面。
 *
 * 依据 docs/pth/n14-sensor-controller-four-dims.md §3.3/§3.5：
 *   执行缝 = 静态 TOOL_SCHEMAS ∪ 注册表可见集（按 role 过滤 visibility、按快照版本冻结）；
 *   快照版本化（T3 教训防线）——任务开始时冻结快照，工具面按版本边界变化，不逐任务变；
 *   预算守卫——每角色工具面 ≤ PTH_TOOL_FACE_BUDGET（缺省 24），注册面超限裁减（静态面不动）。
 *
 * 本模块只读：loadToolRegSnapshot 从 memory_entries（kind=tool-reg，status=official）
 * 装载并逐条 parseToolRegContent 校验（非法/非 official 不进面——§7-4：draft 不可见不可调）。
 * builtin 条目的执行仍走 AGENT_TOOLS 静态表（执行不动——Q4 裁决）；program/agent 态
 * 由 agent-loop 执行缝分发（program=ts 核 / agent=穿透 runChild 同款缝）。
 *
 * P2 自决（设计未钉的小点）：
 *   ① ASP 空间投放——注册工具面空间无关（全空间可见）；空间级投放留待后续细化；
 *   ② 预算只裁注册面——静态面（actionTools 声明）现状不变（预算守卫对静态面的收口属 P3+ 议题）；
 *   ③ program 态能力白名单——v1 继承 worker 任务级 caps（与 ts.run 同边界）；条目级声明留 P3+。
 */

import { parseToolRegContent, type ToolRegSpec } from "@away_from/pth-memory";
import type { TaskDispatchContext } from "../../contracts/index.js";

/** agent 态注册工具的执行缝请求（穿透 PenetrationRunChildRequest 同款结构——复用其装配实现） */
export interface ToolRegRunChildRequest {
  childRoleId: string;
  title: string;
  /** 已合成任务文本（输入/产物契约 + 调用参数） */
  text: string;
  inputContract: string;
  outputContract: string;
  /** 审计/轨迹标注（tool:<name>） */
  skillId: string;
  caller: TaskDispatchContext;
}

export interface ToolRegRunChildResult {
  ok: boolean;
  value?: unknown;
  summary?: string;
  steps: number;
  error?: string;
  durationMs: number;
}

/** agent 态执行缝（bootstrap 注入——穿透 runChild 同一闭包；深度限 1 由实现方保证） */
export type ToolRegRunChild = (req: ToolRegRunChildRequest) => Promise<ToolRegRunChildResult>;

/** 注册表读取窄口（PgMemoryStore 结构型兼容） */
export interface ToolRegStoreLike {
  listIds(): Promise<string[]>;
  get(id: string): Promise<{ id: string; kind: string; status?: string; content: unknown } | undefined>;
}

export interface ToolRegSnapshot {
  /** 快照版本（内容指纹——任务开始冻结，任务中途注册新工具不影响本任务） */
  version: string;
  takenAt: number;
  /** key = 工具名（点形真相源——spec.name） */
  entries: ReadonlyMap<string, ToolRegSpec>;
}

/** FNV-1a 32bit（快照指纹——无依赖小哈希） */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * 装载注册表快照：official + 校验通过才进面（draft 不可见——治理门槛同款）。
 * 装载失败单条跳过（一条坏条目不阻塞全局面——登记漂移由对账测试/--check 兜底）。
 */
export async function loadToolRegSnapshot(store: ToolRegStoreLike): Promise<ToolRegSnapshot> {
  const ids = (await store.listIds()).filter((id) => id.startsWith("tool:")).sort();
  const entries = new Map<string, ToolRegSpec>();
  for (const id of ids) {
    const row = await store.get(id);
    if (!row || row.kind !== "tool-reg" || row.status !== "official") continue;
    const parsed = parseToolRegContent(typeof row.content === "string" ? row.content : String(row.content ?? ""));
    if (!parsed.ok) continue;
    entries.set(parsed.spec.name, parsed.spec);
  }
  const fingerprint = fnv1a([...entries.entries()].map(([n, s]) => `${n}@${s.version}`).join(","));
  return { version: `tr-${entries.size}-${fingerprint}`, takenAt: Date.now(), entries };
}

/** 注册表可见集（0.17.3 命题 3 防线——按 visibility.roles 窄投放；名称排序确定性） */
export function visibleRegistryTools(snapshot: ToolRegSnapshot, roleId: string): ToolRegSpec[] {
  return [...snapshot.entries.values()]
    .filter((s) => s.visibility.roles.includes(roleId))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 预算守卫（§3.3）：静态面已占额度后，注册面只允许补足到预算。
 * 超出预算的注册工具按名称序裁减（确定性），返回 allowed/dropped 两集。
 */
export function checkToolFaceBudget(
  staticFaceSize: number,
  registrySpecs: readonly ToolRegSpec[],
  budget: number,
): { allowed: ToolRegSpec[]; dropped: string[] } {
  const room = Math.max(0, budget - Math.max(0, staticFaceSize));
  const allowed = registrySpecs.slice(0, room);
  const dropped = registrySpecs.slice(room).map((s) => s.name);
  return { allowed, dropped };
}

/** 三要素 → 工具描述（与 ptc/tools.ts 渲染同款格式——工具面文本一致性） */
export function renderRegistryToolDescription(spec: ToolRegSpec): string {
  const d = spec.description;
  return "【场景锚点：" + d.anchor + "】何时用：" + d.whenToUse + "。效果：" + d.effect + "。";
}

/** 注册条目 → pi-ai Tool（OpenAI function 格式——name 去点同静态面规则） */
export function registryToolToSchema(spec: ToolRegSpec): { name: string; description: string; parameters: { type: "object"; properties: Record<string, unknown>; required: string[] } } {
  return {
    name: spec.name.replace(/\./g, "_"),
    description: renderRegistryToolDescription(spec),
    parameters: { type: "object", properties: spec.parameters.properties, required: spec.parameters.required },
  };
}
