/**
 * agent-engine-recovery.ts —— 崩溃恢复（模块专项 ② 大文件拆分：自 agent-engine.ts 抽出）。
 */
import {
  createSession as sdkCreateSession,
  SessionManager,
  DefaultResourceLoader,
  type PlatformAgentSession,
} from "@away_from/infra";
import type { SessionPool, PoolSession } from "./session-pool.js";
import type { ModelRouter, Logger } from "@away_from/infra";
import type { ToolPlatform } from "../tools/index.js";
import type { AuditWriter } from "../observability/index.js";
import type { ManagedSessionInfo, Result } from "./types.js";
import fs from "node:fs";

export interface AgentEngineRecoveryHost {
  logger: Logger;
  pool: SessionPool;
  agentSessions: Map<string, PlatformAgentSession>;
  sessionManagers: Map<string, SessionManager>;
  audit?: AuditWriter;
  modelRouter: ModelRouter;
  toolPlatform: ToolPlatform;
  buildSystemSession(opts: {
    sessionId: string;
    sessionDir: string;
    cwd: string;
    sessionManager: SessionManager;
  }): Promise<Result<ManagedSessionInfo>>;
  getOverlayPaths(): { skills: string[]; prompts: string[] };
  getAgentDir(): string;
  buildCustomTools(tenantId: string): any[];
  reviveSessionManager(meta: PoolSession): SessionManager;
}

  export async function recoverEngineSessions(engine: AgentEngineRecoveryHost): Promise<void> {
    engine.logger.info({ event: "recovery_start" });
    // 竞态防护（二轮评审 Important 1）：main.ts 已先 `await engine.recoverAll()` 后 server.listen
    // （main.ts:77 先于 :85）——恢复完成前无外部请求可达，Redis Epoch（INCR pool:epoch）判定
    // 冗余，不实现（裁决记录：若未来恢复与 listen 并发化，须补 Epoch+恢复期间新请求拒绝）。
    const metas = await engine.pool.loadAllFromRedis();
    // F/WP5 Task 23：常驻系统会话（reserved）优先恢复——watchdog 依赖系统会话尽早就位
    metas.sort((a, b) => Number(b.reserved ?? false) - Number(a.reserved ?? false));
    let recovered = 0;
    let failed = 0;
    for (const meta of metas) {
      if (engine.pool.get(meta.sessionId)) {
        engine.logger.debug({ sessionId: meta.sessionId, event: "recovery_skip_in_memory" });
        continue;
      }
      try {
        const sessionManager = reviveSessionManager(engine, meta);
        // 恢复校验：buildSessionContext().messages.length vs meta.entryCount（不一致记 warn 不阻断——S1）
        const messageCount = sessionManager.buildSessionContext().messages.length;
        if (meta.entryCount > 0 && messageCount !== meta.entryCount) {
          engine.logger.warn({
            sessionId: meta.sessionId,
            expected: meta.entryCount,
            actual: messageCount,
            event: "recovery_entry_count_mismatch",
          });
        }
        if (meta.reserved) {
          // F/WP5 Task 23：常驻系统会话走专用构建路径（RESERVED 标记 + watchdog 关联 + 后续扩展接线）
          const res = await engine.buildSystemSession({
            sessionId: meta.sessionId,
            sessionDir: meta.sessionDir,
            cwd: meta.cwd,
            sessionManager,
          });
          if (!res.ok) throw new Error(res.error);
          // 恢复标记：与常规恢复路径一致的清理语义（refCount 归零已由新建保证；busy→interrupted）
          const restored = engine.pool.get(meta.sessionId);
          if (restored) {
            restored.recoveredFromCrash = true;
            restored.interrupted = meta.state === "busy";
          }
          engine.logger.info({ sessionId: meta.sessionId, event: "system_session_recovered" });
        } else {
          // S1：恢复实例直接传 createAgentSession({sessionManager})
          // 评审修复（WP2-R1）：恢复路径必须重建与 createSession 一致的安全/配置姿态——
          // 租户工具白名单（tools/customTools）+ credentialed modelRuntime，否则工具治理绕过+认证脱节。
          // F/WP2 Task 8：恢复会话同样注入已验证的 L1 覆盖层（platform 卷 skills/prompts）。
          const overlayPaths = engine.getOverlayPaths();
          const recoveryOptions: Record<string, unknown> = {};
          if (overlayPaths.skills.length > 0 || overlayPaths.prompts.length > 0) {
            const resourceLoader = new DefaultResourceLoader({
              cwd: meta.cwd,
              agentDir: engine.getAgentDir(),
              additionalSkillPaths: overlayPaths.skills.length > 0 ? overlayPaths.skills : undefined,
              additionalPromptTemplatePaths: overlayPaths.prompts.length > 0 ? overlayPaths.prompts : undefined,
            });
            // S3 缺口 1：自建 loader 必须显式 reload（否则扩展加载数为 0）
            await resourceLoader.reload();
            recoveryOptions.resourceLoader = resourceLoader;
          }
          const { session } = await sdkCreateSession({
            cwd: meta.cwd,
            sessionManager,
            model: engine.modelRouter.resolve(undefined, meta.model),
            modelRuntime: engine.modelRouter.getRuntime(),
            // thinkingLevel 不入池元（非安全关键——推理深度非治理面）；恢复用默认 medium
            thinkingLevel: "medium",
            tools: engine.toolPlatform.getAllowedTools(meta.tenantId),
            customTools: engine.buildCustomTools(meta.tenantId),
            ...recoveryOptions,
          });
          engine.agentSessions.set(meta.sessionId, session);
          engine.sessionManagers.set(meta.sessionId, sessionManager);
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
          engine.pool.add(restored);
        }
        if (meta.state === "busy") {
          engine.logger.warn({ sessionId: meta.sessionId, event: "recovery_interrupted_dispatch_dropped" });
          await engine.audit?.write({
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
        engine.logger.error({ sessionId: meta.sessionId, err: reason, event: "recovery_failed" });
        await engine.pool.markUnrecoverable(meta.sessionId, reason);
        await engine.audit?.write({
          tenantId: meta.tenantId,
          actor: "system",
          action: "recovery_unrecoverable",
          details: { sessionId: meta.sessionId, reason },
        });
      }
    }
    engine.logger.info({ event: "recovery_complete", recovered, failed });
  }

  /**
   * 恢复 SDK SessionManager（S1：continueRecent 精确恢复）。
   * 会话目录无 .jsonl = 懒落盘窗口（纯 user 消息未写盘/从未 prompt）——以 PTH sessionId 重建空会话，
   * 该轮内容按 S1 接受丢失；有文件但 session id 不匹配 → 抛错（unrecoverable）。
   */
export function reviveSessionManager(engine: AgentEngineRecoveryHost, meta: PoolSession): SessionManager {
  let hasFile = false;
    try {
      hasFile = fs.readdirSync(meta.sessionDir).some((f) => f.endsWith(".jsonl"));
    } catch {
      hasFile = false;
    }
    if (!hasFile) {
      engine.logger.warn({
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

