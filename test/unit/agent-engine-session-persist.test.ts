import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentEngine } from "../../src/pth/core/agent-engine.js";
import { SessionPool } from "../../src/pth/core/session-pool.js";

/**
 * F/WP2 Task 4 — SDK 持久化 SessionManager 接线。
 * mock SDK 的 createAgentSession（无 LLM key），保留真实 SessionManager 验证 JSONL 落盘结构。
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
          // 模拟 SDK 行为：user 消息 + assistant 消息经 SessionManager 落盘，然后发事件（不调用 LLM）
          sm.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
          sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: Date.now() });
          for (const cb of [...subscribers]) {
            cb({ type: "message_end", message: { role: "assistant", content: [], timestamp: Date.now(), usage: { input: 1, output: 1 } } });
          }
          for (const cb of [...subscribers]) cb({ type: "agent_end" });
        },
        abort: async () => {},
        subscribe: (cb: (ev: any) => void) => {
          subscribers.push(cb);
          return () => {};
        },
        dispose: () => {},
      };
      return { session };
    }),
  };
});

// ── helpers ──────────────────────────────────────────────────────────

function makeEngine(tmpDir: string, sessionsDir: string): AgentEngine {
  const cwd = path.join(tmpDir, "workspace", "tenant-a", "proj-1");
  fs.mkdirSync(cwd, { recursive: true });
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as any;
  const metrics = {
    promptDuration: { startTimer: () => () => {} },
    sessionsActive: { set: vi.fn(), inc: vi.fn(), dec: vi.fn() },
    tokensTotal: { inc: vi.fn() },
  } as any;
  const sessionStore = {
    saveMeta: vi.fn(async () => {}),
    appendEntry: vi.fn(async () => {}),
    getMeta: vi.fn(async () => null),
    getEntries: vi.fn(async () => []),
    saveSnapshot: vi.fn(async () => {}),
    getLatestSnapshot: vi.fn(async () => null),
    listSessions: vi.fn(async () => []),
    deleteSession: vi.fn(async () => {}),
    saveVersionSnapshot: vi.fn(async () => {}),
    getLatestVersionSnapshot: vi.fn(async () => null),
  } as any;
  const modelRouter = { resolve: () => ({ id: "test-model" }), getRuntime: () => ({}) } as any;
  const toolPlatform = {
    getAllowedTools: () => [],
    getSdkToolDefinitions: () => [],
    getEffectiveTools: () => [],
    recordToolStart: vi.fn(),
    recordToolEnd: vi.fn(),
  } as any;
  const workspaceMgr = {
    ensureWorkspace: vi.fn(async () => cwd),
    getPlatformDir: () => path.join(tmpDir, "platform"),
  } as any;
  const pool = new SessionPool(
    { maxSessions: 20, maxSessionsPerTenant: 5, idleTimeoutMs: 300_000 },
    sessionStore,
    logger,
    metrics,
  );
  return new AgentEngine(pool, modelRouter, workspaceMgr, sessionStore, toolPlatform, logger, metrics, sessionsDir);
}

function listJsonl(sessionDir: string): string[] {
  return fs.readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
}

function parseLines(filePath: string): any[] {
  return fs
    .readFileSync(filePath, "utf-8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
}

// ── tests ────────────────────────────────────────────────────────────

describe("AgentEngine 持久化 SessionManager 接线（F/WP2 Task 4）", () => {
  it("createSession 使用持久化 SessionManager：sessionDir 按租户组织，SDK session id = PTH session id", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pth-persist-"));
    const sessionsDir = path.join(tmp, "sessions");
    const engine = makeEngine(tmp, sessionsDir);
    try {
      const res = await engine.createSession({ tenantId: "tenant-a", project: "proj-1" });
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error("unreachable");
      const sid = res.data.sessionId;

      const opts = sdkMocks.createdOptions[sdkMocks.createdOptions.length - 1];
      const sm = opts.sessionManager;
      expect(sm.isPersisted()).toBe(true); // 非 inMemory
      expect(sm.getSessionId()).toBe(sid); // { id: sessionId } 已透传
      // S1：显式 sessionDir = <sessionsDir>/<tenantId>/<sessionId>/
      expect(sm.getSessionDir()).toBe(path.join(sessionsDir, "tenant-a", sid));
      expect(fs.existsSync(sm.getSessionDir())).toBe(true);
      // 懒落盘：尚未有任何消息 → 无 JSONL 文件
      expect(listJsonl(sm.getSessionDir())).toHaveLength(0);
    } finally {
      await engine.drain();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("懒落盘认知（S1）：纯 user 消息不写盘，首个 assistant 消息才写 JSONL", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pth-persist-"));
    const sessionsDir = path.join(tmp, "sessions");
    const engine = makeEngine(tmp, sessionsDir);
    try {
      const res = await engine.createSession({ tenantId: "tenant-a", project: "proj-1" });
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error("unreachable");
      const opts = sdkMocks.createdOptions[sdkMocks.createdOptions.length - 1];
      const sm = opts.sessionManager;
      const sessionDir = sm.getSessionDir();

      // 纯 user 消息：不落盘（窗口内 meta.entryCount 与磁盘不一致——接受）
      sm.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() });
      expect(listJsonl(sessionDir)).toHaveLength(0);

      // 首个 assistant 消息：header + 全部 entries 一次性写盘
      sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: Date.now() });
      const files = listJsonl(sessionDir);
      expect(files).toHaveLength(1);
    } finally {
      await engine.drain();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("JSONL 结构（S1 实证）：header type=session + append-only message 树", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pth-persist-"));
    const sessionsDir = path.join(tmp, "sessions");
    const engine = makeEngine(tmp, sessionsDir);
    try {
      const res = await engine.createSession({ tenantId: "tenant-a", project: "proj-1" });
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error("unreachable");
      const sid = res.data.sessionId;
      const opts = sdkMocks.createdOptions[sdkMocks.createdOptions.length - 1];
      const sm = opts.sessionManager;
      const sessionDir = sm.getSessionDir();

      sm.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() });
      sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: Date.now() });
      const [file] = listJsonl(sessionDir);
      const entries = parseLines(path.join(sessionDir, file));

      expect(entries[0].type).toBe("session");
      expect(entries[0].id).toBe(sid);
      expect(entries[0].cwd).toBeDefined();

      const msgs = entries.filter((e) => e.type === "message");
      expect(msgs).toHaveLength(2);
      expect(msgs[0].message.role).toBe("user");
      expect(msgs[1].message.role).toBe("assistant");
      expect(typeof msgs[0].id).toBe("string");
      expect(msgs[0].parentId).toBeNull();
      expect(msgs[1].parentId).toBe(msgs[0].id);

      // append-only：追加后行数 +1，旧行逐字节不变
      const beforeRaw = fs.readFileSync(path.join(sessionDir, file), "utf-8");
      sm.appendMessage({ role: "user", content: [{ type: "text", text: "again" }], timestamp: Date.now() });
      const afterRaw = fs.readFileSync(path.join(sessionDir, file), "utf-8");
      const afterLines = afterRaw.trim().split("\n");
      expect(afterLines).toHaveLength(beforeRaw.trim().split("\n").length + 1);
      expect(afterRaw.startsWith(beforeRaw)).toBe(true);
    } finally {
      await engine.drain();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("engine.prompt 全链路（mock SDK 无 LLM）→ 会话 JSONL 落盘且含用户消息", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pth-persist-"));
    const sessionsDir = path.join(tmp, "sessions");
    const engine = makeEngine(tmp, sessionsDir);
    try {
      const res = await engine.createSession({ tenantId: "tenant-a", project: "proj-1" });
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error("unreachable");
      const sid = res.data.sessionId;

      const events: any[] = [];
      for await (const ev of engine.prompt(sid, "tenant-a", "hello there")) events.push(ev);
      expect(events[events.length - 1].type).toBe("agent_end");

      const opts = sdkMocks.createdOptions[sdkMocks.createdOptions.length - 1];
      const sm = opts.sessionManager;
      const files = listJsonl(sm.getSessionDir());
      expect(files).toHaveLength(1);
      const entries = parseLines(path.join(sm.getSessionDir(), files[0]));
      const texts = entries
        .filter((e) => e.type === "message")
        .map((e) => e.message?.content?.[0]?.text ?? "");
      expect(texts).toContain("hello there");
      expect(texts).toContain("ok");
    } finally {
      await engine.drain();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
