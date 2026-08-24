/**
 * agent-engine-session.ts —— 会话创建（模块专项 ② 大文件拆分：自 agent-engine.ts 抽出）。
 */
import {
  createSession as sdkCreateSession,
  SessionManager,
  DefaultResourceLoader,
  type PlatformAgentSession,
} from "@away_from/infra";
import type { SessionPool, PoolSession } from "./session-pool.js";
import type { ModelRouter, WorkspaceManager, Logger } from "@away_from/infra";
import type { SessionStore } from "@away_from/pth-kernel-storage";
import type { ToolPlatform } from "../tools/index.js";
import type { AuditWriter } from "../observability/index.js";
import type { CreateSessionOpts, ManagedSessionInfo, Result, VersionSnapshot } from "./types.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** createSession 依赖的宿主面（AgentEngine 以私有字段/方法满足） */
export interface AgentEngineSessionHost {
  pool: SessionPool;
  sessionsDir: string;
  workspaceMgr: WorkspaceManager;
  programRunDirs: Map<string, string>;
  programTimeouts: Map<string, ReturnType<typeof setTimeout>>;
  modelRouter: ModelRouter;
  toolPlatform: ToolPlatform;
  logger: Logger;
  agentSessions: Map<string, PlatformAgentSession>;
  sessionManagers: Map<string, SessionManager>;
  sessionStore: SessionStore;
  abort(sessionId: string, tenantId: string): Promise<void>;
  getOverlayPaths(): { skills: string[]; prompts: string[] };
  getAgentDir(): string;
  buildCustomTools(tenantId: string): any[];
  buildSessionBaseOpts(
    tenantId: string,
    opts: { cwd: string; model: ReturnType<ModelRouter["resolve"]>; thinkingLevel: string; sessionManager: SessionManager },
  ): Record<string, unknown>;
  computeVersionSnapshot(): VersionSnapshot;
}

export async function destroyEngineSession(engine: AgentEngineSessionHost, sessionId: string, tenantId: string): Promise<void> {
  const managed = engine.pool.get(sessionId);
  if (!managed || managed.tenantId !== tenantId) return;
  if (managed.reserved) {
    engine.logger.info({ sessionId, event: "destroy_skipped_reserved", note: "常驻系统会话不可销毁（watchdog 管理）" });
    return;
  }
  const session = engine.agentSessions.get(sessionId);
  if (session) {
    try {
      await session.shutdown();
    } catch (err) {
      engine.logger.warn({ sessionId, err: String(err), event: "session_shutdown_failed" });
    }
    engine.agentSessions.delete(sessionId);
  }
  engine.sessionManagers.delete(sessionId);
  engine.pool.remove(sessionId);
  await engine.sessionStore.deleteSession(tenantId, sessionId);
  const runDir = engine.programRunDirs.get(sessionId);
  if (runDir) {
    engine.programRunDirs.delete(sessionId);
    await import("node:fs/promises").then(({ rm }) => rm(runDir, { recursive: true, force: true }));
  }
  if (managed.sessionDir) {
    await import("node:fs/promises").then(({ rm }) => rm(managed.sessionDir, { recursive: true, force: true }));
  }
  const timer = engine.programTimeouts.get(sessionId);
  if (timer) { clearTimeout(timer); engine.programTimeouts.delete(sessionId); }
}

  export async function createEngineSession(engine: AgentEngineSessionHost, opts: CreateSessionOpts): Promise<Result<ManagedSessionInfo>> {
    const check = engine.pool.canCreate(opts.tenantId);
    if (!check.ok) return { ok: false, error: check.reason! };

    const sessionId = crypto.randomUUID();

    // ── 会话目录：<sessionsDir>/<tenantId>/<sessionId>/（S1：显式 sessionDir 按租户组织+可控清理）──
    const sessionDir = path.join(engine.sessionsDir, opts.tenantId, sessionId);

    // ── Program session: run workspace + resource loader ────────────
    let cwd: string;
    let sdkOptions: Record<string, unknown> = {};

    if (opts.program) {
      const prog = opts.program;
      // Create run cwd: <workspace>/<tenant>/program-run-<sessionId>（路径推导走 manager 单点——F/WP2 Task 7）
      cwd = await engine.workspaceMgr.ensureProgramRunWorkspace(opts.tenantId, sessionId);
      engine.programRunDirs.set(sessionId, cwd);

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
      const overlayPaths = engine.getOverlayPaths();
      const additionalSkillPaths = [...overlayPaths.skills, ...skillsAbs];
      const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir: engine.getAgentDir(),
        additionalSkillPaths: additionalSkillPaths.length > 0 ? additionalSkillPaths : undefined,
        additionalPromptTemplatePaths: overlayPaths.prompts.length > 0 ? overlayPaths.prompts : undefined,
        appendSystemPrompt: appendSystemPrompt.length > 0 ? appendSystemPrompt : undefined,
        noContextFiles: true, // prevent ancestor AGENTS.md leak
      });
      // S3 缺口 1：自建 loader 必须显式 reload（sdk.js 仅在内部默认 loader 时代调 reload）——
      // 否则扩展加载数为 0。这里不传 extensionFactories：program 会话不注入平台扩展（防泄漏）。
      await resourceLoader.reload();
      sdkOptions.resourceLoader = resourceLoader;

      // Effective tools = program tools ∩ tenant allowed
      const effectiveTools = engine.toolPlatform.getEffectiveTools(opts.tenantId, prog.tools);
      sdkOptions.tools = effectiveTools;
      if (prog.excludeTools && prog.excludeTools.length > 0) {
        sdkOptions.excludeTools = prog.excludeTools;
      }

      // Setup timeout timer
      if (prog.timeoutSec && prog.timeoutSec > 0) {
        const ms = Math.min(prog.timeoutSec, 3600) * 1000;
        const timer = setTimeout(() => {
          engine.abort(sessionId, opts.tenantId).catch(() => {});
          engine.logger.warn({ sessionId, tenantId: opts.tenantId, timeoutSec: prog.timeoutSec, event: "program_timeout_abort" });
        }, ms);
        engine.programTimeouts.set(sessionId, timer);
      }
    } else {
      cwd = await engine.workspaceMgr.ensureWorkspace(opts.tenantId, opts.project);
      // L1 注入（F/WP2 Task 8）：有已验证覆盖层时为常规会话显式接线 ResourceLoader
      //（agent-dir 卷为基准，platform 卷为覆盖层）；无覆盖层时保持 SDK 默认行为。
      const overlayPaths = engine.getOverlayPaths();
      if (overlayPaths.skills.length > 0 || overlayPaths.prompts.length > 0) {
        const resourceLoader = new DefaultResourceLoader({
          cwd,
          agentDir: engine.getAgentDir(),
          additionalSkillPaths: overlayPaths.skills.length > 0 ? overlayPaths.skills : undefined,
          additionalPromptTemplatePaths: overlayPaths.prompts.length > 0 ? overlayPaths.prompts : undefined,
        });
        // S3 缺口 1：自建 loader 必须显式 reload（sdk.js 仅在内部默认 loader 时代调 reload）
        await resourceLoader.reload();
        sdkOptions.resourceLoader = resourceLoader;
      }
    }

    const model = engine.modelRouter.resolve(opts.provider, opts.model);

    // 懒落盘认知（S1）：SDK 会话首个 assistant message 才写盘——纯 user 消息窗口内
    // pool meta（entryCount）与磁盘 JSONL 不一致，以已落盘为准/接受该窗口；
    // 崩溃时该轮未落盘对话内容丢失（recoverAll 以 messages.length vs entryCount 记 warn 不阻断）。
    // 传 { id: sessionId }：让 JSONL 文件名与 header.id 携带 PTH sessionId，恢复时可按 id 精确校验。
    const sessionManager = SessionManager.create(cwd, sessionDir, { id: sessionId });
    const { session } = await sdkCreateSession({
      ...engine.buildSessionBaseOpts(opts.tenantId, {
        cwd,
        model,
        thinkingLevel: (opts.thinkingLevel as any) ?? "medium",
        sessionManager,
      }),
      ...sdkOptions,
    });

    const now = Date.now();
    const initialSnapshot = engine.computeVersionSnapshot();
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

    engine.pool.add(poolSession);
    engine.agentSessions.set(sessionId, session);
    engine.sessionManagers.set(sessionId, sessionManager);

    await engine.sessionStore.saveMeta(opts.tenantId, sessionId, {
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

    engine.logger.info({ sessionId, tenantId: opts.tenantId, event: "session_created" });

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

