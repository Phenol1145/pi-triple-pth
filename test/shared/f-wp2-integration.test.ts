import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { Redis } from "ioredis";
import type { Redis as RedisType } from "ioredis";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentEngine } from "../../src/pth/core/agent-engine.js";
import { SessionPool } from "../../src/pth/core/session-pool.js";
import { WorkspaceManager, detectPlatform } from "@away_from/infra";

/**
 * F/WP2 Task 9 — WP2 集成验证：持久化不变量端到端。
 * 模拟重启语义：创建→prompt→JSONL 落盘 + Redis pool meta → 新 AgentEngine（同 Redis/卷）→ recoverAll
 * → 恢复会话可续跑 + 恢复路径工具治理（Task 6 评审修复）与 createSession 一致 + 工作区路径推导 + 恢复清理。
 *
 * mock 策略（沿袭 agent-engine-session-persist / agent-engine-recover）：保留真实 SessionManager，
 * mock createAgentSession 记录调用参数（断言恢复路径参数完整）；真实 Redis（同 Task 5/6 惯例）。
 */

const sdkMocks = vi.hoisted(() => ({
  createdOptions: [] as any[],
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...mod,
    createAgentSession: vi.fn(async (options: any) => {
      sdkMocks.createdOptions.push(options);
      const sm = options.sessionManager;
      const subscribers: Array<(ev: any) => void> = [];
      const session = {
        prompt: async (text: string) => {
          // 模拟 SDK 行为：user + assistant 消息经 SessionManager 落盘，然后发事件（不调用 LLM）
          sm.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
          sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: Date.now() });
          for (const cb of [...subscribers]) {
            cb({ type: "message_end", message: { role: "assistant", content: [], timestamp: Date.now(), usage: { input: 1, output: 1 } } });
          }
          for (const cb of [...subscribers]) cb({ type: "agent_end" });
        },
        abort: async () => {},
        subscribe: (cb: (ev: any) => void) => { subscribers.push(cb); return () => {}; },
        dispose: () => {},
      };
      return { session };
    }),
  };
});

// ── helpers ──────────────────────────────────────────────────────────

/** 租户工具治理面的固定输入（createSession 与恢复路径必须一致） */
const ALLOWED_TOOLS = ["read", "edit"];
const SDK_TOOL_DEFS = [{ name: "bash", type: "function", description: "run bash", parameters: { type: "object", properties: {} } }];

function mockDeps() {
  return {
    sessionStore: {
      saveMeta: vi.fn(async () => {}), appendEntry: vi.fn(async () => {}), getMeta: vi.fn(async () => null),
      getEntries: vi.fn(async () => []), saveSnapshot: vi.fn(async () => {}), getLatestSnapshot: vi.fn(async () => null),
      listSessions: vi.fn(async () => []), deleteSession: vi.fn(async () => {}),
      saveVersionSnapshot: vi.fn(async () => {}), getLatestVersionSnapshot: vi.fn(async () => null),
    } as any,
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as any,
    metrics: {
      promptDuration: { startTimer: () => () => {} },
      sessionsActive: { set: vi.fn(), inc: vi.fn(), dec: vi.fn() },
      tokensTotal: { inc: vi.fn() },
    } as any,
    audit: { write: vi.fn(async () => {}) } as any,
  };
}

function makeWorkspaceMgr(tmp: string): { workspaceMgr: WorkspaceManager; basePath: string } {
  const basePath = path.join(tmp, "workspaces");
  return {
    workspaceMgr: new WorkspaceManager(detectPlatform(), basePath, path.join(tmp, "platform"), path.join(tmp, "tenants")),
    basePath,
  };
}

/** 真实 WorkspaceManager + 真实 SessionPool（Redis 写直通）+ 记录型 toolPlatform */
function makeEngine(tmp: string, sessionsDir: string, workspaceMgr: WorkspaceManager, redis: RedisType, deps: ReturnType<typeof mockDeps>) {
  // getRuntime 返回共享实例（对齐生产 ModelRouter：this.runtime 单例缓存——见 router.ts:56-58），
  // 使恢复路径的 credentialed modelRuntime 与 createSession 是同一实例（Task 6 评审修复断言）
  const modelRuntime = {};
  const modelRouter = { resolve: () => ({ id: "test-model" }), getRuntime: () => modelRuntime } as any;
  const toolPlatform = {
    getAllowedTools: vi.fn(() => ALLOWED_TOOLS),
    getSdkToolDefinitions: vi.fn(() => SDK_TOOL_DEFS),
    getEffectiveTools: vi.fn(() => ALLOWED_TOOLS),
    recordToolStart: vi.fn(),
    recordToolEnd: vi.fn(),
  } as any;
  const pool = new SessionPool(
    { maxSessions: 20, maxSessionsPerTenant: 5, idleTimeoutMs: 300_000 },
    deps.sessionStore, deps.logger, deps.metrics, redis,
  );
  const engine = new AgentEngine(pool, modelRouter, workspaceMgr, deps.sessionStore, toolPlatform, deps.logger, deps.metrics, sessionsDir, deps.audit);
  return { engine, toolPlatform, modelRuntime };
}

function listJsonl(sessionDir: string): string[] {
  return fs.readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
}

function messageCount(sessionDir: string): number {
  const [file] = listJsonl(sessionDir);
  if (!file) return 0;
  return fs
    .readFileSync(path.join(sessionDir, file), "utf-8")
    .trim()
    .split("\n")
    .filter((l) => JSON.parse(l).type === "message").length;
}

/** 轮询等待 pool meta 满足谓词（fire-and-forget 写直通后确定性读取） */
async function waitForMeta(redis: RedisType, sid: string, predicate: (m: any) => boolean, timeoutMs = 8000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const raw = await redis.get(`pool:${sid}:meta`);
    if (raw) {
      const meta = JSON.parse(raw);
      if (predicate(meta)) return meta;
    }
    if (Date.now() > deadline) throw new Error(`timeout waiting for pool meta ${sid}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** 创建会话并 prompt 一轮（JSONL 落盘 + Redis pool meta entryCount=2） */
async function createAndPrompt(engine: AgentEngine, tenant: string, project: string, text: string): Promise<string> {
  const res = await engine.createSession({ tenantId: tenant, project });
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("unreachable");
  const sid = res.data.sessionId;
  const events: any[] = [];
  for await (const ev of engine.prompt(sid, tenant, text)) events.push(ev);
  expect(events[events.length - 1].type).toBe("agent_end");
  return sid;
}

// ── tests ────────────────────────────────────────────────────────────

describe("F/WP2 Task 9 — WP2 集成验证：持久化不变量端到端", () => {
  let redis: RedisType;
  const writtenKeys: string[] = [];

  beforeAll(() => {
    redis = new Redis({ host: "localhost", port: 6379, maxRetriesPerRequest: 1, lazyConnect: true });
  });

  afterAll(async () => {
    try {
      for (const k of writtenKeys) await redis.del(k);
    } catch { /* best-effort */ }
    redis.disconnect();
  });

  beforeEach(() => {
    sdkMocks.createdOptions.length = 0;
  });

  it("核心闭环：创建→prompt→JSONL+Redis 落盘→模拟重启→recoverAll→会话可续跑", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wp2-int-"));
    const sessionsDir = path.join(tmp, "sessions");
    const { workspaceMgr, basePath } = makeWorkspaceMgr(tmp);
    try {
      // ── 崩溃前进程：engine A（真实 SDK SessionManager，mock createAgentSession 无 LLM）──
      const depsA = mockDeps();
      const { engine: engineA } = makeEngine(tmp, sessionsDir, workspaceMgr, redis, depsA);
      const sid = await createAndPrompt(engineA, "tenant-a", "proj-1", "first turn");
      writtenKeys.push(`pool:${sid}:meta`);

      // 断言 1：会话目录 JSONL 落盘（header + 2 messages）
      const sessionDir = path.join(sessionsDir, "tenant-a", sid);
      expect(listJsonl(sessionDir)).toHaveLength(1);
      expect(messageCount(sessionDir)).toBe(2);

      // 断言 2：Redis pool meta 存在且含恢复所需输入（sessionDir/cwd/entryCount）
      const meta = await waitForMeta(redis, sid, (m) => m.entryCount === 2);
      expect(meta.state).toBe("idle");
      expect(meta.sessionDir).toBe(sessionDir);
      expect(meta.cwd).toBe(path.join(basePath, "tenant-a", "proj-1"));

      // 断言 3（Task 7 集成）：工作区路径推导单点——program-run 形态 <workspaces>/<tenant>/program-run-<sid>
      expect(workspaceMgr.getProgramRunCwd("tenant-a", sid)).toBe(path.join(basePath, "tenant-a", `program-run-${sid}`));
      expect(workspaceMgr.getProgramRunCwd("tenant-a", sid).startsWith(workspaceMgr.getTenantWorkspaceRoot("tenant-a"))).toBe(true);

      // ── 模拟进程退出：drain 释放 SDK 会话，Redis 池元 + JSONL 保留（崩溃语义）──
      await engineA.drain();

      // ── 模拟重启：新 engine（新 pool，同 Redis + 同 sessionsDir + 同工作区）──
      const depsB = mockDeps();
      const { engine: engineB } = makeEngine(tmp, sessionsDir, workspaceMgr, redis, depsB);
      await engineB.recoverAll();

      // 断言 4：会话出现在池中（idle + recoveredFromCrash，非 interrupted）
      const r = engineB.getPool().get(sid);
      expect(r).toBeDefined();
      expect(r!.state).toBe("idle");
      expect(r!.refCount).toBe(0);
      expect(r!.recoveredFromCrash).toBe(true);
      expect(r!.interrupted).toBe(false);
      // 恢复校验无 mismatch warn（entryCount 一致）
      expect(depsB.logger.warn.mock.calls.filter((c: any[]) => c[0]?.sessionId === sid && c[0]?.event === "recovery_entry_count_mismatch")).toHaveLength(0);

      // 断言 5：恢复的 SessionManager 是新实例（continueRecent）但指向同一会话目录——被用于续跑调用链
      const sidCalls = sdkMocks.createdOptions.filter((o: any) => o.sessionManager.getSessionId() === sid);
      expect(sidCalls).toHaveLength(2);
      const [createOpts, recoverOpts] = sidCalls;
      expect(recoverOpts.sessionManager).not.toBe(createOpts.sessionManager);
      expect(recoverOpts.sessionManager.getSessionDir()).toBe(createOpts.sessionManager.getSessionDir());
      expect(recoverOpts.sessionManager.isPersisted()).toBe(true);

      // 断言 6：恢复会话可继续使用——prompt 续跑走恢复出的 SessionManager，JSONL 追加一轮
      const events2: any[] = [];
      for await (const ev of engineB.prompt(sid, "tenant-a", "second turn")) events2.push(ev);
      expect(events2[events2.length - 1].type).toBe("agent_end");
      expect(messageCount(sessionDir)).toBe(4); // 2 原有 + 2 新增
      // 续跑后池元 entryCount 同步推进（checkpoint→markIdle 写直通）
      const metaAfter = await waitForMeta(redis, sid, (m) => m.entryCount === 4);
      expect(metaAfter.state).toBe("idle");
      expect(metaAfter.cwd).toBe(path.join(basePath, "tenant-a", "proj-1")); // 恢复后 cwd 不漂移

      await engineB.drain();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("恢复路径工具治理（Task 6 评审修复）：tools/customTools/modelRuntime 与 createSession 一致", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wp2-int-"));
    const sessionsDir = path.join(tmp, "sessions");
    const { workspaceMgr } = makeWorkspaceMgr(tmp);
    try {
      const depsA = mockDeps();
      const { engine: engineA, modelRuntime: modelRuntimeA } = makeEngine(tmp, sessionsDir, workspaceMgr, redis, depsA);
      const sid = await createAndPrompt(engineA, "tenant-a", "proj-1", "hi");
      writtenKeys.push(`pool:${sid}:meta`);
      await waitForMeta(redis, sid, (m) => m.entryCount === 2);
      await engineA.drain();

      // 重启恢复（新进程语义：engine B 有自己独立的 ModelRouter/runtime 实例）
      const depsB = mockDeps();
      const { engine: engineB, toolPlatform: toolPlatformB, modelRuntime: modelRuntimeB } = makeEngine(tmp, sessionsDir, workspaceMgr, redis, depsB);
      await engineB.recoverAll();

      const sidCalls = sdkMocks.createdOptions.filter((o: any) => o.sessionManager.getSessionId() === sid);
      expect(sidCalls).toHaveLength(2);
      const [createOpts, recoverOpts] = sidCalls;

      // 治理面一致性：恢复路径重建与 createSession 相同的安全/配置姿态
      expect(recoverOpts.tools).toEqual(createOpts.tools);
      expect(recoverOpts.tools).toEqual(ALLOWED_TOOLS);
      expect(recoverOpts.customTools).toEqual(createOpts.customTools);
      expect(recoverOpts.customTools).toEqual(SDK_TOOL_DEFS);
      // 认证姿态（评审 WP2-R1）：两条路径都传各自的 credentialed modelRuntime，恢复路径不得省略（省略=认证脱节）
      expect(createOpts.modelRuntime).toBe(modelRuntimeA);
      expect(recoverOpts.modelRuntime).toBe(modelRuntimeB);
      expect(recoverOpts.model.id).toBe(createOpts.model.id); // 池元 model 驱动 resolve
      expect(recoverOpts.cwd).toBe(createOpts.cwd);
      // 治理按租户调用（恢复路径不得绕过租户白名单）
      expect(toolPlatformB.getAllowedTools).toHaveBeenCalledWith("tenant-a");
      expect(toolPlatformB.getSdkToolDefinitions).toHaveBeenCalledWith("tenant-a");

      await engineB.drain();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("恢复清理：原 busy 会话→interrupted+refCount=0+审计；恢复后可续用", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wp2-int-"));
    const sessionsDir = path.join(tmp, "sessions");
    const { workspaceMgr } = makeWorkspaceMgr(tmp);
    try {
      // 崩溃现场：engine A 正常创建+prompt（JSONL+pool meta），随后原地把池元改 busy（in-flight 崩溃语义）
      const depsA = mockDeps();
      const { engine: engineA } = makeEngine(tmp, sessionsDir, workspaceMgr, redis, depsA);
      const sidBusy = await createAndPrompt(engineA, "tenant-a", "proj-1", "work turn");
      writtenKeys.push(`pool:${sidBusy}:meta`);
      const raw = await waitForMeta(redis, sidBusy, (m) => m.entryCount === 2);
      await redis.set(`pool:${sidBusy}:meta`, JSON.stringify({ ...raw, state: "busy", refCount: 1 }));
      await engineA.drain();

      // 重启恢复
      const depsB = mockDeps();
      const { engine: engineB } = makeEngine(tmp, sessionsDir, workspaceMgr, redis, depsB);
      await engineB.recoverAll();

      // 恢复清理断言：busy→interrupted 标记 + refCount 归零 + 状态置 idle
      const r = engineB.getPool().get(sidBusy);
      expect(r).toBeDefined();
      expect(r!.state).toBe("idle");
      expect(r!.refCount).toBe(0);
      expect(r!.interrupted).toBe(true);
      expect(r!.recoveredFromCrash).toBe(true);
      // dispatch 丢弃审计（不重放）
      expect(depsB.audit.write).toHaveBeenCalledWith(expect.objectContaining({
        tenantId: "tenant-a",
        actor: "system",
        action: "recovery_interrupted",
        details: expect.objectContaining({ sessionId: sidBusy }),
      }));
      // 恢复的 busy 会话同样可续用
      const events: any[] = [];
      for await (const ev of engineB.prompt(sidBusy, "tenant-a", "resume")) events.push(ev);
      expect(events[events.length - 1].type).toBe("agent_end");
      expect(messageCount(path.join(sessionsDir, "tenant-a", sidBusy))).toBe(4);

      await engineB.drain();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
