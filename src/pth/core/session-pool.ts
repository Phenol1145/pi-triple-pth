import type { Logger } from "@pi-triple/infra";
import type { Metrics } from "../observability/metrics.js";
import type { SessionStore } from "../storage/interfaces.js";
import type { VersionSnapshot } from "./types.js";
import type { Redis } from "ioredis";

export interface PoolSession {
  sessionId: string;
  tenantId: string;
  project: string;
  state: "idle" | "busy" | "evicting";
  refCount: number;
  lastAccess: number;
  /**
   * 平台侧 per-prompt 事件游标（最近一次 prompt 发出的事件数）。
   * S1：SDK 无 seq 概念（会话 entry 是 string id 树）——此字段与 SDK 条目序列无关，
   * 字段名保留但语义已变更为平台侧事件计数；对话内容以会话 JSONL 为唯一事实源。
   */
  lastCheckpointSeq: number;
  /** SDK 会话消息条数（buildSessionContext().messages.length）——recoverAll 恢复校验基准 */
  entryCount: number;
  /** 会话目录（绝对路径）：<sessionsDir>/<tenantId>/<sessionId>/（S1：显式 sessionDir 按租户组织） */
  sessionDir: string;
  /** 会话工作目录（recoverAll 时 continueRecent(cwd, sessionDir) 需要） */
  cwd: string;
  /** 会话创建时间戳（ms） */
  createdAt: number;
  /** 恢复标记：经 recoverAll 从崩溃现场恢复 */
  recoveredFromCrash: boolean;
  /** 恢复标记：恢复前处于 busy（in-flight 未持久化已丢，置 interrupted） */
  interrupted: boolean;
  versionSnapshot: VersionSnapshot | null;
  model: string;
  /** 常驻系统会话标记（F/WP5 Task 23）：evictLRU 豁免 + recoverAll 优先恢复。可选（默认 false——兼容既有构造点）。 */
  reserved?: boolean;
}

export interface SessionPoolConfig {
  maxSessions: number;
  maxSessionsPerTenant: number;
  idleTimeoutMs: number;
  onEvict?: (sessionId: string, tenantId: string) => void;
}

const DEFAULT_CONFIG: SessionPoolConfig = {
  maxSessions: 20,
  maxSessionsPerTenant: 5,
  idleTimeoutMs: 300_000,
};

export class SessionPool {
  private sessions = new Map<string, PoolSession>();
  /** 写直通进行中的 promise（flush() 等待；测试/drain 前调用） */
  private pendingWrites = new Set<Promise<unknown>>();

  constructor(
    private config: SessionPoolConfig = DEFAULT_CONFIG,
    private sessionStore: SessionStore,
    private logger: Logger,
    private metrics: Metrics,
    /**
     * Redis 实例（池元状态写直通/读穿透）。不注入时保持纯内存模式（老调用方/单测）；
     * 生产 main.ts 必传——pool:{sid}:meta 即恢复索引（recoverAll 直扫 pool:* 键）。
     */
    private redis?: Redis,
  ) {}

  private poolKey(sessionId: string): string {
    return `pool:${sessionId}:meta`;
  }

  /** PoolSession → Redis JSON。versionSnapshot 不落池元（版本快照另存 sessionStore.saveVersionSnapshot） */
  private toMeta(s: PoolSession): Record<string, unknown> {
    return {
      sessionId: s.sessionId,
      tenantId: s.tenantId,
      project: s.project,
      state: s.state,
      refCount: s.refCount,
      lastAccess: s.lastAccess,
      lastCheckpointSeq: s.lastCheckpointSeq,
      entryCount: s.entryCount,
      sessionDir: s.sessionDir,
      cwd: s.cwd,
      createdAt: s.createdAt,
      recoveredFromCrash: s.recoveredFromCrash,
      interrupted: s.interrupted,
      model: s.model,
      reserved: s.reserved ?? false,
    };
  }

  /** Redis 池元 JSON → PoolSession（内存缓存重建用） */
  private fromMeta(raw: Record<string, any>): PoolSession {
    return {
      sessionId: raw.sessionId,
      tenantId: raw.tenantId,
      project: raw.project ?? "",
      state: raw.state === "busy" ? "busy" : raw.state === "evicting" ? "evicting" : "idle",
      refCount: raw.refCount ?? 0,
      lastAccess: raw.lastAccess ?? Date.now(),
      lastCheckpointSeq: raw.lastCheckpointSeq ?? 0,
      entryCount: raw.entryCount ?? 0,
      sessionDir: raw.sessionDir ?? "",
      cwd: raw.cwd ?? "",
      createdAt: raw.createdAt ?? Date.now(),
      recoveredFromCrash: !!raw.recoveredFromCrash,
      interrupted: !!raw.interrupted,
      versionSnapshot: null,
      model: raw.model ?? "unknown",
      reserved: !!raw.reserved,
    };
  }

  /** 写直通（fire-and-forget，失败仅记日志——单键最终一致可接受） */
  private persist(s: PoolSession): void {
    if (!this.redis) return;
    const p = this.redis
      .set(this.poolKey(s.sessionId), JSON.stringify(this.toMeta(s)))
      .catch((err) => this.logger.warn({ sessionId: s.sessionId, err: String(err), event: "pool_meta_persist_failed" }));
    this.pendingWrites.add(p);
    void p.finally(() => this.pendingWrites.delete(p));
  }

  /** 等待全部写直通完成（测试断言与 drain 前调用） */
  async flush(): Promise<void> {
    if (this.pendingWrites.size === 0) return;
    await Promise.allSettled([...this.pendingWrites]);
  }

  get size(): number {
    return this.sessions.size;
  }

  /** 内存缓存读（进程内单写者，缓存即事实）。恢复期读穿透请用 getOrLoad/loadAllFromRedis */
  get(sessionId: string): PoolSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** 读穿透：缓存 miss 时从 Redis 单键重建并回填缓存 */
  async getOrLoad(sessionId: string): Promise<PoolSession | undefined> {
    const cached = this.sessions.get(sessionId);
    if (cached) return cached;
    if (!this.redis) return undefined;
    try {
      const raw = await this.redis.get(this.poolKey(sessionId));
      if (!raw) return undefined;
      const parsed = JSON.parse(raw) as Record<string, any>;
      if (parsed.unrecoverable) return undefined; // 死会话不进入内存池
      const meta = this.fromMeta(parsed);
      this.sessions.set(sessionId, meta);
      this.metrics.sessionsActive.set(this.sessions.size);
      return meta;
    } catch (err) {
      this.logger.warn({ sessionId, err: String(err), event: "pool_meta_read_failed" });
      return undefined;
    }
  }

  /**
   * 从 Redis 重建池视图（进程重启后恢复入口）。仅读取返回，不写入内存缓存——
   * recoverAll 逐会话 revive 后经 add() 回填；死会话（unrecoverable）跳过。
   */
  async loadAllFromRedis(): Promise<PoolSession[]> {
    if (!this.redis) return [];
    const keys = await this.redis.keys("pool:*:meta");
    const metas: PoolSession[] = [];
    for (const key of keys) {
      const sessionId = key.slice("pool:".length, -":meta".length);
      try {
        const raw = await this.redis.get(key);
        if (!raw) continue;
        const parsed = JSON.parse(raw) as Record<string, any>;
        if (parsed.unrecoverable) continue;
        metas.push(this.fromMeta(parsed));
      } catch (err) {
        this.logger.warn({ key, err: String(err), event: "pool_meta_parse_failed" });
      }
    }
    return metas;
  }

  /**
   * 标记会话不可恢复（写回 Redis meta，含原因）。recoverAll 失败路径用——
   * 死会话不再进入内存池，后续直扫时跳过，避免反复失败。
   */
  async markUnrecoverable(sessionId: string, reason: string): Promise<void> {
    if (!this.redis) return;
    try {
      const raw = await this.redis.get(this.poolKey(sessionId));
      if (!raw) return;
      const meta = JSON.parse(raw) as Record<string, any>;
      meta.unrecoverable = true;
      meta.unrecoverableReason = reason;
      await this.redis.set(this.poolKey(sessionId), JSON.stringify(meta));
    } catch (err) {
      this.logger.warn({ sessionId, err: String(err), event: "pool_meta_mark_unrecoverable_failed" });
    }
  }

  canCreate(tenantId: string): { ok: boolean; reason?: string } {
    const tenantCount = [...this.sessions.values()].filter((s) => s.tenantId === tenantId).length;
    if (tenantCount >= this.config.maxSessionsPerTenant) {
      return { ok: false, reason: `Tenant limit (${this.config.maxSessionsPerTenant}) reached` };
    }
    if (this.sessions.size >= this.config.maxSessions) {
      const evicted = this.evictLRU();
      if (!evicted) {
        return { ok: false, reason: `Global limit (${this.config.maxSessions}) reached, all sessions busy` };
      }
    }
    return { ok: true };
  }

  add(session: PoolSession): void {
    this.sessions.set(session.sessionId, session);
    this.persist(session);
    this.metrics.sessionsActive.set(this.sessions.size);
  }

  remove(sessionId: string): void {
    this.sessions.delete(sessionId);
    if (this.redis) {
      const p = this.redis
        .del(this.poolKey(sessionId))
        .catch((err) => this.logger.warn({ sessionId, err: String(err), event: "pool_meta_delete_failed" }));
      this.pendingWrites.add(p);
      void p.finally(() => this.pendingWrites.delete(p));
    }
    this.metrics.sessionsActive.set(this.sessions.size);
  }

  markBusy(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) { s.state = "busy"; s.refCount++; this.persist(s); }
  }

  markIdle(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.refCount = Math.max(0, s.refCount - 1);
      if (s.refCount === 0) s.state = "idle";
      s.lastAccess = Date.now();
      this.persist(s);
    }
  }

  evictLRU(): string | null {
    // F/WP5 Task 23：RESERVED 常驻会话豁免驱逐（system-governor 雏形）
    const evictable = [...this.sessions.values()]
      .filter((s) => s.state === "idle" && !s.reserved)
      .sort((a, b) => a.lastAccess - b.lastAccess);
    if (evictable.length === 0) return null;
    const victim = evictable[0];
    this.logger.info({ sessionId: victim.sessionId, event: "session_evicted" });
    if (this.config.onEvict) this.config.onEvict(victim.sessionId, victim.tenantId);
    this.remove(victim.sessionId);
    return victim.sessionId;
  }

  setOnEvict(fn: (sessionId: string, tenantId: string) => void): void {
    this.config.onEvict = fn;
  }

  listByTenant(tenantId: string): PoolSession[] {
    return [...this.sessions.values()].filter((s) => s.tenantId === tenantId);
  }

  listAll(): PoolSession[] {
    return [...this.sessions.values()];
  }

}
// recoverableIndex（原 session-pool.ts:32-33）裁决：**删除**。
// 理由：池元状态已双写 Redis pool:{sid}:meta——Redis 键本身就是持久、崩溃一致的恢复索引；
// 内存 recoverableIndex 进程崩溃即失，恢复价值为零。recoverAll 直扫 pool:* 键（本文件 loadAllFromRedis）。
// （该字段/方法此前已是死代码——除本类定义外无任何调用点。）
