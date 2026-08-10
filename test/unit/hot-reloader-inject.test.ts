import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HotReloader, ResourceOverlay } from "../../src/pth/self-modify/hot-reloader.js";
import { AgentEngine } from "../../src/pth/core/agent-engine.js";
import { SessionPool } from "../../src/pth/core/session-pool.js";
import { DefaultResourceLoader } from "@away_from/infra";

/**
 * F/WP2 Task 8 — HotReloader L1 注入闭环：
 * platform 卷 skills/prompts 变更校验通过 → 覆盖层推进 → 后续会话 ResourceLoader
 * （agent-dir 卷为基准，platform 卷为覆盖层）生效；校验失败不注入。
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
      const session = {
        prompt: async () => {},
        abort: async () => {},
        subscribe: () => () => {},
        dispose: () => {},
      };
      return { session };
    }),
  };
});

// ── helpers ──────────────────────────────────────────────────────────

function makeFakes() {
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as any;
  const metrics = { selfModifyTotal: { inc: vi.fn() } } as any;
  const onReload = vi.fn();
  return { logger, metrics, onReload };
}

function makeEngine(tmpDir: string, overlay: ResourceOverlay | undefined): AgentEngine {
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
    ensureProgramRunWorkspace: vi.fn(async () => cwd),
    getPlatformDir: () => path.join(tmpDir, "platform"),
  } as any;
  const pool = new SessionPool(
    { maxSessions: 20, maxSessionsPerTenant: 5, idleTimeoutMs: 300_000 },
    sessionStore,
    logger,
    metrics,
  );
  return new AgentEngine(pool, modelRouter, workspaceMgr, sessionStore, toolPlatform, logger, metrics, path.join(tmpDir, "sessions"), undefined, overlay);
}

// ── tests ────────────────────────────────────────────────────────────

describe("HotReloader L1 注入闭环（F/WP2 Task 8）", () => {
  let tmpRoot: string;
  let platformDir: string;
  let agentDir: string;
  let prevHome: string | undefined;
  let prevAgentDir: string | undefined;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hot-reload-"));
    platformDir = path.join(tmpRoot, "platform");
    agentDir = path.join(tmpRoot, "agent-dir");
    fs.mkdirSync(platformDir, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    // 环境隔离：避免 SDK 默认 agentDir 解析读到开发者真实 ~/.pi/agent
    prevHome = process.env.HOME;
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = path.join(tmpRoot, "home");
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("skills 变更校验通过 → 覆盖层含该文件，后续 ResourceLoader 生效", async () => {
    const overlay = new ResourceOverlay();
    const { logger, metrics, onReload } = makeFakes();
    const hr = new HotReloader(platformDir, logger, metrics, onReload, overlay);

    const skillFile = path.join(platformDir, "skills", "my-skill", "SKILL.md");
    fs.mkdirSync(path.dirname(skillFile), { recursive: true });
    fs.writeFileSync(skillFile, "---\nname: my-skill\ndescription: does the thing\n---\n# My Skill\n");

    await hr.reloadFile(skillFile);

    // 覆盖层推进
    expect(overlay.getOverlayPaths().skills).toContain(skillFile);
    expect(onReload).toHaveBeenCalledWith(expect.objectContaining({ loaded: [skillFile], errors: [] }));

    // 后续会话 ResourceLoader（agent-dir 基准 + platform 覆盖层）注入生效
    const loader = new DefaultResourceLoader({
      cwd: path.join(tmpRoot, "workspace"),
      agentDir,
      additionalSkillPaths: overlay.getOverlayPaths().skills,
    });
    await loader.reload();
    const names = loader.getSkills().skills.map((s) => s.name);
    expect(names).toContain("my-skill");
  });

  it("校验失败（SKILL.md 无标题）→ 不注入；修复后注入，再变坏剔除", async () => {
    const overlay = new ResourceOverlay();
    const { logger, metrics, onReload } = makeFakes();
    const hr = new HotReloader(platformDir, logger, metrics, onReload, overlay);

    const skillFile = path.join(platformDir, "skills", "bad-skill", "SKILL.md");
    fs.mkdirSync(path.dirname(skillFile), { recursive: true });
    fs.writeFileSync(skillFile, "no heading here");

    await hr.reloadFile(skillFile);
    expect(onReload).toHaveBeenCalledWith(expect.objectContaining({ errors: [expect.objectContaining({ file: skillFile })] }));
    expect(overlay.getOverlayPaths().skills).not.toContain(skillFile); // 错误内容不进后续会话

    // 修复后注入
    fs.writeFileSync(skillFile, "---\nname: fixed-skill\ndescription: fixed\n---\n# Fixed Skill\n");
    await hr.reloadFile(skillFile);
    expect(overlay.getOverlayPaths().skills).toContain(skillFile);

    // 再次变坏 → 剔除（错误版本不残留）
    fs.writeFileSync(skillFile, "broken again");
    await hr.reloadFile(skillFile);
    expect(overlay.getOverlayPaths().skills).not.toContain(skillFile);
  });

  it("prompts 变更校验通过 → additionalPromptTemplatePaths 生效", async () => {
    const overlay = new ResourceOverlay();
    const { logger, metrics, onReload } = makeFakes();
    const hr = new HotReloader(platformDir, logger, metrics, onReload, overlay);

    const promptFile = path.join(platformDir, "prompts", "review.md");
    fs.mkdirSync(path.dirname(promptFile), { recursive: true });
    fs.writeFileSync(promptFile, "---\nname: review\n---\nPlease review the code\n");

    await hr.reloadFile(promptFile);

    expect(overlay.getOverlayPaths().prompts).toContain(promptFile);
    const loader = new DefaultResourceLoader({
      cwd: path.join(tmpRoot, "workspace"),
      agentDir,
      additionalPromptTemplatePaths: overlay.getOverlayPaths().prompts,
    });
    await loader.reload();
    const promptNames = loader.getPrompts().prompts.map((p) => p.name);
    expect(promptNames).toContain("review");
  });

  it("settings.json 校验但不注入（config 无 ResourceLoader 注入面）", async () => {
    const overlay = new ResourceOverlay();
    const { logger, metrics, onReload } = makeFakes();
    const hr = new HotReloader(platformDir, logger, metrics, onReload, overlay);

    const configFile = path.join(platformDir, "config", "settings.json");
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify({ model: "gpt-4o" }));

    await hr.reloadFile(configFile);
    expect(onReload).toHaveBeenCalledWith(expect.objectContaining({ loaded: [configFile], errors: [] }));
    // config 变更通过校验，但覆盖层仅含 skills/prompts——不注入
    expect(overlay.getOverlayPaths()).toEqual({ skills: [], prompts: [] });
  });

  it("AgentEngine 接线：createSession 的 resourceLoader 反映已验证覆盖层（mock SDK）", async () => {
    const overlay = new ResourceOverlay();
    const skillFile = path.join(platformDir, "skills", "engine-skill", "SKILL.md");
    fs.mkdirSync(path.dirname(skillFile), { recursive: true });
    fs.writeFileSync(skillFile, "---\nname: engine-skill\ndescription: from engine test\n---\n# Engine Skill\n");
    overlay.markValidated("skills", skillFile);

    const engine = makeEngine(tmpRoot, overlay);
    const res = await engine.createSession({ tenantId: "tenant-a", project: "proj-1" });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");

    const opts = sdkMocks.createdOptions[sdkMocks.createdOptions.length - 1];
    const loader = opts.resourceLoader as DefaultResourceLoader;
    expect(loader).toBeInstanceOf(DefaultResourceLoader);
    await loader.reload();
    const names = loader.getSkills().skills.map((s) => s.name);
    expect(names).toContain("engine-skill");
    await engine.drain();
  });

  it("无覆盖层（空 overlay）→ createSession 不传 resourceLoader（SDK 默认行为）", async () => {
    const engine = makeEngine(tmpRoot, new ResourceOverlay());
    const res = await engine.createSession({ tenantId: "tenant-a", project: "proj-1" });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    const opts = sdkMocks.createdOptions[sdkMocks.createdOptions.length - 1];
    expect(opts.resourceLoader).toBeUndefined();
    await engine.drain();
  });
});
