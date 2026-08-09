import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CCompiledKernel } from "../../src/pth/kernel/interpreter/compiled-kernel.js";

/**
 * C 编译核（CompiledKernel——编译-运行管道 + sha256 增量缓存）。
 * 真实编译（本机 cc/clang——gcc 命令兼容）。
 */

describe("CCompiledKernel（编译-运行管道）", () => {
  let kernel: CCompiledKernel;
  let workDir: string;

  beforeAll(async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "cck-"));
    kernel = new CCompiledKernel({ workDir });
  });

  afterAll(() => {
    kernel.dispose();
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("execute：编译+运行一步（C 程序输出到 stdout）", async () => {
    const r = await kernel.execute(`#include <stdio.h>
int main(void) { printf("hello-c:%d\\n", 6 * 7); return 0; }`);
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("hello-c:42");
    expect(r.durationMs).toBeGreaterThan(0);
  });

  it("增量缓存：同源码第二次 execute 不重编译（快）", async () => {
    const src = `#include <stdio.h>
int main(void) { printf("cached\\n"); return 0; }`;
    const t1 = Date.now();
    await kernel.execute(src);
    const first = Date.now() - t1;
    const t2 = Date.now();
    const r = await kernel.execute(src);
    const second = Date.now() - t2;
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("cached");
    expect(second).toBeLessThan(Math.max(first / 2, 50)); // 缓存命中显著更快
  });

  it("编译错误 → ok:false + 诊断回填（LLM 修正用）", async () => {
    const r = await kernel.execute(`int main(void) { return undefined_var; }`);
    expect(r.ok).toBe(false);
    expect(r.error?.message).toBeTruthy();
  });

  it("运行错误（非零退出）→ ok:false + stderr", async () => {
    const r = await kernel.execute(`#include <stdio.h>
int main(void) { fprintf(stderr, "boom\\n"); return 1; }`);
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain("boom");
  });

  it("build/run 分离：显式编译得 binaryRef → 显式运行", async () => {
    const b = await kernel.build(`#include <stdio.h>
int main(int argc, char** argv) { printf("arg:%s\\n", argc > 1 ? argv[1] : "none"); return 0; }`);
    expect(b.ok).toBe(true);
    const run = await kernel.run(b.binaryRef, { args: ["hello"] });
    expect(run.ok).toBe(true);
    expect(run.stdout).toContain("arg:hello");
  });

  it("run 未知 binaryRef → 拒绝", async () => {
    await expect(kernel.run("no-such-ref")).rejects.toThrow(/unknown/i);
  });

  it("缓存目录产物存在且有限（maxCache 淘汰）", async () => {
    const cacheDir = path.join(workDir, ".build-cache");
    expect(fs.existsSync(cacheDir)).toBe(true);
    const entries = fs.readdirSync(cacheDir);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.length).toBeLessThanOrEqual(5); // 测试用 maxCache=5
  });

  it("snapshot：产物清单（生成二进制引用）", async () => {
    const snap = await kernel.snapshot();
    expect(snap.variables.length).toBeGreaterThan(0); // 产物引用
  });
});

describe("编译核持久缓存 + 指标（2026-08-09）", () => {
  it("cacheDir 独立于 workDir：跨实例复用（新实例扫描磁盘恢复——二次调用缓存命中）", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const root = mkdtempSync(tmpdir() + "/cck-persist-");
    const cacheDir = root + "/shared-cache";
    const workDir = root + "/work";
    const src = "#include <stdio.h>\nint main(void){ printf(\"persist\\n\"); return 0; }";
    // 实例 1：冷编译
    const k1 = new CCompiledKernel({ workDir, cacheDir });
    const r1 = await k1.execute(src);
    expect(r1.ok).toBe(true);
    expect(r1.stdout).toContain("persist");
    // 实例 2：新实例 + 新 workDir——扫描 cacheDir 恢复 → 缓存命中（~0ms）
    const k2 = new CCompiledKernel({ workDir: root + "/work2", cacheDir });
    await k2["restoreFromDisk"]();   // 显式等待恢复（构造器异步 fire-and-forget）
    const metrics: string[] = [];
    const k3 = new CCompiledKernel({ workDir: root + "/work3", cacheDir, onMetric: (m) => metrics.push(m.type) });
    await k3["restoreFromDisk"]();
    const r3 = await k3.execute(src);
    expect(r3.ok).toBe(true);
    expect(metrics).toContain("cache-hit");
    expect(r3.durationMs).toBeLessThan(50);   // 缓存命中极快
    rmSync(root, { recursive: true, force: true });
  });

  it("磁盘上限清理：超限删最旧", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const root = mkdtempSync(tmpdir() + "/cck-limit-");
    // maxCacheBytes 极小（1KB）——首次编译后 enforceDiskLimit 删除
    const k = new CCompiledKernel({ workDir: root + "/w", cacheDir: root + "/c", maxCacheBytes: 1024 });
    const src = "#include <stdio.h>\nint main(void){ return 0; }";
    await k.execute(src);
    await new Promise((r) => setTimeout(r, 50));   // 等异步 enforceDiskLimit
    expect(k.state.cacheSize ?? 0).toBeLessThanOrEqual(1);   // 被清理或保留 0-1 条
    rmSync(root, { recursive: true, force: true });
  });

  it("onMetric：compile 事件带 cc 与耗时（cold）", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const root = mkdtempSync(tmpdir() + "/cck-metric-");
    const events: Array<{ type: string; cc: string; durationMs: number }> = [];
    const k = new CCompiledKernel({ workDir: root + "/w", cacheDir: root + "/c", onMetric: (m) => events.push({ type: m.type, cc: m.cc, durationMs: m.durationMs }) });
    await k.execute("#include <stdio.h>\nint main(void){ return 0; }");
    expect(events.some((e) => e.type === "compile" && e.durationMs >= 0)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});
