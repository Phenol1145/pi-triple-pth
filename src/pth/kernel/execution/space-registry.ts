/**
 * space-registry —— 动作空间注册表（ASP v2——2026-08-10）。
 *
 * 协议定位：元空间（meta）是 AI 初始驻地（纯协议层——无语言骨架/无执行核）；
 * 动作空间（ts/python/bash/c）是语言代码唯一可解析执行的场所。
 *
 * 数据驱动（用户裁决"元工具不硬编码"）：空间定义注册进表——新空间（含运行时
 * asp.create 生成的子空间）= 一条注册记录。
 *
 * 状态机规则：
 *   - 当前空间决定可解析内容：语言代码仅在其对应动作空间可执行
 *   - done 仅元空间（根级完成宣告）
 *   - asp.* / memory.* / cache.* 环境函数全空间可用
 */

export type SpaceKind = "meta" | "action";

/** 子空间必填参量表单（childParams 声明——2026-08-12 用户裁决批 3）：
 * 创建者必须提供能力面收窄（execTool/extraTools）+ 记忆域分配（memoryScope）的取值。 */
export interface ChildParamDef {
  name: string;
  required?: boolean;
  description?: string;
}

export interface SpaceDef {
  id: string;
  kind: SpaceKind;
  /** 语言执行工具名（LLM 原生工具面——下划线形：python_execute；meta 无） */
  execTool?: string;
  /** 语言骨架摘要（索引/prompt 用） */
  skeleton?: string;
  description: string;
  /** 父空间（asp.create 生成的子空间——衰减校验用；内置空间为 meta） */
  parent?: string;
  /** 内置空间标记（asp.create 生成的为 false——可注销；内置 true 不可注销） */
  builtin?: boolean;
  /** 额外工具族（2026-08-11 生产核——dev 空间挂 debug 族）：族名清单，工具面/门控反查同 execTool 族名展开 */
  extraTools?: string[];
  // ── 空间治理 v2（2026-08-12 用户裁决批 3）──────────────────────────────
  /** 是否允许 asp.create 生成子空间（缺省 false；meta 恒 false——凭据根级固化） */
  allowChildren?: boolean;
  /** 最大深度（meta=0、内置空间=1、子空间=2……）——asp.create 校验子空间深度 ≤ 父 maxDepth */
  maxDepth?: number;
  /** 子空间必填参量表单（asp.create 缺字段拒绝并展示表单——索引即引导） */
  childParams?: ChildParamDef[];
  /** 记忆域（worker 分化凭据第二轴：动作空间 × 记忆空间；索引/prompt 展示用——
   * 实际过滤由 PTH 网关 space 维度 + role 前缀域承担） */
  memoryScope?: string;
  /** 空间-角色绑定（2026-08-14 N8——生成即绑定）：绑定的 worker 类型（角色 id——谱系上溯匹配，
   *  role.id 或任一祖先命中即匹配）。生成空间（治理通道产物）必填——为谁生成就绑谁；
   *  语言执行基板（内置空间）不填 = 不绑定（全角色共享基础设施）。 */
  bindRoles?: string[];
}

export class SpaceRegistry {
  private readonly spaces = new Map<string, SpaceDef>();

  register(def: SpaceDef): void {
    // 绑定格式校验（2026-08-14 N8）：bindRoles 若声明——非空数组、合法角色 id（小写字母数字连字符冒号）、无重复
    if (def.bindRoles !== undefined) {
      if (!Array.isArray(def.bindRoles) || def.bindRoles.length === 0) {
        throw new Error(`space "${def.id}" 绑定非法：bindRoles 必须是非空数组`);
      }
      const seen = new Set<string>();
      for (const b of def.bindRoles) {
        if (typeof b !== "string" || !/^[a-z0-9:-]+$/i.test(b)) {
          throw new Error(`space "${def.id}" 绑定非法：角色 id "${String(b)}"（限小写字母数字连字符冒号）`);
        }
        if (seen.has(b)) throw new Error(`space "${def.id}" 绑定重复：${b}`);
        seen.add(b);
      }
    }
    const existing = this.spaces.get(def.id);
    if (existing) {
      // 幂等（2026-08-12 审计：关键字段比较——extraTools/skeleton/description/parent 变化报冲突，防静默忽略；
      // 2026-08-14 N8：bindRoles 加入第 10 字段——绑定可变 → 冲突报错）
      const same =
        existing.kind === def.kind && existing.execTool === def.execTool &&
        existing.parent === def.parent && existing.builtin === def.builtin &&
        existing.allowChildren === def.allowChildren && existing.maxDepth === def.maxDepth &&
        existing.memoryScope === def.memoryScope &&
        JSON.stringify(existing.extraTools ?? []) === JSON.stringify(def.extraTools ?? []) &&
        JSON.stringify(existing.childParams ?? []) === JSON.stringify(def.childParams ?? []) &&
        JSON.stringify(existing.bindRoles ?? []) === JSON.stringify(def.bindRoles ?? []) &&
        existing.skeleton === def.skeleton && existing.description === def.description;
      if (same) return;
      throw new Error(`space "${def.id}" 注册冲突（已存在 kind=${existing.kind} execTool=${existing.execTool} parent=${existing.parent}）`);
    }
    this.spaces.set(def.id, def);
  }

  /** 深度（沿 parent 链——meta=0） */
  depthOf(id: string): number {
    let depth = 0;
    let cur = this.spaces.get(id);
    const seen = new Set<string>();
    while (cur?.parent && cur.parent !== "meta" && !seen.has(cur.parent)) {
      seen.add(cur.parent);
      depth += 1;
      cur = this.spaces.get(cur.parent);
    }
    return depth;
  }

  /** 子空间清单（直接后代） */
  childrenOf(id: string): SpaceDef[] {
    return this.list().filter((s) => s.parent === id);
  }

  /** 注销（asp.destroy——内置空间保护：builtin 标记的空间不可注销；有子空间拒绝——2026-08-12
   * 审计 BUG-4：孤儿后代会断 parent 链（深度/记忆可见性上溯中断、可绕过深度封顶）——需先注销后代） */
  unregister(id: string): boolean {
    const def = this.spaces.get(id);
    if (!def) return false;
    if (def.builtin) {
      throw new Error(`space "${id}" 是内置空间——不可注销`);
    }
    const children = this.childrenOf(id);
    if (children.length > 0) {
      throw new Error(`space "${id}" 有 ${children.length} 个子空间（${children.map((c) => c.id).join("/")}）——先注销后代再注销本空间`);
    }
    return this.spaces.delete(id);
  }

  get(id: string): SpaceDef | undefined {
    return this.spaces.get(id);
  }

  isActionSpace(id: string): boolean {
    return this.spaces.get(id)?.kind === "action";
  }

  /** 执行工具名 → 所属空间 id（门控反查——点形/下划线形归一：模型可能输出 python.execute 或 python_execute）。
   * 族名匹配（2026-08-11 元命令拆分）：execTool 无下划线时为族名（如 ts）——ts_eval/ts_run 同族归属；
   * execTool 含下划线（python_execute/c_execute/custom_exec）精确匹配。 */
  spaceOfExecTool(tool: string): string | null {
    const normalized = tool.replace(/\./g, "_");
    for (const s of this.spaces.values()) {
      if (!s.execTool) continue;
      if (s.execTool === tool || s.execTool === normalized) return s.id;
      const family = s.execTool.replace(/\./g, "_");
      if (!family.includes("_") && (normalized === family || normalized.startsWith(`${family}_`))) return s.id;
      // extraTools 族名反查（生产核 dev 空间的 debug 族归属）
      for (const extra of s.extraTools ?? []) {
        if (normalized === extra || normalized.startsWith(`${extra}_`)) return s.id;
      }
    }
    return null;
  }

  /** 工具归属（2026-08-14 N8——绑定空间继承基板工具族）：工具是否可在该空间解析。
   *  execTool/extraTools 族内匹配——同族多空间（基板 ts + 绑定子空间 ts）时以**当前空间**为准，
   *  而非 spaceOfExecTool 的首个族匹配空间（进入校验与工具面已按当前空间，门控必须同源）。 */
  spaceOwnsTool(spaceId: string, tool: string): boolean {
    const s = this.spaces.get(spaceId);
    if (!s?.execTool) return false;
    const normalized = tool.replace(/\./g, "_");
    const family = s.execTool.replace(/\./g, "_");
    if (!family.includes("_") && (normalized === family || normalized.startsWith(family + "_"))) return true;
    if (normalized === family) return true;
    for (const extra of s.extraTools ?? []) {
      const ef = extra.replace(/\./g, "_");
      if (normalized === ef || normalized.startsWith(ef + "_")) return true;
    }
    return false;
  }

/** 治理通道创建子空间（2026-08-14 N8——空间生成走优化通道/审批面：本方法即通道入口）。
 *  worker 工具面 asp.create 已退役（agent-loop 分支移除）；原分支的治理校验全量迁入——
 *  深度衰减/工具族收窄/childParams 表单/meta 禁建/绑定必填全部在此强制执行。
 *  校验顺序 = 原 asp.create 分支顺序（错误消息逐条兼容迁移）。 */
createChild(parentId: string, def: {
  id: string;
  execTool: string;
  memoryScope?: string;
  extraTools?: string[];
  skeleton?: string;
  description: string;
  /** N8 生成即绑定：为哪个 worker 类型生成——必填（角色 id，谱系上溯匹配） */
  bindRoles: string[];
}): SpaceDef {
  const parent = this.spaces.get(parentId);
  if (!parent) throw new Error(`createChild: 父空间 "${parentId}" 不存在`);
  if (parentId === "meta") throw new Error(`createChild: meta 空间禁建子空间（凭据根级固化——顶层空间是系统内置凭据模板，不由 worker 演化）`);
  if (parent.allowChildren !== true) {
    const form = parent.childParams?.length
      ? `（childParams 表单: ${parent.childParams.map((p) => p.name + (p.required ? "*" : "")).join("/")}）`
      : "";
    throw new Error(`createChild: 空间 "${parentId}" 未声明 allowChildren（不可建子空间）${form}——asp.index 查看可建空间`);
  }
  if (!/^[a-z0-9-]{1,32}$/.test(def.id)) throw new Error(`createChild: id 非法（小写字母数字连字符 ≤32）——got "${def.id}"`);
  const KNOWN_EXEC_TOOLS = ["ts", "python", "bash", "dev", "write"];
  if (!KNOWN_EXEC_TOOLS.includes(def.execTool)) {
    throw new Error(`createChild: execTool "${def.execTool}" 不是已注册语言族（可用: ${KNOWN_EXEC_TOOLS.join("/")}）——子空间凭据的能力面收窄须落在既有执行面上`);
  }
  const childDepth = this.depthOf(parentId) + 1;
  if (parent.maxDepth !== undefined && childDepth > parent.maxDepth) {
    throw new Error(`createChild: 深度 ${childDepth} 超过父空间 maxDepth=${parent.maxDepth}（空间树已到最大深度）`);
  }
  const missing = (parent.childParams ?? [])
    .filter((p) => p.required && String((def as unknown as Record<string, unknown>)[p.name] ?? "").trim() === "")
    .map((p) => p.name);
  if (missing.length > 0) {
    const form = (parent.childParams ?? [])
      .map((p) => `  - ${p.name}${p.required ? "（必填）" : "（可选）"}: ${p.description ?? ""}`).join("\n");
    throw new Error(`createChild: 缺必填参量 [${missing.join(", ")}]。子空间凭据表单（${parentId} 空间声明）：\n${form}`);
  }
  if ((def.extraTools ?? []).some((t) => !(parent.extraTools ?? []).includes(t))) {
    throw new Error(`createChild: extraTools 只能收窄不能扩权——可用工具族 ⊆ 父空间（${(parent.extraTools ?? []).length ? (parent.extraTools ?? []).join("/") : "无——子空间不得挂工具族"}）`);
  }
  if (!def.bindRoles || def.bindRoles.length === 0) {
    throw new Error(`createChild: bindRoles 必填（生成即绑定——声明为哪个 worker 类型生成的空间）`);
  }
  const full: SpaceDef = {
    id: def.id, kind: "action", parent: parentId, execTool: def.execTool,
    extraTools: def.extraTools, memoryScope: def.memoryScope, skeleton: def.skeleton,
    description: def.description, bindRoles: def.bindRoles,
    // 治理继承（批 3）：allowChildren/maxDepth 沿父链继承——深度封顶连续
    allowChildren: parent.allowChildren,
    maxDepth: parent.maxDepth,
  };
  this.register(full);
  return full;
}

  list(): SpaceDef[] {
    return [...this.spaces.values()];
  }
}

/** 绑定匹配（2026-08-14 N8——生成即绑定）：role 匹配空间 ⇔ 空间未绑定（基板/全角色）
 *  ∨ role.id 或任一祖先 ∈ bindRoles（谱系上溯——worker 类型 = 谱系）。
 *  roles = 现存角色集（外部注入——allLineageRoles 或测试集）；role 缺失 → 放行（兼容——
 *  无角色上下文的调用不校验）。绑定集与现存谱系零交时由调用方按「无主空间」处理（保守拒绝）。 */
export function isRoleBoundToSpace(
  space: SpaceDef,
  role: { id: string; parent?: string } | undefined,
  roles: ReadonlyArray<{ id: string; parent?: string }> = [],
): boolean {
  const binds = space.bindRoles;
  if (!binds || binds.length === 0) return true;   // 基板/全角色
  if (!role) return true;                            // 无角色上下文（测试/兼容）
  const byId = new Map(roles.map((r) => [r.id, r]));
  const chain = new Set<string>();
  let cur: { id: string; parent?: string } | undefined = role;
  let guard = 0;
  while (cur && !chain.has(cur.id) && guard++ < 32) {
    chain.add(cur.id);
    cur = cur.parent ? byId.get(cur.parent) : undefined;
  }
  return binds.some((b) => chain.has(b));
}

/** 全局注册表（内置空间随模块加载注册） */
export const spaceRegistry = new SpaceRegistry();

// 内置空间装配（2026-08-12 分层：注册表=核心——内置空间=实现——impls/spaces/builtin-spaces.ts；
// 函数式注册（参数注入）——避免顶层副作用循环 TDZ；未来无内置发行版 = 移除装配调用）
// 2026-08-12 审计 LOW-10：删除冗余 side-effect import（builtin-spaces 无顶层副作用）
import { registerBuiltinSpaces } from "../../impls/spaces/builtin-spaces.js";
registerBuiltinSpaces(spaceRegistry);
