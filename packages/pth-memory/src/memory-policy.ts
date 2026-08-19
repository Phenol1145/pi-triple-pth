/**
 * memory-policy —— 记忆用途层权限策略（2026-08-10 权限系统 v2 R1）。
 *
 * 背景：memory_entries 一表四用途（提示词/配置/治理/知识）——权限按【用途层】切。
 * 本模块是 worker 面 memory.* 环境函数的内嵌规则（ASP 权限第二层）：
 *
 *   prompt 层（role-doc:* · capability-index · project-map · pth-worker-system · self-modify-guide · skill:* · extension-index · tool-reg）
 *     —— 系统提示词资产：worker 只读。写了 = 污染全 worker 的 prompt 注入。
 *   config 层（trigger · refine-task:*）
 *     —— 系统行为配置：worker 只读。写了 = 自开触发器/自改 refine 行为。
 *   governance 层（differentiation-proposal/refine-report/tool-proposal:*）
 *     —— 治理状态机：worker 可提交草案（强制 status=draft），不可自批/不可流转。
 *   knowledge 层（其余全部——task-insight/tool-function/dev-artifact/domain-fact/…）
 *     —— 共享知识层：读可，写强制 draft（N29/P0-4，§1.6）。外部内容与 LLM 产物只能进 private
 *        draft candidate；official 必须由 Promotion Service 在核验后晋升。本策略没有
 *        principal/role 入参——worker、service 与 platform-admin service 得到同一结论。
 *
 * 系统通道（refiner/lineage approve/trigger API/injectPromptDocs）直写 store 不经本策略。
 * store 层 isSystemDocId 与 knowledge official authority 保留作纵深防御。
 */

export type MemoryLayer = "prompt" | "config" | "governance" | "knowledge";

const PROMPT_KINDS = new Set([
  "capability-index",
  "project-map",
  "pth-worker-system",
  "self-modify-guide",
  "extension-index",
  // 2026-08-15 筛查 H7：系统装配恢复源——worker 可伪造 official 条目 → 重启注册角色/空间
  "worker-role",
  "space-reg",
  "worker-index",
  // 2026-08-18 N14 P0：工具注册表治理面（tool:<name> 条目）——worker 只读防伪造注册；
  // 注册走治理流（提案→对抗性审核→批准→注册生效）
  "tool-reg",
]);

/** kind → 用途层（策略的唯一事实源） */
export function layerOfKind(kind: string): MemoryLayer {
  if (PROMPT_KINDS.has(kind)) return "prompt";
  if (kind === "role-doc" || kind.startsWith("role-doc:")) return "prompt";
  if (kind === "skill" || kind.startsWith("skill:")) return "prompt";
  if (kind === "trigger") return "config";
  if (kind === "refine-task" || kind.startsWith("refine-task:")) return "config";
  if (kind === "differentiation-proposal" || kind === "refine-report") return "governance";
  // N14 P3：工具注册提案（tool-reg 治理流——worker 可提交草案，强制 draft，流转走监督层）
  if (kind === "tool-proposal" || kind.startsWith("tool-proposal:")) return "governance";
  // v1.3 P0 Task 1：Index Memory 三类导航元数据 kind 明确归 knowledge 层——
  // worker memory.write 不能自声明 official（强制 draft），official 只能由 Promotion Service 晋升。
  if (kind === "source-index" || kind === "symbol-index" || kind === "memory-collection-index") return "knowledge";
  return "knowledge";
}

export interface PolicyCheck {
  ok: boolean;
  reason?: string;
  /** 写入时的状态强制（draft）：governance 层不可自批；knowledge 层不可 direct official（N29 P0-4）。 */
  forceStatus?: "draft";
}

export interface WriteEntryLike {
  id?: string;
  kind: string;
  content?: unknown;
  status?: string;
  anchors?: unknown;
  [k: string]: unknown;
}

/**
 * write 参数归一（历史双签名并存——对象形 write({kind,content,…}) 与位置形 write(kind, content, opts)：
 * 统一为对象形。真实 PgMemoryStore.write 是对象签名——位置形是 memoryScope 包装遗留的错配）。
 */
export function normalizeWriteArgs(a: unknown, b: unknown, c: unknown): WriteEntryLike {
  if (typeof a === "string") {
    const opts = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
    return { ...opts, kind: a, content: b } as WriteEntryLike;
  }
  return (a ?? {}) as WriteEntryLike;
}

/** worker 面 write 校验（entry.kind + entry.status） */
export function checkWrite(kind: string, status?: string): PolicyCheck {
  if (typeof kind !== "string" || !kind) {
    return { ok: false, reason: "memory.write: kind 必填（用途层分级依据——knowledge 层用 task-insight/tool-function/dev-artifact 等）" };
  }
  const layer = layerOfKind(kind);
  if (layer === "prompt") {
    return { ok: false, reason: `memory.write: kind "${kind}" 属 prompt 层（系统提示词资产）——worker 只读` };
  }
  if (layer === "config") {
    return { ok: false, reason: `memory.write: kind "${kind}" 属 config 层（系统行为配置）——worker 只读（trigger 请走 trigger API）` };
  }
  if (layer === "governance") {
    // 提交草案可——自批/流转不可（强制 draft 覆盖传入 status）
    if (status && status !== "draft") {
      return { ok: true, forceStatus: "draft" };
    }
    return { ok: true, forceStatus: "draft" };
  }
  // N29/P0-4（§1.6）：knowledge 层一律强制 draft——recon/memory-maintain/processor 等
  // 外部内容路径都不能 direct official；official 只能由 Promotion Service 在
  // VerificationPlan + 双 verdict + exact hash 满足后晋升。
  // 注意：本函数没有 principal/role 入参 → service 与 platform-admin service 同样被强制。
  return { ok: true, forceStatus: "draft" };
}

/** worker 面 update 校验（目标条目的 kind——补 isSystemDocId 不到 update 的洞） */
export function checkUpdate(kind: string, patchStatus?: string, existingStatus?: string): PolicyCheck {
  const layer = layerOfKind(kind);
  if (layer === "prompt") {
    return { ok: false, reason: `memory.update: kind "${kind}" 属 prompt 层——worker 不可改系统文档（含内容修正）` };
  }
  if (layer === "config") {
    return { ok: false, reason: `memory.update: kind "${kind}" 属 config 层——worker 不可改系统配置` };
  }
  if (layer === "governance" && patchStatus !== undefined) {
    return { ok: false, reason: `memory.update: governance 层状态流转由监督层执行——worker 不可改 status（draft 内容修正允许）` };
  }
  // 2026-08-15 筛查 H6：governance 层 official 条目冻结——内容修正仅限 draft
  if (layer === "governance" && existingStatus && existingStatus !== "draft" && patchStatus === undefined) {
    return { ok: false, reason: `memory.update: governance 层 ${existingStatus} 条目不可改内容（仅 draft 可修订）` };
  }
  // N29/P0-4：knowledge 层不得经 update 把 draft 流转为 official（否则 write 强制 draft 形同虚设）。
  // 晋升只能走 Promotion Service（promoteOfficial 的窄 CAS 方法）。
  if (layer === "knowledge" && patchStatus === "official") {
    return {
      ok: false,
      reason: `memory.update: kind "${kind}" 属 knowledge 层——draft→official 只能由 Promotion Service 晋升（worker/service 不可自批）`,
    };
  }
  return { ok: true };
}
