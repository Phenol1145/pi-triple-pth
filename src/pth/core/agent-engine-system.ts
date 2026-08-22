/**
 * agent-engine-system.ts —— 常驻系统会话构建（模块专项 ② 大文件拆分：自 agent-engine.ts 抽出）。
 */
import {
  createSession as sdkCreateSession,
  SessionManager,
  createEventBus,
  type EventBus,
  type PlatformAgentSession,
} from "@away_from/infra";
import { DefaultResourceLoader } from "@away_from/infra";
import { EXTERNAL_EVENT_CHANNEL, OBSERVE_EVENTS_REQUEST_CHANNEL, OBSERVE_EVENTS_RESPONSE_CHANNEL, COMPONENT_BOUND_CHANNEL, type ExternalWebhookEvent, type ComponentBoundEvent, type SystemEventFilter, type SystemEventEntry } from "./system-event-bus.js";
import crypto from "node:crypto";
import type { SessionPool, PoolSession } from "./session-pool.js";
import type { ModelRouter, WorkspaceManager, Logger } from "@away_from/infra";
import type { SessionStore } from "@away_from/pth-kernel-storage";
import type { ToolPlatform } from "../tools/index.js";
import type { ManagedSessionInfo, Result, VersionSnapshot } from "./types.js";
import type { InlineExtension } from "@away_from/infra";

export type SystemExtensionFactory = InlineExtension;
import fs from "node:fs";
import path from "node:path";

export interface AgentEngineSystemHost {
  prepareSystemEnv(sessionId: string): void;
  workspaceMgr: WorkspaceManager;
  sessionsDir: string;
  modelRouter: ModelRouter;
  systemEventBusOverride?: EventBus;
  systemEventBus: EventBus | null;
  getAgentDir(): string;
  systemExtensionFactories: SystemExtensionFactory[];
  toolPlatform: ToolPlatform;
  buildCustomTools(tenantId: string): any[];
  logger: Logger;
  pool: SessionPool;
  agentSessions: Map<string, PlatformAgentSession>;
  sessionManagers: Map<string, SessionManager>;
  systemSessionId: string | null;
  sessionStore: SessionStore;
  computeVersionSnapshot(): VersionSnapshot;
  toManagedInfo(s: PoolSession): ManagedSessionInfo;
}

export function prepareSystemEnvFor(host: { sessionsDir: string }, sessionId: string): void {
  const dataDir = path.dirname(host.sessionsDir);
  if (!process.env.AGENT_LAB_DB_PATH) process.env.AGENT_LAB_DB_PATH = path.join(dataDir, "agent-lab", "agent-lab.db");
  if (!process.env.AGENT_LAB_CONFIG_DIR) process.env.AGENT_LAB_CONFIG_DIR = path.join(dataDir, "agent-lab", "config");
  process.env.PI_AGENT_INSTANCE_ID = `system-${sessionId}`;
}

export async function buildSystemSessionFor(engine: AgentEngineSystemHost, opts?: {
  sessionId?: string;
  sessionDir?: string;
  cwd?: string;
  sessionManager?: SessionManager;
}): Promise<Result<ManagedSessionInfo>> {
    const sessionId = opts?.sessionId ?? crypto.randomUUID();
    try {
      // S3 缺口 5 env 契约：AGENT_LAB_DB_PATH/AGENT_LAB_CONFIG_DIR/PI_AGENT_INSTANCE_ID 在
      // createSession（loader reload → 扩展 load）前设 process.env——agent-lab load 期同步读取。
      // 协调者裁决：PTH 单实例内 agent-lab 配置路径全局唯一——设置后不恢复（避免每次会话创建改 env 的竞态）。
      engine.prepareSystemEnv(sessionId);
      const cwd = opts?.cwd ?? (await engine.workspaceMgr.ensureWorkspace("system", "system"));
      const sessionDir = opts?.sessionDir ?? path.join(engine.sessionsDir, "system", sessionId);
      fs.mkdirSync(sessionDir, { recursive: true });

      const model = engine.modelRouter.resolve(undefined, undefined);
      const sessionManager = opts?.sessionManager ?? SessionManager.create(cwd, sessionDir, { id: sessionId });

      // S3 缺口 4 + 路径 b：extensionFactories 编程注入 agent-lab + noExtensions:true（防用户 agentDir 扩展泄漏）。
      // 跨会话复用评估（S3 疑虑）：extensionFactories 每会话执行一次→DB 句柄叠加。常驻系统会话在 PTH
      // 单实例内唯一（RESERVED + watchdog 重建/recoverAll 恢复均重建——旧进程已退出，SQLite 句柄随进程释放），
      // 单实例下无叠加问题；若未来允许多常驻会话，须共享 loader/store（DB 句柄单例）。
      // F/WP5 Task 27：options.eventBus 注入自建总线 → 常驻会话内 agent-lab 的 pi.events === 此实例
      // （SDK 扩展 API events 即 loader 的共享 EventBus）——pth emit 外部事件、agent-lab on 订阅喂派发器。
      const systemEventBus = engine.systemEventBusOverride ?? createEventBus();
      engine.systemEventBus = systemEventBus;
      const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir: engine.getAgentDir(),
        noContextFiles: true, // 常驻会话不需要项目上下文文件（轻量状态化）
        noExtensions: true,
        eventBus: systemEventBus,
        extensionFactories: engine.systemExtensionFactories.length > 0 ? [...engine.systemExtensionFactories] : undefined,
      });
      // S3 缺口 1：自建 loader 必须显式 reload（sdk.js 仅在内部默认 loader 时代调 reload）——否则扩展加载数为 0
      await resourceLoader.reload();

      const { session } = await sdkCreateSession({
        cwd,
        model,
        thinkingLevel: "medium",
        modelRuntime: engine.modelRouter.getRuntime(),
        sessionManager,
        resourceLoader,
        tools: engine.toolPlatform.getAllowedTools("system"),
        customTools: engine.buildCustomTools("system"),
      });

      // S3 缺口 2：bindExtensions 绑定扩展运行时 + emit session_start（agent-lab 的 pi.on(session_start) 依赖）。
      // 参考 print-mode 的 bindExtensions 调用：mode + onError（无 UI——headless 常驻会话）。
      await session.bindExtensions({
        mode: "print",
        onError: (err) => engine.logger.warn({ sessionId, err: String(err), event: "system_extension_error" }),
      });

      const now = Date.now();
      const poolSession: PoolSession = {
        sessionId,
        tenantId: "system",
        project: "system",
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
        versionSnapshot: engine.computeVersionSnapshot(),
        model: model?.id ?? "unknown",
        reserved: true,
      };

      engine.pool.add(poolSession);
      engine.agentSessions.set(sessionId, session);
      engine.sessionManagers.set(sessionId, sessionManager);
      engine.systemSessionId = sessionId;

      await engine.sessionStore.saveMeta("system", sessionId, {
        version: 1,
        sessionId,
        tenantId: "system",
        project: "system",
        model: model?.id ?? "unknown",
        thinkingLevel: "medium",
        status: "active",
        entryCount: 0,
        lastEntrySeq: 0,
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
      });

      engine.logger.info({ sessionId, event: "system_session_created" });
      return { ok: true, data: engine.toManagedInfo(poolSession) };
    } catch (err) {
      engine.logger.error({ sessionId, err: err instanceof Error ? err.message : String(err), event: "system_session_create_failed" });
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

export type ObservePendingMap = Map<string, {
  resolve: (r: Result<SystemEventEntry[]>) => void;
  timer: ReturnType<typeof setTimeout>;
  off: () => void;
}>;

export interface AgentEngineEventHost {
  systemEventBus: EventBus | null;
  isSystemSessionAlive(): boolean;
  observePending: ObservePendingMap;
}

export function querySystemEventsVia(engine: AgentEngineEventHost, filter: SystemEventFilter, timeoutMs = 3000): Promise<Result<SystemEventEntry[]>> {
  const bus = engine.systemEventBus;
  if (!bus || !engine.isSystemSessionAlive()) {
    return Promise.resolve({ ok: false, error: "system session unavailable" });
  }
  const requestId = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const p = engine.observePending.get(requestId);
      if (p) {
        p.off();
        engine.observePending.delete(requestId);
        resolve({ ok: false, error: "observe events query timeout" });
      }
    }, timeoutMs);
    const off = bus.on(OBSERVE_EVENTS_RESPONSE_CHANNEL, (data) => {
      const d = data as { requestId?: string; events?: SystemEventEntry[]; error?: string } | undefined;
      if (!d || d.requestId !== requestId) return;
      clearTimeout(timer);
      engine.observePending.delete(requestId);
      if (d.error) resolve({ ok: false, error: d.error });
      else resolve({ ok: true, data: d.events ?? [] });
    });
    engine.observePending.set(requestId, { resolve, timer, off });
    bus.emit(OBSERVE_EVENTS_REQUEST_CHANNEL, { requestId, filter });
  });
}

export function emitExternalEventVia(engine: AgentEngineEventHost, evt: Omit<ExternalWebhookEvent, "receivedAt">): boolean {
  const bus = engine.systemEventBus;
  if (!bus || !engine.isSystemSessionAlive()) return false;
  bus.emit(EXTERNAL_EVENT_CHANNEL, { ...evt, receivedAt: Date.now() });
  return true;
}

export function emitComponentBoundVia(engine: AgentEngineEventHost, binding: ComponentBoundEvent): boolean {
  const bus = engine.systemEventBus;
  if (!bus || !engine.isSystemSessionAlive()) return false;
  bus.emit(COMPONENT_BOUND_CHANNEL, binding);
  return true;
}
