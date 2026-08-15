import { describe, it, expect } from "vitest";
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
 *   - 记忆桥盖章：kernel 层注入当前空间（python _PTH_SPACE / bash PTH_MEMORY_SPACE）
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

describe("空间治理 v2——记忆桥盖章（kernel 层注入当前空间）", () => {
  it("PyKernel execute 带 space → 用户代码环境 _PTH_SPACE 生效（记忆库读取通道）", async () => {
    const k = new PyKernel({ pythonBin: "python3", timeoutMs: 10_000 });
    try {
      const r1 = await k.execute("print('stamp=' + str(globals().get('_PTH_SPACE', '(none)')))", { space: "dev" });
      expect(r1.ok).toBe(true);
      expect(r1.stdout).toContain("stamp=dev");
      // 无 space → 协议级清章（2026-08-12 审计 ROBUST-2 修复——防 REPL 跨任务残留）
      const r2 = await k.execute("print('stamp2=' + str(globals().get('_PTH_SPACE', '(none)')))");
      expect(r2.ok).toBe(true);
      expect(r2.stdout).toContain("stamp2=");
      // single 模式 + space 不再炸（2026-08-12 审计 BUG-1：前缀注入在 eval 单表达式必 SyntaxError）
      const r3 = await k.execute("1 + 1", { exec: "single", space: "dev" });
      expect(r3.ok).toBe(true);
      expect(r3.value).toBe(2);
      // single 模式的盖章由 PY_RUNTIME 统一设置（eval 前 exec——协议级）——单表达式直接求值验证
      const r4 = await k.execute("globals().get('_PTH_SPACE', '(none)')", { exec: "single", space: "python" });
      expect(r4.ok).toBe(true);
      expect(r4.value).toBe("python");
    } finally {
      k.dispose();
    }
  });

  it("BashKernel execute 带 space → PTH_MEMORY_SPACE 生效", async () => {
    const k = new BashKernel({ timeoutMs: 10_000, lazySpawn: true });
    try {
      const r1 = await k.execute("echo stamp=$PTH_MEMORY_SPACE", { space: "python" });
      expect(r1.ok).toBe(true);
      expect(r1.stdout).toContain("stamp=python");
      // 无 space → 空
      const r2 = await k.execute("echo stamp2=$PTH_MEMORY_SPACE");
      expect(r2.ok).toBe(true);
      expect(r2.stdout).toContain("stamp2=");
    } finally {
      k.dispose();
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
