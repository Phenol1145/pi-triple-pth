import { describe, it, expect } from "vitest";
import { createServer, type AddressInfo } from "node:http";
import { spaceRegistry } from "../../src/pth/kernel/execution/space-registry.js";
import { buildSpaceIndex } from "../../src/pth/kernel/execution/space-index.js";
import { PyKernel } from "@away_from/pth-sandbox";
import { BashKernel } from "@away_from/pth-sandbox";

/**
 * 空间治理 v2（2026-08-12 用户裁决批 3）：
 *   - SpaceDef 声明 allowChildren/maxDepth/childParams/memoryScope
 *   - meta 禁建子空间（凭据根级固化）；asp.create 在父空间内按表单校验
 *   - 深度衰减（子空间深度 ≤ 父 maxDepth）；extraTools 只能收窄不能扩权
 *   - asp.index 索引即引导（空间树 + 表单展示）
 *   - 记忆桥盖章（S0-1，2026-08-16）：space 权威来自服务端 token 声明；
 *     kernel 不再把盖章暴露进 exec globals/env——程序不可见、不可伪造
 */

describe("空间治理 v2（批 3）——SpaceDef 声明", () => {
  it("dev 声明 allowChildren + maxDepth + childParams 表单；meta 恒不可建", () => {
    const dev = spaceRegistry.get("dev")!;
    expect(dev.allowChildren).toBe(true);
    expect(dev.maxDepth).toBe(2);
    expect(dev.childParams?.map((p) => p.name)).toEqual(["execTool", "memoryScope", "extraTools", "description"]);
    expect(dev.childParams?.filter((p) => p.required).map((p) => p.name)).toEqual(["execTool", "memoryScope", "description"]);
    // 其余内置空间不声明 allowChildren（缺省 false）
    for (const id of ["meta", "ts", "python", "bash", "write"]) {
      expect(spaceRegistry.get(id)?.allowChildren).not.toBe(true);
    }
  });

  it("深度计算（meta=0 / 内置=0·parent=meta；子空间=1）", () => {
    expect(spaceRegistry.depthOf("meta")).toBe(0);
    expect(spaceRegistry.depthOf("dev")).toBe(0);   // parent=meta 不算深度
    spaceRegistry.register({ id: "gv-depth", kind: "action", execTool: "depth_exec", parent: "dev", description: "t" });
    expect(spaceRegistry.depthOf("gv-depth")).toBe(1);
    spaceRegistry.register({ id: "gv-depth2", kind: "action", execTool: "depth2_exec", parent: "gv-depth", description: "t" });
    expect(spaceRegistry.depthOf("gv-depth2")).toBe(2);
    expect(spaceRegistry.childrenOf("dev").map((s) => s.id)).toContain("gv-depth");
    spaceRegistry.unregister("gv-depth2");
    spaceRegistry.unregister("gv-depth");
  });

  it("unregister 拒绝有子空间的目标（2026-08-12 审计 BUG-4——防孤儿子空间断 parent 链）", () => {
    spaceRegistry.register({ id: "gv-orphan-p", kind: "action", execTool: "bash", parent: "dev", description: "t" });
    spaceRegistry.register({ id: "gv-orphan-c", kind: "action", execTool: "bash", parent: "gv-orphan-p", description: "c" });
    expect(() => spaceRegistry.unregister("gv-orphan-p")).toThrow(/先注销后代/);
    expect(spaceRegistry.get("gv-orphan-p")).toBeDefined();   // 未被删
    spaceRegistry.unregister("gv-orphan-c");
    spaceRegistry.unregister("gv-orphan-p");   // 后代清完后可注销
    expect(spaceRegistry.get("gv-orphan-p")).toBeUndefined();
  });

  it("注册幂等比较含治理字段（allowChildren 变化报冲突）", () => {
    expect(() => spaceRegistry.register({ id: "dev", kind: "action", execTool: "dev", parent: "meta", allowChildren: false, description: "x", builtin: true })).toThrow(/注册冲突/);
  });
});

describe("空间治理 v2——asp.index 索引即引导", () => {
  it("meta 空间树含治理标注（可建子空间/表单/记忆域）", async () => {
    const out = await buildSpaceIndex({}, { currentSpace: "meta", kernel: {} as never, caps: {} });
    expect(out).toContain("空间树");
    expect(out).toContain("meta 禁建");
    expect(out).toContain("可建子空间(maxDepth=2)");
    expect(out).toContain("表单: execTool* memoryScope* extraTools description*");
  });

  it("生产空间/自定义子空间索引：工具族视图 + 治理信息（不再'暂无索引构造器'）", async () => {
    const dev = await buildSpaceIndex({}, { currentSpace: "dev", kernel: {} as never, caps: {} });
    expect(dev).toContain("dev 空间 · 工具族");
    expect(dev).toContain("dev.*");
    expect(dev).toContain("debug.*");
    expect(dev).toContain("可建子空间");
    // 自定义子空间注册后同样有构造器
    spaceRegistry.register({ id: "gv-idx", kind: "action", execTool: "gv_exec", parent: "dev", memoryScope: "dev-sandbox", description: "t" });
    const sub = await buildSpaceIndex({}, { currentSpace: "gv-idx", kernel: {} as never, caps: {} });
    expect(sub).toContain("gv-idx 空间 · 工具族");
    expect(sub).toContain("记忆域: dev-sandbox");
    spaceRegistry.unregister("gv-idx");
  });
});

describe("空间治理 v2——记忆桥盖章（S0-1：请求层带外，程序不可伪造）", () => {
  async function listenBridge(onRequest: (body: Record<string, unknown>, auth: string | undefined) => void) {
    const seen: Array<Record<string, unknown>> = [];
    const server = createServer((req, res) => {
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
        onRequest(body, req.headers.authorization);
        seen.push(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/kernel/memory-bridge`;
    return {
      seen,
      url,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  it("PyKernel 不再把盖章暴露进 exec globals（程序不可见）", async () => {
    const k = new PyKernel({ pythonBin: "python3", timeoutMs: 10_000 });
    try {
      const r1 = await k.execute("print('_PTH_SPACE_visible=' + str('_PTH_SPACE' in globals()))", { space: "dev" });
      expect(r1.ok).toBe(true);
      expect(r1.stdout).toContain("_PTH_SPACE_visible=False");
      // single 模式也不暴露（协议级 space 不落 exec globals）
      const r2 = await k.execute("globals().get('_PTH_SPACE', 'absent')", { exec: "single", space: "python" });
      expect(r2.ok).toBe(true);
      expect(r2.value).toBe("absent");
      // 程序自造同名变量只是普通用户变量，不是盖章
      const r3 = await k.execute("_PTH_SPACE = 'evil'\nprint('forged=' + str(globals().get('_PTH_SPACE', '(none)')))");
      expect(r3.ok).toBe(true);
      expect(r3.stdout).toContain("forged=evil");
    } finally {
      k.dispose();
    }
  });

  it("PyKernel 记忆桥请求不带 body.space——自造 _PTH_SPACE 不改变可见性", async () => {
    const bridge = await listenBridge(() => {});
    const k = new PyKernel({ pythonBin: "python3", memoryBridge: bridge.url, bridgeToken: "tok-dev" });
    try {
      const r = await k.execute("_PTH_SPACE = 'evil'\n_result = memory.query('SELECT 1')", { space: "dev" });
      expect(r.ok).toBe(true);
      expect(r.value).toEqual({ ok: true });
      expect(bridge.seen).toHaveLength(1);
      expect(bridge.seen[0]).not.toHaveProperty("space");
      expect(bridge.seen[0]!.op).toBe("query");
      expect(bridge.seen[0]!.sql).toBe("SELECT 1");
    } finally {
      k.dispose();
      await bridge.close();
    }
  });

  it("BashKernel 不再 export PTH_MEMORY_SPACE（env 不可见）", async () => {
    const k = new BashKernel({ timeoutMs: 10_000, lazySpawn: true });
    try {
      const r1 = await k.execute("echo stamp=${PTH_MEMORY_SPACE-unset}", { space: "python" });
      expect(r1.ok).toBe(true);
      expect(r1.stdout).toContain("stamp=unset");
      const r2 = await k.execute("echo stamp2=${PTH_MEMORY_SPACE-unset}");
      expect(r2.ok).toBe(true);
      expect(r2.stdout).toContain("stamp2=unset");
    } finally {
      k.dispose();
    }
  });

  it("BashKernel 记忆桥请求不带 body.space", async () => {
    let authHeader: string | undefined;
    const bridge = await listenBridge((_body, auth) => { authHeader = auth; });
    const k = new BashKernel({ timeoutMs: 10_000, memoryBridge: bridge.url, bridgeToken: "tok-bash" });
    try {
      const r = await k.execute('memory_query "SELECT 1"', { space: "python" });
      expect(r.ok).toBe(true);
      expect(bridge.seen).toHaveLength(1);
      expect(bridge.seen[0]).not.toHaveProperty("space");
      expect(bridge.seen[0]!.op).toBe("query");
      expect(bridge.seen[0]!.sql).toBe("SELECT 1");
      expect(authHeader).toBe("Bearer tok-bash");
    } finally {
      k.dispose();
      await bridge.close();
    }
  });

  it("程序自造同名 shell 函数不触达桥（不改变服务端盖章权威）", async () => {
    const bridge = await listenBridge(() => {});
    const k = new BashKernel({ timeoutMs: 10_000, memoryBridge: bridge.url, bridgeToken: "tok-bash" });
    try {
      const r = await k.execute('function memory_query { echo "forged:$1"; }\nmemory_query "SELECT 1"', { space: "python" });
      expect(r.ok).toBe(true);
      expect(r.stdout).toContain("forged:SELECT 1");
      expect(bridge.seen).toHaveLength(0);   // 同名函数只是用户级覆盖，不产生桥请求
    } finally {
      k.dispose();
      await bridge.close();
    }
  });
});

// ── 治理通道创建子空间（2026-08-14 N8——asp.create 工具退役：空间生成走优化通道/审批面，
//   校验从原 agent-loop 分支迁入 spaceRegistry.createChild——生成即绑定）────────────────
describe("空间治理 v2——createChild 治理通道（N8：生成即绑定）", () => {
  afterEach(() => {
    for (const s of spaceRegistry.list()) {
      if (!s.builtin) { try { spaceRegistry.unregister(s.id); } catch { /* 容忍 */ } }
    }
  });

  it("bindRoles 必填（生成即绑定——N8）", () => {
    expect(() => spaceRegistry.createChild("dev", { id: "gc-nobind", execTool: "ts", memoryScope: "m", description: "x", bindRoles: [] })).toThrow(/bindRoles 必填/);
  });

  it("maxDepth 超限拒绝（子空间内再建孙空间）", () => {
    const a = spaceRegistry.createChild("dev", { id: "gc-sandbox-a", execTool: "ts", memoryScope: "m", description: "t", bindRoles: ["developer"] });
    expect(a.allowChildren).toBe(true);   // 治理继承（allowChildren/maxDepth 沿父链）
    const grand = spaceRegistry.createChild("gc-sandbox-a", { id: "gc-grand", execTool: "bash", memoryScope: "m", description: "孙", bindRoles: ["developer"] });
    expect(spaceRegistry.get("gc-grand")).toBeDefined();
    expect(() => spaceRegistry.createChild("gc-grand", { id: "gc-great", execTool: "bash", memoryScope: "m", description: "曾孙", bindRoles: ["developer"] })).toThrow(/超过父空间 maxDepth/);
    expect(spaceRegistry.get("gc-great")).toBeUndefined();
  });

  it("extraTools 只能收窄不能扩权（挂非父族拒绝；父族通过）", () => {
    expect(() => spaceRegistry.createChild("dev", { id: "gc-x", execTool: "python", memoryScope: "m", extraTools: ["write"], description: "扩权", bindRoles: ["developer"] })).toThrow(/只能收窄不能扩权/);
    const y = spaceRegistry.createChild("dev", { id: "gc-y", execTool: "python", memoryScope: "m", extraTools: ["debug"], description: "收窄", bindRoles: ["developer"] });
    expect(y.extraTools).toEqual(["debug"]);
  });

  it("meta 禁建 + 未声明 allowChildren 拒绝 + execTool 白名单 + childParams 必填 + id 格式", () => {
    expect(() => spaceRegistry.createChild("meta", { id: "gc-m", execTool: "ts", memoryScope: "m", description: "x", bindRoles: ["developer"] })).toThrow(/meta 空间禁建子空间/);
    expect(() => spaceRegistry.createChild("ts", { id: "gc-ts", execTool: "ts", memoryScope: "m", description: "x", bindRoles: ["developer"] })).toThrow(/未声明 allowChildren/);
    expect(() => spaceRegistry.createChild("dev", { id: "gc-bad-tool", execTool: "c", memoryScope: "m", description: "x", bindRoles: ["developer"] })).toThrow(/不是已注册语言族/);
    expect(() => spaceRegistry.createChild("dev", { id: "gc-missing", execTool: "ts", description: "缺 memoryScope", bindRoles: ["developer"] })).toThrow(/缺必填参量/);
    expect(() => spaceRegistry.createChild("dev", { id: "Bad ID!", execTool: "ts", memoryScope: "m", description: "x", bindRoles: ["developer"] })).toThrow(/id 非法/);
  });
});
