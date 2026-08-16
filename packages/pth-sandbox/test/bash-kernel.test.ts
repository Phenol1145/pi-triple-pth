import { describe, it, expect, afterAll } from "vitest";
import { BashKernel } from "@away_from/pth-sandbox";

describe("BashKernel（持久 shell 会话）", () => {
  let k: BashKernel;
  afterAll(async () => { await k?.dispose(); });

  it("基本执行：stdout 捕获 + 退出码", async () => {
    k = new BashKernel();
    const r = await k.execute("echo hello-bash");
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("hello-bash");
  });

  it("cwd 持久：cd 后 pwd 记住（跨命令状态）", async () => {
    await k.execute("cd /tmp");
    const r = await k.execute("pwd");
    expect(r.ok).toBe(true);
    expect(r.stdout.trim()).toBe("/tmp");
  });

  it("变量持久：export 后跨命令可见", async () => {
    await k.execute("export MY_VAR=42");
    const r = await k.execute("echo $MY_VAR");
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("42");
  });

  it("命令错误 → ok:false + exitCode 语义（2>&1 报错进 stdout）", async () => {
    const r = await k.execute("ls /nonexistent-path-xyz 2>&1");
    expect(r.ok).toBe(false);
    expect(r.stdout).toContain("No such file");
  });

  it("多行脚本执行", async () => {
    const r = await k.execute("for i in 1 2 3; do echo item-$i; done");
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("item-1");
    expect(r.stdout).toContain("item-3");
  });

  it("S1-4：用户输出伪造固定旧标记不会提前结束（随机标记协议）", async () => {
    const r = await k.execute('echo "__BASH_DONE_0__"; echo real-after-forged-marker');
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("__BASH_DONE_0__");
    expect(r.stdout).toContain("real-after-forged-marker");
  });

  it("reset 清状态：cwd 回默认", async () => {
    await k.execute("cd /tmp");
    k.reset();
    const r = await k.execute("pwd");
    // 默认 cwd 是用户主目录或 /——验证不再 /tmp
    expect(r.stdout.trim()).not.toBe("/tmp");
  });

  it("snapshot 导出会话配置（cwd）", async () => {
    await k.execute("cd /tmp");
    const snap = await k.snapshot();
    expect(snap).toBeDefined();
    expect(Array.isArray(snap.variables)).toBe(true);
  });

  it("超时 kill：死循环命令 → 超时错误 + 会话重启可用", async () => {
    const r = await k.execute("while true; do sleep 1; done", { timeoutMs: 1500 });
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain("timed out");
    const r2 = await k.execute("echo after-timeout");
    expect(r2.ok).toBe(true);
    expect(r2.stdout).toContain("after-timeout");
  }, 20_000);
});

describe("记忆库 seed（2026-08-11 库化）", () => {
  it("memory_query/memory_get 函数已定义（spawn 时注入）", async () => {
    const { BashKernel } = await import("@away_from/pth-sandbox");
    const k = new BashKernel();
    const r = await k.execute("type memory_query | head -1; type memory_get | head -1");
    expect(r.stdout).toContain("memory_query is a function");
    expect(r.stdout).toContain("memory_get is a function");
    k.dispose();
  });
});

describe("BashKernel——程序级制动（A1 Phase 3 条目 11 abort 契约）", () => {
  it("abort 终止 in-flight 长命令——execute 快落地（不等 timeout）+ 自愈补位", async () => {
    const k = new BashKernel();
    const start = Date.now();
    const p = k.execute("sleep 60", { timeoutMs: 120_000 });
    await new Promise((r) => setTimeout(r, 400));   // 确保进入执行
    await k.abort();
    const r = await p;
    const elapsed = Date.now() - start;
    expect(r.ok).toBe(false);
    expect(r.stderr ?? "").toContain("aborted");
    expect(elapsed).toBeLessThan(10_000);   // 立即落地而非等 120s timeout
    // 自愈：abort 杀会话后，下个 execute 懒 spawn 新会话
    const r2 = await k.execute("echo alive");
    expect(r2.ok).toBe(true);
    expect(r2.stdout).toContain("alive");
    k.dispose();
  }, 20_000);

  it("abort 无 in-flight 时安全 no-op（不抛、不破坏后续执行）", async () => {
    const k = new BashKernel();
    await k.abort();
    const r = await k.execute("echo ok");
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("ok");
    k.dispose();
  }, 20_000);
});
