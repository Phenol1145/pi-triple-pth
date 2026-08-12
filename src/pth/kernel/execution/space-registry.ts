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

spaceRegistry.register({ id: "meta", kind: "meta", description: "元空间——纯协议层（无执行核；done 唯一使用场所）", builtin: true });
spaceRegistry.register({ id: "ts", kind: "action", execTool: "ts", parent: "meta", skeleton: "node:vm + stripTypes + preflight（import 拒绝/await 包装/超时双保险）", description: "TypeScript 程序空间（能力包注入：memory/llm/web/fs/state/ext…；元命令 ts.run/ts.eval）", builtin: true });
spaceRegistry.register({ id: "python", kind: "action", execTool: "python", parent: "meta", skeleton: "PyKernel 持久 REPL（共享 globals/_result 通道/超时 kill 重启；元命令 python.run/python.eval）", description: "Python 持久 REPL 空间（sandbox 执行）", builtin: true });
spaceRegistry.register({ id: "bash", kind: "action", execTool: "bash", parent: "meta", skeleton: "BashKernel 持久会话（元命令 bash.run/bash.eval）", description: "Bash 持久会话空间（sandbox 执行）", builtin: true });
// 生产核·代码产物（2026-08-11 用户裁决：探索核/生产核分立——编译类语言无探索核，C 的一切归 dev 空间；
// 原 c 空间（c_execute 空壳）撤销——C 产物编写/构建/运行/调试/单元管理全在 dev 空间）
spaceRegistry.register({ id: "dev", kind: "action", execTool: "dev", extraTools: ["debug"], parent: "meta", skeleton: "生产核·代码产物（dev.write/edit/build/run/save/list + debug.* 调试会话——产物代码写任务工作区，sandbox 编译/调试）", description: "代码产物开发生产空间（编译类语言唯一入口）", builtin: true,
  // 空间治理 v2（批 3）：dev 是唯一可建子空间的内置空间——"把不确定的代码放进自制隔离子空间执行，用完注销"；
  // childParams = 子空间凭据必填参量表单（能力面 execTool/extraTools 收窄 + 记忆域 memoryScope 分配）
  allowChildren: true, maxDepth: 2,
  childParams: [
    { name: "execTool", required: true, description: "子空间语言执行工具名（能力面收窄——须为已注册语言族：ts/python/bash/dev/write）" },
    { name: "memoryScope", required: true, description: "记忆域标注（子空间记忆域名——缺省继承父空间；实际可见性过滤按空间 id 树）" },
    { name: "extraTools", description: "工具族收窄（父空间 extraTools 的子集——dev 下仅可挂 debug 族）" },
    { name: "description", required: true, description: "子空间说明" },
  ],
});
// 生产核·文档产物（2026-08-12 批 2：编写类任务独立空间——代码/文档两空间分立。
// 工具面 create/edit/read/list/save + section 章节组织（章节走文档内工具——非子空间）；
// 无 build/debug——文档不编译；allowChildren=false 章节不建子空间）
spaceRegistry.register({ id: "write", kind: "action", execTool: "write", parent: "meta", skeleton: "生产核·文档产物（write.create/edit/read/list/save + write.section 章节组织——大纲→草稿→修订→定稿；文档写任务工作区，章节用 write.section 管理）", description: "文档产物生产空间（编写类任务唯一入口）", builtin: true });
