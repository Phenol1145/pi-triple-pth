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
}

export class SpaceRegistry {
  private readonly spaces = new Map<string, SpaceDef>();

  register(def: SpaceDef): void {
    const existing = this.spaces.get(def.id);
    if (existing) {
      if (existing.kind === def.kind && existing.execTool === def.execTool) return;   // 幂等
      throw new Error(`space "${def.id}" 注册冲突（已存在 kind=${existing.kind}）`);
    }
    this.spaces.set(def.id, def);
  }

  /** 注销（asp.destroy——内置空间保护：parent=meta 或元空间本身不可注销） */
  unregister(id: string): boolean {
    const def = this.spaces.get(id);
    if (!def) return false;
    if (def.id === "meta" || !def.parent || def.parent === "meta") {
      throw new Error(`space "${id}" 是内置空间——不可注销`);
    }
    return this.spaces.delete(id);
  }

  get(id: string): SpaceDef | undefined {
    return this.spaces.get(id);
  }

  isActionSpace(id: string): boolean {
    return this.spaces.get(id)?.kind === "action";
  }

  /** 执行工具名 → 所属空间 id（门控反查——点形/下划线形归一：模型可能输出 python.execute 或 python_execute） */
  spaceOfExecTool(tool: string): string | null {
    const normalized = tool.replace(/\./g, "_");
    for (const s of this.spaces.values()) {
      if (s.execTool === tool || s.execTool === normalized) return s.id;
    }
    return null;
  }

  list(): SpaceDef[] {
    return [...this.spaces.values()];
  }
}

/** 全局注册表（内置空间随模块加载注册） */
export const spaceRegistry = new SpaceRegistry();

spaceRegistry.register({ id: "meta", kind: "meta", description: "元空间——纯协议层（无执行核；done 唯一使用场所）" });
spaceRegistry.register({ id: "ts", kind: "action", execTool: "ts", parent: "meta", skeleton: "node:vm + stripTypes + preflight（import 拒绝/await 包装/超时双保险）", description: "TypeScript 程序空间（能力包注入：memory/llm/web/fs/state/ext…）" });
spaceRegistry.register({ id: "python", kind: "action", execTool: "python_execute", parent: "meta", skeleton: "PyKernel 持久 REPL（共享 globals/_result 通道/超时 kill 重启）", description: "Python 持久 REPL 空间（sandbox 执行）" });
spaceRegistry.register({ id: "bash", kind: "action", execTool: "bash_execute", parent: "meta", skeleton: "BashKernel 持久会话", description: "Bash 持久会话空间（sandbox 执行）" });
spaceRegistry.register({ id: "c", kind: "action", execTool: "c_execute", parent: "meta", skeleton: "编译核（gcc/clang/tcc——compiled-units 命名单元）", description: "C 编译运行空间（sandbox 编译）" });
