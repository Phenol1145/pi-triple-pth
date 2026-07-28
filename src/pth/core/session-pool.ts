import type { Logger } from "../../shared/observability/logger.js";
import type { Metrics } from "../observability/metrics.js";
import type { SessionStore } from "../storage/interfaces.js";
import type { VersionSnapshot } from "./types.js";

export interface PoolSession {
  sessionId: string;
  tenantId: string;
  project: string;
  state: "idle" | "busy" | "evicting";
  refCount: number;
  lastAccess: number;
  lastCheckpointSeq: number;
  versionSnapshot: VersionSnapshot | null;
  model: string;
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
  private recoverableIndex = new Map<string, { tenantId: string; sessionId: string }>();

  constructor(
    private config: SessionPoolConfig = DEFAULT_CONFIG,
    private sessionStore: SessionStore,
    private logger: Logger,
    private metrics: Metrics,
  ) {}

  get size(): number {
    return this.sessions.size;
  }

  get(sessionId: string): PoolSession | undefined {
    return this.sessions.get(sessionId);
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
    this.metrics.sessionsActive.set(this.sessions.size);
  }

  remove(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.metrics.sessionsActive.set(this.sessions.size);
  }

  markBusy(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) { s.state = "busy"; s.refCount++; }
  }

  markIdle(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.refCount = Math.max(0, s.refCount - 1);
      if (s.refCount === 0) s.state = "idle";
      s.lastAccess = Date.now();
    }
  }

  evictLRU(): string | null {
    const evictable = [...this.sessions.values()]
      .filter((s) => s.state === "idle")
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

  addRecoverable(tenantId: string, sessionId: string): void {
    this.recoverableIndex.set(sessionId, { tenantId, sessionId });
  }

  getRecoverable(sessionId: string) {
    return this.recoverableIndex.get(sessionId);
  }

  clearRecoverable(sessionId: string): void {
    this.recoverableIndex.delete(sessionId);
  }
}
