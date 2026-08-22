/**
 * tag-registry —— 标签总表（注册通道——2026-08-10 任务池纯化设计 D8）。
 *
 * 定位：任务标签的唯一权威注册表。角色标签是分选器的唯一标准（精确匹配——
 * 双向 includes 模糊匹配废止）；complexity/priority 为预留维度（注册通道已开）。
 *
 * 规则（用户裁决）：
 *   - 严格校验：提交任务的 tags 未注册 → 400 拒绝（无自由标签）
 *   - 精确匹配：routeRole 只按全等匹配（"testing" 不命中 "test"）
 *   - 歧义拒绝：tags 命中多个不同角色 → 调用方判 400
 *   - 幂等注册：同义重复注册跳过；同名不同义（角色/kind 不同）→ 冲突抛错
 *
 * 注册来源：内置角色（worker-cluster 模块加载）/ registerWorkerRole（扩展角色自动挂载）
 *   / 未来 API 或扩展显式注册（complexity/priority 维度）。
 */

/** 标签维度：role=角色派发（路由消费）；complexity/priority=预留（注册即合法，暂无系统消费）；
 * governance=治理角色共享标签（sensor/controller 系——同标签多角色不参与 routeRole——派发走 flow 显式） */
export type TagKind = "role" | "complexity" | "priority" | "governance";

export interface TagDef {
  /** 标签名（注册时小写归一——匹配大小写不敏感） */
  name: string;
  kind: TagKind;
  /** kind=role 必填——路由目标角色 id */
  role?: string;
  description?: string;
  /** 注册来源（core / role:<id> / extension:<id> / api——审计用） */
  registeredBy?: string;
}

export type ValidateResult = { ok: true } | { ok: false; unknown: string[] };
export type RouteRoleResult = { ok: true; role: string | null } | { ok: false; conflict: string[] };

export class TagRegistry {
  private readonly tags = new Map<string, TagDef>();

  /** 注册标签（幂等——同义重复跳过；同名不同义冲突抛错） */
  register(def: TagDef): void {
    const name = def.name.toLowerCase();
    if (def.kind === "role" && !def.role) {
      throw new Error(`tag "${name}": role 类标签必须声明 role（路由目标）`);
    }
    const existing = this.tags.get(name);
    if (existing) {
      if (existing.kind === def.kind && existing.role === def.role) return; // 幂等
      throw new Error(
        `tag "${name}" 注册冲突：已注册为 ${existing.kind}${existing.role ? `(${existing.role})` : ""}，` +
          `本次为 ${def.kind}${def.role ? `(${def.role})` : ""}`,
      );
    }
    this.tags.set(name, { ...def, name });
  }

  get(name: string): TagDef | undefined {
    return this.tags.get(name.toLowerCase());
  }

  /** 提交校验：全部已注册 → ok；否则列出未知标签（调用方 400） */
  validate(tags: string[]): ValidateResult {
    const unknown = tags.filter((t) => !this.tags.has(t.toLowerCase()));
    return unknown.length > 0 ? { ok: false, unknown } : { ok: true };
  }

  /**
   * 角色路由（分选器唯一标准——精确匹配）：
   *   命中唯一角色 → { ok, role }；无 role 标签 → { ok, role: null }（调用方兜底/拒绝）；
   *   命中多个不同角色 → { ok: false, conflict }（歧义——调用方 400）。
   */
  routeRole(tags: string[]): RouteRoleResult {
    const roles = new Set<string>();
    for (const t of tags) {
      const def = this.tags.get(t.toLowerCase());
      if (def?.kind === "role" && def.role) roles.add(def.role);
    }
    if (roles.size > 1) return { ok: false, conflict: [...roles] };
    return { ok: true, role: roles.size === 1 ? [...roles][0]! : null };
  }

  list(): TagDef[] {
    return [...this.tags.values()];
  }

  /** 角色的代表标签（内部发布者把 role 翻译成合法标签用——注册顺序首个） */
  primaryTagOfRole(role: string): string | undefined {
    return this.list().find((d) => d.kind === "role" && d.role === role)?.name;
  }
}

/** 全局单例（worker-cluster 角色注册自动挂载；测试可自建实例隔离） */
export const tagRegistry = new TagRegistry();
