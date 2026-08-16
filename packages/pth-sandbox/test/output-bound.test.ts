import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { buildExecApp, PyKernel, BashKernel, CCompiledKernel } from "@away_from/pth-sandbox";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("P2-4：输出字节上限 + 进程组收割", () => {
  it("/exec：stdout 超限截断 + SIGKILL 进程组（exit 137）", async () => {
    const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "output-bound-exec-"));
    const app = buildExecApp({ workspacesRoot: wsRoot, getSecret: () => "s", maxStdoutBytes: 64, maxStderrBytes: 64, defaultTimeoutMs: 10_000 });
    const res = await app.inject({
      method: "POST",
      url: "/exec",
      headers: { authorization: "Bearer s" },
      payload: { cmd: ["node", "-e", "console.log('x'.repeat(1000))"] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.stdout.length).toBeLessThanOrEqual(64);
    expect(body.truncated).toMatchObject({ field: "stdout", keptLen: 64 });
    expect(body.exitCode).toBe(137); // 128+SIGKILL
    await app.close();
  });

  it("PyKernel：输出超限 → truncated + 进程被杀，下个 execute 自愈", async () => {
    const k = new PyKernel({ lazySpawn: true });
    const r1 = await k.execute("print('y' * 5000)", { maxStdout: 32 });
    expect(r1.truncated?.field).toBe("stdout");
    expect(r1.stdout.length).toBeLessThanOrEqual(32);
    const r2 = await k.execute("_result = 42");
    expect(r2.ok).toBe(true);
    expect(r2.value).toBe(42);
    k.dispose();
  });

  it("BashKernel：输出超限 → truncated + 会话重启可用", async () => {
    const k = new BashKernel({ lazySpawn: true });
    const r1 = await k.execute("printf 'z%.0s' {1..5000}", { maxStdout: 32 });
    expect(r1.truncated?.field).toBe("stdout");
    expect(r1.stdout.length).toBeLessThanOrEqual(32);
    const r2 = await k.execute("echo alive");
    expect(r2.ok).toBe(true);
    expect(r2.stdout).toContain("alive");
    k.dispose();
  });

  it("编译核：运行输出超限 → truncated", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "output-bound-c-"));
    const k = new CCompiledKernel({ workDir: dir, cacheDir: path.join(dir, ".cache"), cc: process.env.CC ?? "cc" });
    const source = `#include <stdio.h>\nint main(){for(int i=0;i<10000;i++)putchar('c');return 0;}`;
    const r = await k.execute(source, { timeoutMs: 20_000, maxStdout: 64 });
    expect(r.ok).toBe(true);
    expect(r.truncated?.field).toBe("stdout");
    expect(r.stdout.length).toBeLessThanOrEqual(64);
    k.reset();
  });
});
