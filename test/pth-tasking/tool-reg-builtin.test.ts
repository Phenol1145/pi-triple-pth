import { describe, it, expect } from "vitest";
import {
  buildBuiltinToolRegEntries,
  buildBuiltinToolRegSpec,
  builtinExecutorRef,
  builtinToolRegRow,
  deriveVisibilityRoles,
  implicitFullFaceRoles,
  reconcileBuiltinToolRegs,
  toolPackOf,
} from "../../src/pth/tasking/tool-reg-builtin.js";
import { PTC_TOOL_DEFS } from "../../src/pth/kernel/ptc/tools.js";
import { AGENT_TOOLS } from "../../src/pth/kernel/execution/agent-tools-registry.js";
import { ASP_ONLY_TOOLS } from "../../src/pth/kernel/execution/agent-tools.js";
import { parseToolRegContent, type ToolRegSpec } from "@away_from/pth-memory";

describe("N14 P0：存量登记器（Q4 一次性全登记）", () => {
  it("33 条 builtin 条目 ≡ PTC_TOOL_DEFS 键集（顺序确定性）", () => {
    const { specs } = buildBuiltinToolRegEntries();
    expect(specs.map((s) => s.name)).toEqual(PTC_TOOL_DEFS.map((d) => d.name));
    expect(specs).toHaveLength(33);   // 2026-08-14 N8：asp.create/destroy 退役（35→33）——新增硬编码工具须同步本条
  });

  it("执行器引用约定：27 键直引 AGENT_TOOLS（含 done 兜底）/ ASP-only 6 件 asp-inline", () => {
    const { specs } = buildBuiltinToolRegEntries();
    const byName = new Map(specs.map((s) => [s.name, s]));
    for (const key of Object.keys(AGENT_TOOLS)) {
      const s = byName.get(key);
      expect(s, `AGENT_TOOLS 键 ${key} 应有条目`).toBeDefined();
      expect(s!.executor).toEqual({ type: "builtin", ref: key });
    }
    expect(Object.keys(AGENT_TOOLS)).toHaveLength(27);   // 26 点形执行器 + done 兜底
    for (const name of ["asp.cd", "asp.index", "memory.index", "cache.load", "cache.index", "cache.cancel"]) {
      expect(byName.get(name)?.executor).toEqual({ type: "builtin", ref: `asp-inline:${name}` });
      expect(ASP_ONLY_TOOLS.has(name)).toBe(true);
    }
    expect(builtinExecutorRef("ts.run")).toBe("ts.run");
    expect(builtinExecutorRef("done")).toBe("done");
  });

  it("包归属：TOOL_GROUPS 反查，done → core", () => {
    expect(toolPackOf("ts.run")).toBe("execTs");
    expect(toolPackOf("dev.build")).toBe("dev");
    expect(toolPackOf("debug.attach")).toBe("debug");
    expect(toolPackOf("write.section")).toBe("write");
    expect(toolPackOf("asp.cd")).toBe("nav");
    expect(toolPackOf("cache.load")).toBe("cache");
    expect(toolPackOf("done")).toBe("core");
  });

  it("visibility 现状推导：声明并集 + 隐式全面角色单独成列", () => {
    expect(implicitFullFaceRoles()).toEqual(["controller", "origin", "sensor"]);
    // dev.write 只有 dev 族角色：coder + debug-case-writer
    expect(deriveVisibilityRoles("dev.write")).toEqual(["coder", "debug-case-writer"]);
    // debug.attach 仅 debug-case-writer
    expect(deriveVisibilityRoles("debug.attach")).toEqual(["debug-case-writer"]);
    // ts.run：除 planner（只读）与 writer（文档族）外的全部声明角色；origin 不在内（隐式全面）
    const tsRun = deriveVisibilityRoles("ts.run");
    expect(tsRun).toContain("developer");
    expect(tsRun).toContain("coder");
    expect(tsRun).toContain("sensor:worker-opt");
    expect(tsRun).not.toContain("planner");
    expect(tsRun).not.toContain("writer");
    expect(tsRun).not.toContain("origin");
    // done 固定协议段——全声明角色可见
    const done = deriveVisibilityRoles("done");
    expect(done).toContain("planner");
    expect(done).toContain("writer");
    expect(done).toHaveLength(32);   // 声明 actionTools 的角色总数（14 DEFAULT + 5 MID + 13 GOVERNANCE——N14 P1 后）
  });

  it("双写一致性对账：生成集零 issue", () => {
    const { specs } = buildBuiltinToolRegEntries();
    const report = reconcileBuiltinToolRegs(specs);
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("对账有牙：缺条目 / 多条目 / ref 漂移 / 包漂移 / visibility 漂移 都能检出", () => {
    const { specs } = buildBuiltinToolRegEntries();
    // 缺条目
    const missing = specs.filter((s) => s.name !== "ts.run");
    expect(reconcileBuiltinToolRegs(missing).issues.join("\n")).toContain("缺条目：ts.run");
    // 多条目
    const extra = [...specs, { ...specs[0]!, name: "alien.tool", visibility: { roles: ["coder"], pack: "x" } } as ToolRegSpec];
    expect(reconcileBuiltinToolRegs(extra).issues.join("\n")).toContain("多条目：alien.tool");
    // ref 漂移
    const badRef = specs.map((s) => s.name === "ts.run" ? { ...s, executor: { type: "builtin", ref: "nonexistent.key" } } as ToolRegSpec : s);
    expect(reconcileBuiltinToolRegs(badRef).issues.join("\n")).toContain("ts.run");
    // 包漂移
    const badPack = specs.map((s) => s.name === "ts.run" ? { ...s, visibility: { ...s.visibility, pack: "wrong" } } : s);
    expect(reconcileBuiltinToolRegs(badPack).issues.join("\n")).toContain("包归属");
    // visibility 漂移
    const badVis = specs.map((s) => s.name === "dev.write" ? { ...s, visibility: { ...s.visibility, roles: ["coder"] } } : s);
    expect(reconcileBuiltinToolRegs(badVis).issues.join("\n")).toContain("visibility.roles");
  });

  it("生成条目全部通过 tool-reg 注册校验（§7-1 反向钉——登记器产物必然合法）", () => {
    const { specs, implicitFullFaceRoles: fullFace } = buildBuiltinToolRegEntries();
    for (const spec of specs) {
      const row = builtinToolRegRow(spec, fullFace);
      const parsed = parseToolRegContent(row.content);
      expect(parsed.ok, `tool:${spec.name} 生成内容应通过校验`).toBe(true);
      if (parsed.ok) expect(parsed.spec).toEqual(spec);
      expect(row.id).toBe(`tool:${spec.name}`);
      expect(row.kind).toBe("tool-reg");
      expect(row.status).toBe("official");
      expect(row.meta.implicitFullFace).toEqual(fullFace);
    }
  });

  it("幂等：两次生成逐字节一致（seed 跳过判定的基础）", () => {
    const a = buildBuiltinToolRegEntries();
    const b = buildBuiltinToolRegEntries();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("buildBuiltinToolRegSpec：未知工具名抛错", () => {
    expect(() => buildBuiltinToolRegSpec("no.such.tool")).toThrow();
  });
});
