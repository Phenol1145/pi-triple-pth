import {
  createSession as sdkCreateSession,
  SessionManager,
  SDK_EVENTS,
  DefaultResourceLoader,
  type PlatformAgentSession,
} from "../../shared/sdk-adapter/index.js";
import type { SessionPool, PoolSession } from "./session-pool.js";
import type { ModelRouter } from "../../shared/model-router/router.js";
import type { WorkspaceManager } from "../../shared/workspace/manager.js";
import type { SessionStore } from "../storage/interfaces.js";
import type { ToolPlatform } from "../tools/platform.js";
import type { AuditWriter } from "../observability/audit.js";
import type { Logger } from "../../shared/observability/logger.js";
import type { Metrics } from "../observability/metrics.js";
import type { AgentEvent, CreateSessionOpts, ManagedSessionInfo, Result, VersionSnapshot } from "./types.js";
import type { SandboxBashDefinition } from "../tools/sandbox-bash.js";
import { createBridge } from "./async-iterable-bridge.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * L1 热更注入源（F/WP2 Task 8）：提供已验证的 platform 卷覆盖层路径。
 * 后续会话的 ResourceLoader 以 agent-dir 卷为基准、platform 卷为覆盖层。
 */
export interface ResourceOverlayProvider {
  getOverlayPaths(): { skills: string[]; prompts: string[] };
}

export class AgentEngine {
  private agentSessions = new Map<string, PlatformAgentSession>();
  /**
   * SDK SessionManager 引用（对话唯一事实源）。SDK 会话按会话目录持久化 JSONL；
   * 本 map 供 checkpoint 记录 entryCount 与 recoverAll 校验/续用。
   */
  private sessionManagers = new Map<string, SessionManager>();
  /** Run workspace dirs for program sessions: sessionId → cwd (for cleanup) */
  private programRunDirs = new Map<string, string>();
  /** Timeout timers for program sessions */
  private programTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private pool: SessionPool,
    private modelRouter: ModelRouter,
    private workspaceMgr: WorkspaceManager,
    private sessionStore: SessionStore,
    private toolPlatform: ToolPlatform,
    private logger: Logger,
    private metrics: Metrics,
    /**
     * 会话持久化根目录（sessions 卷）。路径推导遵循 DATA_DIR 模式：
     * compose 注入 DATA_DIR=/data → /data/sessions；本机开发默认 <DATA_DIR>/sessions。
     * S1：必须显式传 sessionDir 给 SessionManager.create——SDK 默认落 ~/.pi/agent/sessions/ 不可控。
     */
    private sessionsDir: string = path.join(process.env.DATA_DIR ?? "./.pi-platform-data", "sessions"),
    /** 审计（恢复/清理事件）。可选——不传时恢复仅记日志 */
    private audit?: AuditWriter,
    /** L1 热更覆盖层（F/WP2 Task 8）。可选——不传时后续会话不注入 platform 卷 */
    private overlayProvider?: ResourceOverlayProvider,
    /**
     * 平台级 sandbox bash 工具定义（F/WP3 Task 11）：替换内建 bash。S2 硬约束：仅 customTools
     * 同名注册（禁用 excludeTools+同名）；由 main.ts 构造（含转发客户端），engine 仅合并。
     * 可选——不传时保持 SDK 内建 bash（本机开发/未接线场景）。
     */
    private sandboxBash?: SandboxBashDefinition,
  ) {}

  async createSession(opts: CreateSessionOpts): Promise<Result<ManagedSessionInfo>> {
    const check = this.pool.canCreate(opts.tenantId);
    if (!check.ok) return { ok: false, error: check.reason! };

    const sessionId = crypto.randomUUID();

    // ── 会话目录：<sessionsDir>/<tenantId>/<sessionId>/（S1：显式 sessionDir 按租户组织+可控清理）──
    const sessionDir = path.join(this.sessionsDir, opts.tenantId, sessionId);

    // ── Program session: run workspace + resource loader ────────────
    let cwd: string;
    let sdkOptions: Record<string, unknown> = {};

    if (opts.program) {
      const prog = opts.program;
      // Create run cwd: <workspace>/<tenant>/program-run-<sessionId>（路径推导走 manager 单点——F/WP2 Task 7）
      cwd = await this.workspaceMgr.ensureProgramRunWorkspace(opts.tenantId, sessionId);
      this.programRunDirs.set(sessionId, cwd);

      // Materialize program files into run cwd
      const skillsAbs: string[] = [];
      if (prog.skills && prog.skills.length > 0) {
        for (const skillRel of prog.skills) {
          const src = path.join(prog.root, skillRel);
          const destName = path.basename(skillRel);
          const dest = path.join(cwd, destName);
          if (fs.existsSync(src)) {
            fs.cpSync(src, dest, { recursive: true });
            skillsAbs.push(dest);
          }
        }
      }

      // Read system prompt content
      const appendSystemPrompt: string[] = [];
      if (prog.systemPrompt) {
        const promptPath = path.join(prog.root, prog.systemPrompt);
        if (fs.existsSync(promptPath)) {
          appendSystemPrompt.push(fs.readFileSync(promptPath, "utf-8"));
        }
      }

      // Build resource loader（F/WP2 Task 8 L1 注入：agent-dir 卷为基准，platform 卷已验证文件为覆盖层）
      // 对称性说明（评审 WP2-R2 Important#3）：program 路径无条件构造显式 loader（与常规/recoverAll 的
      // "仅在有覆盖层时接线"不对称——功能等价：空覆盖层下显式 loader 与 SDK 默认等价），noContextFiles 需保留。
      const overlayPaths = this.getOverlayPaths();
      const additionalSkillPaths = [...overlayPaths.skills, ...skillsAbs];
      const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir: this.getAgentDir(),
        additionalSkillPaths: additionalSkillPaths.length > 0 ? additionalSkillPaths : undefined,
        additionalPromptTemplatePaths: overlayPaths.prompts.length > 0 ? overlayPaths.prompts : undefined,
        appendSystemPrompt: appendSystemPrompt.length > 0 ? appendSystemPrompt : undefined,
        noContextFiles: true, // prevent ancestor AGENTS.md leak
      });
      sdkOptions.resourceLoader = resourceLoader;

      // Effective tools = program tools ∩ tenant allowed
      const effectiveTools = this.toolPlatform.getEffectiveTools(opts.tenantId, prog.tools);
      sdkOptions.tools = effectiveTools;
      if (prog.excludeTools && prog.excludeTools.length > 0) {
        sdkOptions.excludeTools = prog.excludeTools;
      }

      // Setup timeout timer
      if (prog.timeoutSec && prog.timeoutSec > 0) {
        const ms = Math.min(prog.timeoutSec, 3600) * 1000;
        const timer = setTimeout(() => {
          this.abort(sessionId, opts.tenantId).catch(() => {});
          this.logger.warn({ sessionId, tenantId: opts.tenantId, timeoutSec: prog.timeoutSec, event: "program_timeout_abort" });
        }, ms);
        this.programTimeouts.set(sessionId, timer);
      }
    } else {
      cwd = await this.workspaceMgr.ensureWorkspace(opts.tenantId, opts.project);
      // L1 注入（F/WP2 Task 8）：有已验证覆盖层时为常规会话显式接线 ResourceLoader
      //（agent-dir 卷为基准，platform 卷为覆盖层）；无覆盖层时保持 SDK 默认行为。
      const overlayPaths = this.getOverlayPaths();
      if (overlayPaths.skills.length > 0 || overlayPaths.prompts.length > 0) {
        sdkOptions.resourceLoader = new DefaultResourceLoader({
          cwd,
          agentDir: this.getAgentDir(),
          additionalSkillPaths: overlayPaths.skills.length > 0 ? overlayPaths.skills : undefined,
          additionalPromptTemplatePaths: overlayPaths.prompts.length > 0 ? overlayPaths.prompts : undefined,
        });
      }
    }

    const model = this.modelRouter.resolve(opts.provider, opts.model);

    // 懒落盘认知（S1）：SDK 会话首个 assistant message 才写盘——纯 user 消息窗口内
    // pool meta（entryCount）与磁盘 JSONL 不一致，以已落盘为准/接受该窗口；
    // 崩溃时该轮未落盘对话内容丢失（recoverAll 以 messages.length vs entryCount 记 warn 不阻断）。
    // 传 { id: sessionId }：让 JSONL 文件名与 header.id 携带 PTH sessionId，恢复时可按 id 精确校验。
    const sessionManager = SessionManager.create(cwd, sessionDir, { id: sessionId });
    const { session } = await sdkCreateSession({
      cwd,
      model,
      thinkingLevel: (opts.thinkingLevel as any) ?? "medium",
      modelRuntime: this.modelRouter.getRuntime(),
      sessionManager,
      tools: this.toolPlatform.getAllowedTools(opts.tenantId),
      customTools: this.buildCustomTools(opts.tenantId),
      ...sdkOptions,
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
      entryCount: 0,
      sessionDir,
      cwd,
      createdAt: now,
      recoveredFromCrash: false,
      interrupted: false,
      versionSnapshot: initialSnapshot,
      model: model?.id ?? "unknown",
    };

    this.pool.add(poolSession);
    this.agentSessions.set(sessionId, session);
    this.sessionManagers.set(sessionId, sessionManager);

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
    this.sessionManagers.delete(sessionId);
    this.pool.remove(sessionId);
    // Clean up program run workspace
    const runDir = this.programRunDirs.get(sessionId);
    if (runDir) {
      this.programRunDirs.delete(sessionId);
      fs.rm(runDir, { recursive: true, force: true }, () => {});
    }
    const timer = this.programTimeouts.get(sessionId);
    if (timer) { clearTimeout(timer); this.programTimeouts.delete(sessionId); }
  }

  getPool(): SessionPool { return this.pool; }

  async destroySession(sessionId: string, tenantId: string): Promise<void> {
    const managed = this.pool.get(sessionId);
    if (!managed || managed.tenantId !== tenantId) return;
    const session = this.agentSessions.get(sessionId);
    if (session) session.dispose();
    this.agentSessions.delete(sessionId);
    this.sessionManagers.delete(sessionId);
    this.pool.remove(sessionId);
    await this.sessionStore.deleteSession(tenantId, sessionId);
    // Clean up program run workspace
    const runDir = this.programRunDirs.get(sessionId);
    if (runDir) {
      this.programRunDirs.delete(sessionId);
      await fs.promises.rm(runDir, { recursive: true, force: true });
    }
    // F/WP2 Task 7 清理策略：sessions 卷目录随 destroy 清理（evict 保留——可恢复）
    if (managed.sessionDir) {
      await fs.promises.rm(managed.sessionDir, { recursive: true, force: true });
    }
    const timer = this.programTimeouts.get(sessionId);
    if (timer) { clearTimeout(timer); this.programTimeouts.delete(sessionId); }
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
    // 竞态防护（二轮评审 Important 1）：main.ts 已先 `await engine.recoverAll()` 后 server.listen
    // （main.ts:77 先于 :85）——恢复完成前无外部请求可达，Redis Epoch（INCR pool:epoch）判定
    // 冗余，不实现（裁决记录：若未来恢复与 listen 并发化，须补 Epoch+恢复期间新请求拒绝）。
    const metas = await this.pool.loadAllFromRedis();
    let recovered = 0;
    let failed = 0;
    for (const meta of metas) {
      if (this.pool.get(meta.sessionId)) {
        this.logger.debug({ sessionId: meta.sessionId, event: "recovery_skip_in_memory" });
        continue;
      }
      try {
        const sessionManager = this.reviveSessionManager(meta);
        // 恢复校验：buildSessionContext().messages.length vs meta.entryCount（不一致记 warn 不阻断——S1）
        const messageCount = sessionManager.buildSessionContext().messages.length;
        if (meta.entryCount > 0 && messageCount !== meta.entryCount) {
          this.logger.warn({
            sessionId: meta.sessionId,
            expected: meta.entryCount,
            actual: messageCount,
            event: "recovery_entry_count_mismatch",
          });
        }
        // S1：恢复实例直接传 createAgentSession({sessionManager})
        // 评审修复（WP2-R1）：恢复路径必须重建与 createSession 一致的安全/配置姿态——
        // 租户工具白名单（tools/customTools）+ credentialed modelRuntime，否则工具治理绕过+认证脱节。
        // F/WP2 Task 8：恢复会话同样注入已验证的 L1 覆盖层（platform 卷 skills/prompts）。
        const overlayPaths = this.getOverlayPaths();
        const recoveryOptions: Record<string, unknown> = {};
        if (overlayPaths.skills.length > 0 || overlayPaths.prompts.length > 0) {
          recoveryOptions.resourceLoader = new DefaultResourceLoader({
            cwd: meta.cwd,
            agentDir: this.getAgentDir(),
            additionalSkillPaths: overlayPaths.skills.length > 0 ? overlayPaths.skills : undefined,
            additionalPromptTemplatePaths: overlayPaths.prompts.length > 0 ? overlayPaths.prompts : undefined,
          });
        }
        const { session } = await sdkCreateSession({
          cwd: meta.cwd,
          sessionManager,
          model: this.modelRouter.resolve(undefined, meta.model),
          modelRuntime: this.modelRouter.getRuntime(),
          // thinkingLevel 不入池元（非安全关键——推理深度非治理面）；恢复用默认 medium
          thinkingLevel: "medium",
          tools: this.toolPlatform.getAllowedTools(meta.tenantId),
          customTools: this.buildCustomTools(meta.tenantId),
          ...recoveryOptions,
        });
        this.agentSessions.set(meta.sessionId, session);
        this.sessionManagers.set(meta.sessionId, sessionManager);
        // 恢复清理（spec §3.1 第 5 条）：refCount 归零重计；原 busy → interrupted（in-flight
        // 未持久化已丢，pending dispatch 丢弃+审计标记不重放——平台无持久 pending 注册表，
        // workflow 层 BullMQ intent 与会话恢复解耦，锁过期重建由 workflow 侧处理）；stale busy→idle
        const restored: PoolSession = {
          ...meta,
          state: "idle",
          refCount: 0,
          lastAccess: Date.now(),
          recoveredFromCrash: true,
          interrupted: meta.state === "busy",
        };
        this.pool.add(restored);
        if (meta.state === "busy") {
          this.logger.warn({ sessionId: meta.sessionId, event: "recovery_interrupted_dispatch_dropped" });
          await this.audit?.write({
            tenantId: meta.tenantId,
            actor: "system",
            action: "recovery_interrupted",
            details: { sessionId: meta.sessionId, note: "busy session recovered as idle; in-flight dispatch dropped, not replayed" },
          });
        }
        recovered++;
      } catch (err) {
        failed++;
        const reason = err instanceof Error ? err.message : String(err);
        this.logger.error({ sessionId: meta.sessionId, err: reason, event: "recovery_failed" });
        await this.pool.markUnrecoverable(meta.sessionId, reason);
        await this.audit?.write({
          tenantId: meta.tenantId,
          actor: "system",
          action: "recovery_unrecoverable",
          details: { sessionId: meta.sessionId, reason },
        });
      }
    }
    this.logger.info({ event: "recovery_complete", recovered, failed });
  }

  /**
   * 恢复 SDK SessionManager（S1：continueRecent 精确恢复）。
   * 会话目录无 .jsonl = 懒落盘窗口（纯 user 消息未写盘/从未 prompt）——以 PTH sessionId 重建空会话，
   * 该轮内容按 S1 接受丢失；有文件但 session id 不匹配 → 抛错（unrecoverable）。
   */
  private reviveSessionManager(meta: PoolSession): SessionManager {
    let hasFile = false;
    try {
      hasFile = fs.readdirSync(meta.sessionDir).some((f) => f.endsWith(".jsonl"));
    } catch {
      hasFile = false;
    }
    if (!hasFile) {
      this.logger.warn({
        sessionId: meta.sessionId,
        event: "recovery_no_session_file",
        note: "lazy-persist window: session rebuilt empty (unflushed user turn accepted lost)",
      });
      return SessionManager.create(meta.cwd, meta.sessionDir, { id: meta.sessionId });
    }
    // 会话目录按会话隔离（每会话一目录），continueRecent 取目录内最近文件即目标会话
    const resumed = SessionManager.continueRecent(meta.cwd, meta.sessionDir);
    if (resumed.getSessionId() !== meta.sessionId) {
      throw new Error(`session file id mismatch (expected ${meta.sessionId}, got ${resumed.getSessionId()})`);
    }
    return resumed;
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
    this.sessionManagers.clear();
    this.logger.info({ event: "drain_complete" });
  }

  private async checkpoint(managed: PoolSession, seq: number): Promise<void> {
    managed.lastCheckpointSeq = seq;
    // S1：SDK 会话为对话唯一事实源——记录 message 条数供 recoverAll 恢复校验
    const sm = this.sessionManagers.get(managed.sessionId);
    if (sm) managed.entryCount = sm.buildSessionContext().messages.length;
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

  /**
   * customTools 合并（F/WP3 Task 11）：租户自定义工具 + 平台级 sandbox bash（后写覆盖——
   * S2 实证注册表后写覆盖；同名冲突时平台级生效）。createSession 与 recoverAll 共用，
   * 保证恢复路径工具姿态与创建路径一致（WP2-R1 评审修复延续）。
   */
  private buildCustomTools(tenantId: string): any[] {
    const tools = [...this.toolPlatform.getSdkToolDefinitions(tenantId)];
    if (this.sandboxBash) {
      tools.push(this.sandboxBash);
    }
    return tools;
  }

  /** agent-dir 卷（ResourceLoader 基准）：compose 注入 PI_CODING_AGENT_DIR=/data/agent-dir */
  private getAgentDir(): string {
    return process.env.PI_CODING_AGENT_DIR ?? path.join(process.env.HOME ?? "/", ".pi", "agent");
  }

  /** 已验证的 platform 卷覆盖层（F/WP2 Task 8 L1 注入）——空数组 = 未注入 */
  private getOverlayPaths(): { skills: string[]; prompts: string[] } {
    return this.overlayProvider?.getOverlayPaths() ?? { skills: [], prompts: [] };
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
