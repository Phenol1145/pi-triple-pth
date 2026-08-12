import { describe, it, expect } from "vitest";
import { BashInterpreter } from "../../src/pth/impls/kernels/bash-interpreter";
import { SandboxForwardError, SANDBOX_ERROR_UNAVAILABLE } from "../../src/pth/tools/sandbox-bash";

/** mock SandboxExecClient（对齐 src/pth/tools/sandbox-bash.ts 的 exec 签名） */
function mockSandbox(impl?: (cmd: string, opts: any) => Promise<any>) {
  return {
    exec: async (req: any) => {
      if (impl) return impl(req.cmd, req);
      return { ok: true, stdout: `executed: ${req.cmd}`, stderr: "", exitCode: 0, durationMs: 1 };
    },
  } as any;
}

describe("bash interpreter", () => {
  it("executes program via sandbox", async () => {
    const sandbox = mockSandbox((cmd) => ({ ok: true, stdout: `ran ${cmd}`, stderr: "", exitCode: 0, durationMs: 5 }));
    const itp = new BashInterpreter({ sandbox });
    const res = await itp.execute("echo hello");
    expect(res.ok).toBe(true);
    expect(res.stdout).toContain("ran cd");
  });

  it("propagates cwd from execute options", async () => {
    let seenCwd: string | undefined;
    const sandbox = mockSandbox(async (cmd, opts) => {
      seenCwd = opts.cwd;
      return { ok: true, stdout: "", stderr: "", exitCode: 0, durationMs: 1 };
    });
    const itp = new BashInterpreter({ sandbox });
    await itp.execute("pwd", { cwd: "/data/workspaces/tasks/t1" });
    expect(seenCwd).toBe("/data/workspaces/tasks/t1");
  });

  it("returns error result on non-zero exit", async () => {
    const sandbox = mockSandbox(async () => ({ ok: false, stdout: "", stderr: "command not found", exitCode: 127, durationMs: 1 }));
    const itp = new BashInterpreter({ sandbox });
    const res = await itp.execute("nonexistent-cmd");
    expect(res.ok).toBe(false);
    expect(res.stderr).toContain("command not found");
  });

  it("reset restores default cwd on the same interpreter", async () => {
    // Finding #1 修复：旧测试新建 itp2（全新实例天然默认 cwd），reset 为 no-op 也能过。
    // 现改为同一 itp + 同一 sandbox，mock 记录每次调用的 opts.cwd——断言重置后下一次
    // execute 的 cwd 回到 /data/workspaces（若 reset no-op，第二次 cwd 仍是旧值 → 失败）。
    const seenCwds: Array<string | undefined> = [];
    const sandbox = mockSandbox(async (cmd, opts) => {
      seenCwds.push(opts.cwd);
      return { ok: true, stdout: "", stderr: "", exitCode: 0, durationMs: 1 };
    });
    const itp = new BashInterpreter({ sandbox });
    await itp.execute("cd /tmp", { cwd: "/data/workspaces/tasks/t1" });
    expect(seenCwds[0]).toBe("/data/workspaces/tasks/t1");
    itp.reset();
    await itp.execute("pwd");
    expect(seenCwds[1]).toBe("/data/workspaces");
  });

  it("surfaces sandbox forward error code", async () => {
    // Finding #2：真实 SandboxExecClient.exec 在 sandbox 不可达/超时时抛 SandboxForwardError
    // （code = sandbox-unavailable / sandbox-timeout）——断言结构化 code 随 error 字段透出。
    const sandbox = mockSandbox(async () => {
      throw new SandboxForwardError(SANDBOX_ERROR_UNAVAILABLE, "sandbox unreachable");
    });
    const itp = new BashInterpreter({ sandbox });
    const res = await itp.execute("echo hello");
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe(SANDBOX_ERROR_UNAVAILABLE);
  });
});
