import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createToolstore } from "@away_from/pth-kernel-interpreter";
import { AGENT_TOOLS } from "@away_from/pth-kernel-execution";

// 2026-08-11 生产核裁决迁移：c.saveUnit/executeUnit/listUnits 能力函数撤销 →
// dev 空间动作工具（dev.write/dev.save/dev.list/dev.run）——toolstore 单元机制不变
describe("命名编译单元（生产核 dev.* 工具——toolstore 持久化）", () => {
  let dir: string;
  let toolstore: ReturnType<typeof createToolstore>;

  const fakeC = (executed: string[]) => ({
    language: "c",
    execute: async (code: string) => { executed.push(code); return { ok: true, value: "ran", stdout: "ran", durationMs: 1 }; },
    state: {}, reset() {}, dispose() {},
    snapshot: async () => ({ variables: [], functions: [], oversized: [] }),
  });

  const ctxOf = (executed: string[]) => ({
    kernel: { c: fakeC(executed) } as never,
    caps: {},
    taskWorkspace: dir,
    toolstore,
  });

  beforeAll(async () => {
    dir = await mkdtemp(tmpdir() + "/cu-");
    toolstore = createToolstore(dir);
  });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it("dev.write → dev.save → dev.list → dev.run 全链路", async () => {
    const executed: string[] = [];
    const ctx = ctxOf(executed);
    const src = "int fib(int n){ return n < 2 ? n : fib(n-1) + fib(n-2); }\nint main(){ printf(\"%d\", fib(20)); }";
    // dev.write（产物落工作区）
    const w = await AGENT_TOOLS["dev.write"](ctx, { path: "fib.c", code: src });
    expect(w.ok).toBe(true);
    // dev.save（工作区产物 → 命名编译单元）
    const sv = await AGENT_TOOLS["dev.save"](ctx, { name: "fib", path: "fib.c" });
    expect(sv.ok).toBe(true);
    // dev.list
    const l = await AGENT_TOOLS["dev.list"](ctx, {});
    expect(l.value as string[]).toContain("fib");
    // dev.run（读工作区 → kernel.c 编译运行）
    const r = await AGENT_TOOLS["dev.run"](ctx, { path: "fib.c" });
    expect(r.ok).toBe(true);
    expect(executed[0]).toContain("fib(20)");
    // 单元持久化可读（跨任务语义——toolstore 层不变）
    const persisted = await toolstore.readText("compiled-units/fib.c");
    expect(persisted).toContain("fib(20)");
  });

  it("非法单元名拒绝（路径注入防护）", async () => {
    const ctx = ctxOf([]);
    await AGENT_TOOLS["dev.write"](ctx, { path: "x.c", code: "int main(){return 0;}" });
    const r1 = await AGENT_TOOLS["dev.save"](ctx, { name: "../../etc/passwd", path: "x.c" });
    expect(r1.ok).toBe(false);
    expect(r1.error).toMatch(/非法单元名/);
    const r2 = await AGENT_TOOLS["dev.save"](ctx, { name: "a/b", path: "x.c" });
    expect(r2.ok).toBe(false);
    expect(r2.error).toMatch(/非法单元名/);
  });

  it("产物路径白名单（拒绝绝对路径/穿越）", async () => {
    const ctx = ctxOf([]);
    await expect(AGENT_TOOLS["dev.write"](ctx, { path: "/etc/evil.c", code: "x" })).rejects.toThrow(/相对路径/);
    await expect(AGENT_TOOLS["dev.write"](ctx, { path: "../evil.c", code: "x" })).rejects.toThrow(/相对路径/);
  });

  it("saveUnit 持久化后 toolstore.readText 可读（跨任务语义）", async () => {
    await toolstore.writeText("compiled-units/direct.c", "int main(){ return 42; }");
    const code = await toolstore.readText("compiled-units/direct.c");
    expect(code).toContain("return 42");
  });
});
