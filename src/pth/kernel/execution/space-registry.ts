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
}

export class SpaceRegistry {
  private readonly spaces = new Map<string, SpaceDef>();

  register(def: SpaceDef): void {
    const existing = this.spaces.get(def.id);
    if (existing) {
      // 幂等（2026-08-12 审计：关键字段比较——extraTools/skeleton/description/parent 变化报冲突，防静默忽略）
      const same =
        existing.kind === def.kind && existing.execTool === def.execTool &&
        existing.parent === def.parent && existing.builtin === def.builtin &&
        existing.allowChildren === def.allowChildren && existing.maxDepth === def.maxDepth &&
        existing.memoryScope === def.memoryScope &&
        JSON.stringify(existing.extraTools ?? []) === JSON.stringify(def.extraTools ?? []) &&
        JSON.stringify(existing.childParams ?? []) === JSON.stringify(def.childParams ?? []) &&
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

  list(): SpaceDef[] {
    return [...this.spaces.values()];
  }
}

/** 全局注册表（内置空间随模块加载注册） */
export const spaceRegistry = new SpaceRegistry();

// 内置空间装配（2026-08-12 分层：注册表=核心——内置空间=实现——impls/spaces/builtin-spaces.ts；
// 本行是核心对默认实现的装配引用——未来无内置发行版 = 移除本行 + 装配注入）
import "../../impls/spaces/builtin-spaces.js";
// 内置空间装配（2026-08-12 分层：注册表=核心——内置空间=实现——impls/spaces/builtin-spaces.ts；
// 函数式注册（参数注入）——避免顶层副作用循环 TDZ；未来无内置发行版 = 移除装配调用）
import { registerBuiltinSpaces } from "../../impls/spaces/builtin-spaces.js";
registerBuiltinSpaces(spaceRegistry);
