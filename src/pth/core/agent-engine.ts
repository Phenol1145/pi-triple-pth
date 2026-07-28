import {
  createSession as sdkCreateSession,
  SessionManager,
  SDK_EVENTS,
  type PlatformAgentSession,
} from "../../shared/sdk-adapter/index.js";
import type { SessionPool, PoolSession } from "./session-pool.js";
import type { ModelRouter } from "../../shared/model-router/router.js";
import type { WorkspaceManager } from "../../shared/workspace/manager.js";
import type { SessionStore } from "../storage/interfaces.js";
import type { ToolPlatform } from "../tools/platform.js";
import type { Logger } from "../../shared/observability/logger.js";
import type { Metrics } from "../observability/metrics.js";
import type { AgentEvent, CreateSessionOpts, ManagedSessionInfo, Result, VersionSnapshot } from "./types.js";
import { createBridge } from "./async-iterable-bridge.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export class AgentEngine {
  private agentSessions = new Map<string, PlatformAgentSession>();

  constructor(
    private pool: SessionPool,
    private modelRouter: ModelRouter,
    private workspaceMgr: WorkspaceManager,
    private sessionStore: SessionStore,
    private toolPlatform: ToolPlatform,
    private logger: Logger,
    private metrics: Metrics,
  ) {}

  async createSession(opts: CreateSessionOpts): Promise<Result<ManagedSessionInfo>> {
    const check = this.pool.canCreate(opts.tenantId);
    if (!check.ok) return { ok: false, error: check.reason! };

    const sessionId = crypto.randomUUID();
    const cwd = await this.workspaceMgr.ensureWorkspace(opts.tenantId, opts.project);
    const model = this.modelRouter.resolve(opts.provider, opts.model);

    const { session } = await sdkCreateSession({
      cwd,
      model,
      thinkingLevel: (opts.thinkingLevel as any) ?? "medium",
      modelRuntime: this.modelRouter.getRuntime(),
      sessionManager: SessionManager.inMemory(cwd),
      tools: this.toolPlatform.getAllowedTools(opts.tenantId),
      customTools: this.toolPlatform.getSdkToolDefinitions(opts.tenantId),
    });

    const now = Date.now();
    const initialSnapshot = this.computeVersionSnapshot();
    const poolSession: PoolSession = {
      sessionId,
      tenantId: opts.tenantId,
      project: opts.project,
      state: "idle",
      refCount: 0,
      lastAccess: now,
      lastCheckpointSeq: 0,
      versionSnapshot: initialSnapshot,
      model: model?.id ?? "unknown",
    };

    this.pool.add(poolSession);
    this.agentSessions.set(sessionId, session);

    await this.sessionStore.saveMeta(opts.tenantId, sessionId, {
      version: 1,
      sessionId,
      tenantId: opts.tenantId,
      project: opts.project,
      model: model?.id ?? "unknown",
      thinkingLevel: opts.thinkingLevel ?? "medium",
      status: "active",
      entryCount: 0,
      lastEntrySeq: 0,
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    });

    this.logger.info({ sessionId, tenantId: opts.tenantId, event: "session_created" });

    return {
      ok: true,
      data: {
        sessionId,
        tenantId: opts.tenantId,
        project: opts.project,
        state: "idle",
        model: model?.id ?? "unknown",
        createdAt: new Date(now).toISOString(),
        lastAccess: new Date(now).toISOString(),
      },
    };
  }

  async *prompt(sessionId: string, tenantId: string, text: string): AsyncIterable<AgentEvent> {
    const managed = this.pool.get(sessionId);
    if (!managed) throw new Error(`Session not found: ${sessionId}`);
    if (managed.tenantId !== tenantId) throw new Error("Forbidden: tenant mismatch");
    if (managed.state === "busy") throw new Error("Session is busy");

    const session = this.agentSessions.get(sessionId);
    if (!session) throw new Error(`AgentSession not in memory: ${sessionId}`);

    this.pool.markBusy(sessionId);
    const timer = this.metrics.promptDuration.startTimer();
    let seq = 0;

    try {
      const bridge = createBridge<AgentEvent>({ maxQueueSize: 1000 });
      const { iterable, push, done, error } = bridge;

      const toolStartTimes = new Map<string, number>(); // toolCallId → start ms

      const unsubscribe = session.subscribe((event) => {
        seq++;
        push({
          seq,
          type: event.type,
          data: event as any,
          terminal: event.type === SDK_EVENTS.AGENT_END,
          timestamp: new Date().toISOString(),
        });

        // C8: Tool Platform governance — audit + metrics on tool start/end
        if (event.type === SDK_EVENTS.TOOL_EXECUTION_START) {
          const toolName = (event as any).toolName ?? "unknown";
          const toolCallId = (event as any).toolCallId ?? "";
          toolStartTimes.set(toolCallId, Date.now());
          this.toolPlatform.recordToolStart(tenantId, toolName, toolCallId);
        }
        if (event.type === SDK_EVENTS.TOOL_EXECUTION_END) {
          const toolName = (event as any).toolName ?? "unknown";
          const toolCallId = (event as any).toolCallId ?? "";
          const isError = (event as any).isError ?? false;
          const startMs = toolStartTimes.get(toolCallId) ?? Date.now();
          const durationMs = Date.now() - startMs;
          toolStartTimes.delete(toolCallId);
          this.toolPlatform.recordToolEnd(tenantId, toolName, toolCallId, durationMs, isError);
        }

        // C6: Extract token usage from AssistantMessage on message_end
        if (event.type === SDK_EVENTS.MESSAGE_END) {
          const message = (event as any).message;
          if (message?.usage && typeof message.usage.input === "number") {
            this.metrics.tokensTotal.inc({ tenant: tenantId, type: "input" }, message.usage.input);
            this.metrics.tokensTotal.inc({ tenant: tenantId, type: "output" }, message.usage.output);
          }
        }

        if (event.type === SDK_EVENTS.AGENT_END) done();
      });

      let watchdog = setTimeout(() => {
        error(new Error("Idle watchdog: no events for 120s"));
        unsubscribe();
      }, 120_000);

      const promptPromise = session.prompt(text).catch((err) => {
        error(err instanceof Error ? err : new Error(String(err)));
        unsubscribe();
        clearTimeout(watchdog);
      });

      try {
        for await (const event of iterable) {
          clearTimeout(watchdog);
          watchdog = setTimeout(() => {
            error(new Error("Idle watchdog: no events for 120s"));
            unsubscribe();
          }, 120_000);
          yield event;
          // Bridge overflow: consumer too slow
          if (bridge.isOverflowed()) {
            error(new Error("Bridge overflow: consumer too slow"));
            unsubscribe();
            break;
          }
        }
      } finally {
        clearTimeout(watchdog);
        unsubscribe();
      }

      // Wait for pi SDK prompt to fully resolve before releasing
      await promptPromise;
      await this.checkpoint(managed, seq);
    } finally {
      this.pool.markIdle(sessionId);
      timer();
    }
  }

  async abort(sessionId: string, tenantId: string): Promise<void> {
    const managed = this.pool.get(sessionId);
    if (!managed || managed.tenantId !== tenantId) throw new Error("Forbidden: tenant mismatch");
    const session = this.agentSessions.get(sessionId);
    if (session) await session.abort();
  }

  evictSession(sessionId: string): void {
    const session = this.agentSessions.get(sessionId);
    if (session) { session.dispose(); this.agentSessions.delete(sessionId); }
    this.pool.remove(sessionId);
  }

  getPool(): SessionPool { return this.pool; }

  async destroySession(sessionId: string, tenantId: string): Promise<void> {
    const managed = this.pool.get(sessionId);
    if (!managed || managed.tenantId !== tenantId) return;
    const session = this.agentSessions.get(sessionId);
    if (session) session.dispose();
    this.agentSessions.delete(sessionId);
    this.pool.remove(sessionId);
    await this.sessionStore.deleteSession(tenantId, sessionId);
  }

  listSessions(tenantId: string): ManagedSessionInfo[] {
    return this.pool.listByTenant(tenantId).map((s) => ({
      sessionId: s.sessionId,
      tenantId: s.tenantId,
      project: s.project,
      state: s.state,
      model: s.model ?? "unknown",
      createdAt: new Date(s.lastAccess).toISOString(),
      lastAccess: new Date(s.lastAccess).toISOString(),
    }));
  }

  async recoverAll(): Promise<void> {
    this.logger.info({ event: "recovery_start" });
    this.logger.info({ event: "recovery_complete" });
  }

  async drain(): Promise<void> {
    this.logger.info({ event: "drain_start", activeSessions: this.pool.size });
    for (const session of this.pool.listAll()) {
      if (session.state === "busy") {
        await this.abort(session.sessionId, session.tenantId);
      }
      await this.checkpoint(session, session.lastCheckpointSeq);
      const agentSession = this.agentSessions.get(session.sessionId);
      if (agentSession) agentSession.dispose();
    }
    this.agentSessions.clear();
    this.logger.info({ event: "drain_complete" });
  }

  private async checkpoint(managed: PoolSession, seq: number): Promise<void> {
    managed.lastCheckpointSeq = seq;
    // C9: turn-level version snapshot
    const snapshot = this.computeVersionSnapshot();
    managed.versionSnapshot = snapshot;
    // Persist to Redis (fire-and-forget for non-blocking)
    this.sessionStore.saveVersionSnapshot(managed.tenantId, managed.sessionId, {
      seq,
      skills: snapshot.skills,
      prompts: snapshot.prompts,
      tools: snapshot.tools,
      timestamp: snapshot.timestamp,
    }).catch((err) => {
      this.logger.warn({ sessionId: managed.sessionId, seq, err: String(err), event: "version_snapshot_save_failed" });
    });
    this.logger.debug({ sessionId: managed.sessionId, seq, event: "checkpoint" });
  }

  /** C9: Compute a version snapshot hash for turn-level tracking */
  private computeVersionSnapshot(): VersionSnapshot {
    const platformDir = this.workspaceMgr.getPlatformDir();
    const skillsDir = path.join(platformDir, "skills");
    const promptsDir = path.join(platformDir, "prompts");
    const toolsDir = path.join(platformDir, "tools");
    return {
      skills: this.listDirHashes(skillsDir),
      prompts: this.listDirHashes(promptsDir),
      tools: this.listDirHashes(toolsDir),
      timestamp: new Date().toISOString(),
    };
  }

  /** C9: List files in a directory, sorted, with hash. Returns ["file1:hash", ...] */
  private listDirHashes(dir: string): string[] {
    try {
      const files = fs.readdirSync(dir).sort();
      return files.map((f) => {
        try {
          const content = fs.readFileSync(path.join(dir, f), "utf-8");
          const h = crypto.createHash("sha256").update(content).digest("hex").slice(0, 12);
          return `${f}:${h}`;
        } catch {
          return f;
        }
      });
    } catch {
      return [];
    }
  }
}
