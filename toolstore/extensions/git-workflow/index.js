/// <reference path="../sdk.d.ts" />
// @ts-check
// git-workflow 扩展——git 助手（developer 族高频操作封装）
// 作用于 PTH 工作区仓库（worker 进程 cwd）；只读操作 status/diff/log + 受控写 commit。
module.exports = /** @type {PthExtFactory} */ async function factory(ctx) {
  const { execFile } = await import("node:child_process");
  /** @type {(args: string[], opts?: {cwd?: string}) => Promise<{ok: boolean; result?: string; error?: string}>} */
  const run = (args, opts) => new Promise((resolve) => {
    execFile("git", args, { cwd: opts?.cwd ?? process.cwd(), timeout: 15000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const e = /** @type {Error & {message: string}} */ (err);
        resolve(e ? { ok: false, error: (stderr || e.message).slice(0, 500) } : { ok: true, result: String(stdout).trim() });
      });
  });

  return {
    tools: {
      "git.status": async () => {
        const r = await run(["status", "--short"]);
        if (!r.ok) return r;
        return { ok: true, result: r.result || "(clean)" };
      },
      "git.diff": async (args) => {
        const filePath = String(args?.path ?? "").trim();
        const staged = args?.staged === true;
        const cmd = ["diff", ...(staged ? ["--cached"] : []), ...(filePath ? ["--", filePath] : [])];
        const r = await run(cmd);
        return r.ok ? { ok: true, result: r.result || "(no diff)" } : r;
      },
      "git.log": async (args) => {
        const n = Math.min(Math.max(Number(args?.n ?? 10) || 10, 1), 50);
        const r = await run(["log", "-" + n, "--oneline", "--decorate"]);
        return r.ok ? { ok: true, result: r.result || "(no commits)" } : r;
      },
      "git.commit": async (args) => {
        const message = String(args?.message ?? "").trim();
        if (!message) return { ok: false, error: "git.commit: message 必填" };
        if (message.length > 200) return { ok: false, error: "git.commit: message ≤200 字符" };
        const addAll = args?.all === true;
        const stage = addAll ? await run(["add", "-A"]) : { ok: true };
        if (!stage.ok) return stage;
        const r = await run(["commit", "-m", message]);
        return r.ok ? r : { ok: false, error: (r.error ?? "") + "（提交失败——无变更或冲突——先 git.status 确认）" };
      },
    },
    capabilities: {},
  };
};
