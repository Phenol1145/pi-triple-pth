import { describe, it, expect } from "vitest";
import { BashInterpreter } from "../../src/pth/kernel/interpreter/bash-interpreter";

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

  it("reset restores default cwd", async () => {
    const sandbox = mockSandbox();
    const itp = new BashInterpreter({ sandbox });
    await itp.execute("cd /tmp", { cwd: "/data/workspaces/tasks/t1" });
    itp.reset();
    // 重置后 cwd 回到默认
    let seenCwd: string | undefined;
    const sandbox2 = mockSandbox(async (cmd, opts) => { seenCwd = opts.cwd; return { ok: true, stdout: "", stderr: "", exitCode: 0, durationMs: 1 }; });
    const itp2 = new BashInterpreter({ sandbox: sandbox2 });
    await itp2.execute("pwd");
    expect(seenCwd).toBe("/data/workspaces");
  });
});
