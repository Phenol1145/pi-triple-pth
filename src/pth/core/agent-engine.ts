import {
  createSession as sdkCreateSession,
  SessionManager,
  SDK_EVENTS,
  DefaultResourceLoader,
  createEventBus,
  type EventBus,
  type InlineExtension,
  type PlatformAgentSession,
} from "@away_from/infra";
import { EXTERNAL_EVENT_CHANNEL, OBSERVE_EVENTS_REQUEST_CHANNEL, OBSERVE_EVENTS_RESPONSE_CHANNEL, COMPONENT_BOUND_CHANNEL, type ExternalWebhookEvent, type ComponentBoundEvent, type SystemEventFilter, type SystemEventEntry } from "./system-event-bus.js";
import type { SessionPool, PoolSession } from "./session-pool.js";
import type { ModelRouter, WorkspaceManager } from "@away_from/infra";
import type { SessionStore } from "../kernel/storage/session/interfaces.js";
import type { ToolPlatform } from "../tools/platform.js";
import type { AuditWriter } from "../observability/audit.js";
import type { Logger } from "@away_from/infra";
import type { Metrics } from "../observability/metrics.js";
import type { AgentEvent, CreateSessionOpts, ManagedSessionInfo, Result, VersionSnapshot } from "./types.js";
import { createEngineSession, destroyEngineSession, type AgentEngineSessionHost } from "./agent-engine-session.js";
import { recoverEngineSessions, type AgentEngineRecoveryHost } from "./agent-engine-recovery.js";
import { buildCustomToolsFor, agentDirOf, overlayPathsOf, versionSnapshotOf, listDirHashes, managedInfoOf, type AgentEngineAssetHost } from "./agent-engine-assets.js";
import { buildSystemSessionFor, prepareSystemEnvFor, querySystemEventsVia, emitExternalEventVia, emitComponentBoundVia, type AgentEngineSystemHost, type AgentEngineEventHost, type ObservePendingMap } from "./agent-engine-system.js";
import type { SandboxBashDefinition } from "../impls/kernels/index.js";
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

/**
 * 常驻系统会话的编程注入扩展（F/WP5 Task 24，S3 路径 b——extensionFactories）。
 * SDK InlineExtension = 裸 factory 或 {name, factory}；agent-lab 的 default export 是裸 factory（(pi)=>Promise<void>）。
 */
import type { SystemExtensionFactory } from "./agent-engine-system.js";
export type { SystemExtensionFactory } from "./agent-engine-system.js";

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
  /**
   * 常驻系统会话 id（F/WP5 Task 23，system-governor 雏形）。
   * RESERVED 标记 + evict 豁免 + recoverAll 优先恢复 + watchdog 崩溃重建。
   * 轻量状态化（二轮评审 Important 3）：常驻会话不持大状态——EventLog 查询按需、无大缓存。
   */
  private systemSessionId: string | null = null;
  /** watchdog 崩溃重建次数（审计） */
  private systemRebuildCount = 0;
  /** watchdog 定时器（unref——不阻止进程退出） */
  private systemWatchdogTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * 常驻会话共享事件总线（F/WP5 Task 27——webhook 外部事件转发通道）。
   * pth 主进程持有的 EventBus 实例即常驻会话 agent-lab 看到的 pi.events（见
   * buildSystemSession：传入 DefaultResourceLoader options.eventBus）——
   * 零引用转发闭环。每次构建生成新总线（旧总线随旧会话 GC，防 dispose 后
   * 残留处理器双投递）；测试可注入 override。
   */
  private systemEventBus: EventBus | null = null;

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
    /**
     * 常驻系统会话的编程注入扩展（F/WP5 Task 24，S3 路径 b——extensionFactories）。
     * 由 main.ts 动态 import agent-lab 的 default export（InlineExtension 裸 factory）后传入；
     * 测试注入 mock factory 保持 hermetic。可选——不传时常驻会话无扩展（仅 RESERVED 机制）。
     */
    private systemExtensionFactories: SystemExtensionFactory[] = [],
    /**
     * 常驻会话事件总线注入（F/WP5 Task 27）。测试注入 mock 总线断言转发；
     * 不传时常驻会话构建时自建（每构建新总线——防残留处理器双投递）。
     */
    private systemEventBusOverride?: EventBus,
  ) {}

  async createSession(opts: CreateSessionOpts): Promise<Result<ManagedSessionInfo>> {
    return createEngineSession(this as unknown as AgentEngineSessionHost, opts);
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
    const managed = this.pool.get(sessionId);
    // F/WP5 Task 23：RESERVED 常驻会话豁免驱逐（pool.evictLRU 已跳过，此处为显式调用的防御）
    if (managed?.reserved) {
      this.logger.info({ sessionId, event: "evict_skipped_reserved", note: "常驻系统会话豁免驱逐" });
      return;
    }
    const session = this.agentSessions.get(sessionId);
    // 先同步移除映射/池（evict 语义：canCreate 即刻可用），再异步 emit session_shutdown + dispose
    if (session) this.agentSessions.delete(sessionId);
    this.sessionManagers.delete(sessionId);
    this.pool.remove(sessionId);
    if (session) {
      // S3 缺口 3：dispose 前显式 emit session_shutdown（agent-lab 关 DB 防句柄泄漏）——失败仅记日志
      session.shutdown().catch((err) => this.logger.warn({ sessionId, err: String(err), event: "session_shutdown_failed" }));
    }
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

  // ── 常驻系统会话（F/WP5 Task 23，system-governor 雏形）─────────────────

  /**
   * 创建（或复用）常驻系统会话。
   * 幂等：已存在则返回现有会话（main 启动时序 recoverAll → createSystemSession 的安全网）。
   * 轻量状态化（二轮评审 Important 3）：常驻会话不持大状态——EventLog 查询按需、无大缓存。
   */
  async createSystemSession(): Promise<Result<ManagedSessionInfo>> {
    if (this.isSystemSessionAlive()) {
      const current = this.pool.get(this.systemSessionId!);
      return { ok: true, data: this.toManagedInfo(current!) };
    }
    return this.buildSystemSession();
  }

  /** 常驻会话 id（测试/观察用）。未创建/已崩溃返回 null。 */
  getSystemSessionId(): string | null {
    return this.systemSessionId;
  }

  /** watchdog 崩溃重建次数（审计/测试用） */
  getSystemRebuildCount(): number {
    return this.systemRebuildCount;
  }

  // ── 外部事件转发（F/WP5 Task 27——webhook 入口）───────────────────

  /**
   * 常驻会话共享事件总线实例（测试/诊断用）。未构建常驻会话时为 null。
   * 注意：每次常驻会话重建（watchdog/recoverAll）会生成新总线。
   */
  getSystemEventBus(): EventBus | null {
    return this.systemEventBus;
  }

  /** 待处理 observe RPC（requestId → 解析器；Task 28b——pth→常驻会话→DB 方向） */
  private observePending: ObservePendingMap = new Map();

  /**
   * 查询常驻会话内 EventLog（Task 28b——方向与 webhook 相反：pth 主进程 →
   * 常驻会话 → DB）。经 OBSERVE_EVENTS_* 通道 request/response RPC：带 requestId
   * 关联 + 超时兜底（默认 3s）。常驻会话不可用 → error；超时 → error。
   * 注意：pth 不直读 agent-lab DB——事件行经常驻会话透传（结构子集）。
   */
  async querySystemEvents(filter: SystemEventFilter, timeoutMs = 3000): Promise<Result<SystemEventEntry[]>> {
    return querySystemEventsVia(this as unknown as AgentEngineEventHost, filter, timeoutMs);
  }

  /**
   * 转发外部事件到常驻会话（pi.events emit——零引用通道）。
   * 常驻会话存活且总线就绪才转发；否则返回 false（调用方决策——webhook
   * 路由按 503 处理，审计仍先落）。返回是否成功投递。
   */
  emitExternalEvent(evt: Omit<ExternalWebhookEvent, "receivedAt">): boolean {
    return emitExternalEventVia(this as unknown as AgentEngineEventHost, evt);
  }

  /**
   * 通知常驻会话：scheduler/optimizer 构件空位绑定（Task 28c——Task 18 registry
   * 接线子项）。pth 经 COMPONENT_BOUND_CHANNEL 告知常驻会话 → agent-lab 注册进
   * 框架层 registry。返回是否成功投递。
   */
  emitComponentBound(binding: ComponentBoundEvent): boolean {
    return emitComponentBoundVia(this as unknown as AgentEngineEventHost, binding);
  }

  /**
   * 常驻会话 watchdog：周期 health 探测，崩溃（会话丢失/disposed）→ 自动重建。
   * unref 定时器——不阻止进程退出；重建次数写审计。
   */
  startSystemWatchdog(intervalMs = 60_000): void {
    if (this.systemWatchdogTimer) return;
    this.systemWatchdogTimer = setInterval(() => {
      void this.ensureSystemSessionAlive();
    }, intervalMs);
    this.systemWatchdogTimer.unref?.();
  }

  stopSystemWatchdog(): void {
    if (this.systemWatchdogTimer) {
      clearInterval(this.systemWatchdogTimer);
      this.systemWatchdogTimer = null;
    }
  }

  /**
   * 常驻会话 health 探测：缺席即自动重建。返回是否触发重建（测试/诊断用）。
   * 崩溃检测 = 进程内会话映射/池记录缺失（SDK 会话 dispose/丢失）。
   */
  async ensureSystemSessionAlive(): Promise<boolean> {
    if (this.isSystemSessionAlive()) return false;
    const previous = this.systemSessionId;
    this.systemSessionId = null;
    if (previous) this.systemRebuildCount++;
    const res = await this.createSystemSession();
    if (!res.ok) {
      this.logger.error({ previous, err: res.error, event: "system_session_rebuild_failed" });
      return false;
    }
    if (previous) {
      await this.audit?.write({
        tenantId: "system",
        actor: "system",
        action: "system_session_rebuilt",
        details: { previousSessionId: previous, rebuildCount: this.systemRebuildCount, newSessionId: res.data.sessionId },
      });
      this.logger.warn({ previous, newSessionId: res.data.sessionId, rebuildCount: this.systemRebuildCount, event: "system_session_rebuilt" });
    }
    return true;
  }

  /** 常驻会话存活判定：id 在池 + SDK 会话在内存映射（进程内单写者，内存即事实） */
  private isSystemSessionAlive(): boolean {
    return !!this.systemSessionId && !!this.pool.get(this.systemSessionId) && this.agentSessions.has(this.systemSessionId);
  }

  /**
   * 常驻系统会话核心构建（新建/recoverAll 恢复/watchdog 重建共用）。
   * tenantId="system" 专用（与租户会话隔离）；RESERVED 标记——池驱逐豁免。
   */
  private async buildSystemSession(opts?: {
    sessionId?: string;
    sessionDir?: string;
    cwd?: string;
    sessionManager?: SessionManager;
  }): Promise<Result<ManagedSessionInfo>> {
    return buildSystemSessionFor(this as unknown as AgentEngineSystemHost, opts);
  }


  /**
   * S3 缺口 5 env 契约（agent-lab 扩展加载）：AGENT_LAB_DB_PATH/AGENT_LAB_CONFIG_DIR/PI_AGENT_INSTANCE_ID
   * 在 createSession 前设 process.env（agent-lab load 期同步读取——config-io.ts:15-29）。
   * 协调者裁决：PTH 单实例内 agent-lab 配置路径全局唯一——设置后不恢复（每次会话创建改 env 的竞态风险更高）。
   */
  private prepareSystemEnv(sessionId: string): void {
    return prepareSystemEnvFor(this as unknown as AgentEngineSystemHost, sessionId);
  }

  private toManagedInfo(s: PoolSession): ManagedSessionInfo {
    return managedInfoOf(s);
  }

  async destroySession(sessionId: string, tenantId: string): Promise<void> {
    return destroyEngineSession(this as unknown as AgentEngineSessionHost, sessionId, tenantId);
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
    return recoverEngineSessions(this as unknown as AgentEngineRecoveryHost);
  }

  async drain(): Promise<void> {
    // F/WP5 Task 23：停机时停止 watchdog（避免 drain 后重建常驻会话）
    this.stopSystemWatchdog();
    this.logger.info({ event: "drain_start", activeSessions: this.pool.size });
    for (const session of this.pool.listAll()) {
      if (session.state === "busy") {
        await this.abort(session.sessionId, session.tenantId);
      }
      await this.checkpoint(session, session.lastCheckpointSeq);
      const agentSession = this.agentSessions.get(session.sessionId);
      if (agentSession) {
        // S3 缺口 3：dispose 前显式 emit session_shutdown（agent-lab 关 DB 防句柄泄漏——停机前必须完成）
        try {
          await agentSession.shutdown();
        } catch (err) {
          this.logger.warn({ sessionId: session.sessionId, err: String(err), event: "session_shutdown_failed" });
        }
      }
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

  /** customTools/覆盖层/版本快照实现已抽到 agent-engine-assets.ts（保持私有方法签名） */
  private buildCustomTools(tenantId: string): any[] {
    return buildCustomToolsFor(this as unknown as AgentEngineAssetHost, tenantId);
  }

  private getAgentDir(): string {
    return agentDirOf(this as unknown as AgentEngineAssetHost);
  }

  private getOverlayPaths(): { skills: string[]; prompts: string[] } {
    return overlayPathsOf(this as unknown as AgentEngineAssetHost);
  }

  private computeVersionSnapshot(): VersionSnapshot {
    return versionSnapshotOf(this as unknown as AgentEngineAssetHost);
  }

  private listDirHashes(dir: string): string[] {
    return listDirHashes(dir);
  }
}