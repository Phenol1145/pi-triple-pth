import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import {
  detachedStatus,
  spawnDetached,
  stopDetached,
} from "../../src/cli/runtime/process-supervisor.js";

async function makeRunDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pth-supervisor-"));
}

describe("spawnDetached / detachedStatus", () => {
  it("写入 pidfile 并可检测存活", async () => {
    const runDir = await makeRunDir();
    const calls: string[] = [];
    const result = await spawnDetached({
      name: "demo",
      cmd: "node",
      args: ["-e", "setInterval(()=>{},1000)"],
      env: {},
      runDir,
      spawnFn: (cmd, args, opts) => {
        calls.push(`${cmd} ${args.join(" ")} detached=${opts.detached}`);
        return { pid: 12345, unref: () => undefined } as unknown as ChildProcess;
      },
    });
    expect(result.pid).toBe(12345);
    expect(await readFile(join(runDir, "demo.pid"), "utf8")).toBe("12345");
    expect(calls).toContain("node -e setInterval(()=>{},1000) detached=true");

    const alive = await detachedStatus("demo", {
      runDir,
      killFn: (pid) => pid === 12345,
    });
    expect(alive).toEqual({ running: true, pid: 12345 });
  });

  it("pidfile 缺失/pid 已死 → not running 并清理 pidfile", async () => {
    const runDir = await makeRunDir();
    expect(await detachedStatus("missing", { runDir })).toEqual({ running: false });
    await spawnDetached({
      name: "dead",
      cmd: "node",
      args: [],
      env: {},
      runDir,
      spawnFn: () => ({ pid: 999, unref: () => undefined }) as unknown as ChildProcess,
    });
    const dead = await detachedStatus("dead", { runDir, killFn: () => false });
    expect(dead).toEqual({ running: false });
    await expect(readFile(join(runDir, "dead.pid"), "utf8")).rejects.toThrow();
  });
});

describe("stopDetached", () => {
  it("已死 pid 幂等清理", async () => {
    const runDir = await makeRunDir();
    await spawnDetached({
      name: "gone",
      cmd: "node",
      args: [],
      env: {},
      runDir,
      spawnFn: () => ({ pid: 1, unref: () => undefined }) as unknown as ChildProcess,
    });
    await stopDetached("gone", { runDir, killFn: () => false, signalWaitMs: 10 });
    await expect(readFile(join(runDir, "gone.pid"), "utf8")).rejects.toThrow();
  });

  it("SIGTERM 宽限后未退出 → SIGKILL 升级并清理", async () => {
    const runDir = await makeRunDir();
    const signals: string[] = [];
    await spawnDetached({
      name: "stubborn",
      cmd: "node",
      args: [],
      env: {},
      runDir,
      spawnFn: () => ({ pid: 42, unref: () => undefined }) as unknown as ChildProcess,
    });
    await stopDetached("stubborn", {
      runDir,
      signalWaitMs: 20,
      killFn: (pid, signal) => {
        signals.push(String(signal));
        if (signal === 0 || signal === "SIGTERM") return true;
        return false;
      },
    });
    const nonZero = signals.filter((s) => s !== "0");
    expect(nonZero).toContain("SIGTERM");
    expect(nonZero).toContain("SIGKILL");
    await expect(readFile(join(runDir, "stubborn.pid"), "utf8")).rejects.toThrow();
  });
});
