/**
 * exec-api-validation.ts —— /exec 请求校验 + workload 私有工作区准备（模块专项 ② 大文件拆分）。
 */
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { cp, mkdir, rm, chmod, chown, readdir, lstat } from "node:fs/promises";
import { ExecutionRequestError, validateExecutionRequest } from "@away_from/shared/execution";
import { workloadIdentity } from "./workload/environment.js";
import { loadSandboxConfig } from "./config.js";

// ─── 校验 ────────────────────────────────────────────────────────────
/**
 * cwd 白名单校验（F/WP3 Task 12，评审 WP3-R1 Important#1）：
 * 先用 fs.realpathSync 解析 symlink 再 startsWith 白名单根——防 symlink 逃逸：
 * 卷内 symlink 指向卷外 → realpath 后前缀不匹配 → 拒绝（400）。
 * 根与 cwd 双侧 realpath（根自身也可能经 symlink 挂载/解析）。
 */
export function existsForReady(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

export function validateCwd(cwdRaw: string | undefined, workspacesRoot: string): string {
  const root = path.resolve(workspacesRoot);
  const cwd = cwdRaw ? path.resolve(cwdRaw) : root;
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    // 根不存在时回退 resolve 结果（容器内卷挂载点必存在；测试显式传根）
    realRoot = root;
  }
  let realCwd: string;
  try {
    realCwd = fs.realpathSync(cwd);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`cwd does not exist: ${cwd}`);
    }
    throw new Error(`cwd cannot be resolved: ${cwd}`);
  }
  // realpath 后白名单校验（对称：realRoot 亦为 realpath 结果）
  if (realCwd !== realRoot && !realCwd.startsWith(realRoot + path.sep)) {
    throw new Error(`cwd must be within workspaces root: ${root}`);
  }
  return realCwd;
}

export function validateBody(
  body: unknown,
  defaultTimeoutMs: number,
  maxTimeoutMs: number,
  maxStdoutBytes: number,
  maxStderrBytes: number,
): { cmd: string | string[]; timeoutMs: number; maxStdoutBytes: number; maxStderrBytes: number } {
  const raw = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  // execution/v1 规范字段为 timeoutMs；保留旧字段 timeout 作为过渡别名（客户端迁移后移除）。
  const input = { ...raw };
  if (input.timeoutMs === undefined && typeof raw.timeout === "number") {
    input.timeoutMs = raw.timeout;
  }
  try {
    const normalized = validateExecutionRequest(input, {
      timeoutMs: defaultTimeoutMs,
      maxStdoutBytes,
      maxStderrBytes,
    });
    return {
      cmd: normalized.cmd,
      timeoutMs: Math.min(normalized.timeoutMs ?? defaultTimeoutMs, maxTimeoutMs),
      maxStdoutBytes: normalized.maxStdoutBytes ?? maxStdoutBytes,
      maxStderrBytes: normalized.maxStderrBytes ?? maxStderrBytes,
    };
  } catch (error) {
    if (error instanceof ExecutionRequestError) throw new Error(error.message);
    throw error;
  }
}

export async function chownRecursive(target: string, uid: number, gid: number): Promise<void> {
  const st = await lstat(target);
  if (st.isSymbolicLink()) return;
  await chown(target, uid, gid).catch(() => {});
  if (st.isDirectory()) {
    for (const name of await readdir(target)) {
      await chownRecursive(path.join(target, name), uid, gid);
    }
  }
}

/**
 * P0-3：workload 私有工作区。容器内 controller 以 root 运行时，把任务 cwd 拷贝到
 * /srv/workload/<uuid> 并 chown 给 workload UID；执行完把结果回拷到共享工作区，
 * 并 chown 回 PTH 属主（默认 node 1000）——workload 只看到自己的拷贝。
 * 宿主/测试环境非 root 时不启用（直接使用原 cwd）。
 */
export async function prepareWorkspace(
  cwd: string,
  privateRoot: string | undefined,
): Promise<{ execCwd: string; syncBack: () => Promise<string | null> }> {
  const identity = workloadIdentity();
  if (!privateRoot || (typeof process.getuid === "function" && process.getuid() !== 0)) {
    return { execCwd: cwd, syncBack: async () => null };
  }
  const execCwd = path.join(privateRoot, crypto.randomUUID());
  await mkdir(privateRoot, { recursive: true, mode: 0o711 });
  await mkdir(execCwd, { recursive: true, mode: 0o700 });
  if (identity.uid !== undefined && identity.gid !== undefined) {
    await chown(execCwd, identity.uid, identity.gid).catch(() => {});
  }
  await cp(cwd, execCwd, { recursive: true, force: true });
  await chmod(execCwd, 0o700);
  const cfg = loadSandboxConfig();
  const ownerUid = cfg.workspaceOwnerUid;
  const ownerGid = cfg.workspaceOwnerGid;
  const syncBack = async (): Promise<string | null> => {
    try {
      await cp(execCwd, cwd, { recursive: true, force: true });
      await chownRecursive(cwd, ownerUid, ownerGid);
      return null;
    } catch (err) {
      return `workspace sync-back failed: ${(err as Error).message}`;
    } finally {
      await rm(execCwd, { recursive: true, force: true }).catch(() => {});
    }
  };
  return { execCwd, syncBack };
}

