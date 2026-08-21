/**
 * sandbox 执行 API 核心（F/WP3 Task 10）
 *
 * 职责：在隔离 sandbox 容器内执行任意命令并回传输出。安全边界：
 *  - 共享密钥认证（SANDBOX_SHARED_SECRET env 注入，非镜像硬编码）——fail-closed
 *  - cwd 白名单（resolve 后必须位于 workspacesRoot 下——路径穿越防御）
 *  - 超时强杀（detached 进程组 + SIGKILL 子树）
 *  - egress 锁定由 compose 内网（internal 网络）保证——本进程不提供出网通道
 *
 * 接口：
 *  - POST /exec            {cmd, cwd, env, timeout, stream?} → 同步执行 {stdout, stderr, exitCode, signal?, timedOut}
 *                          stream:true → 立即返回 {execId, status:"running"}（后台执行）
 *  - GET  /exec/:id        {status:"running"|"done", result?}（流式消费者轮询）
 *  - GET  /exec/:id/stream SSE：event: output（{stream,data}）+ event: done（{exitCode,timedOut}）——完成态可重放
 *  - GET  /health          {status:"ok"}（无认证——compose healthcheck 使用；网络仅内网可达）
 *
 * cmd 语义：字符串 → `bash -lc <cmd>`（sandbox 镜像内置 bash，见 Dockerfile.sandbox）；
 *          数组 → 直接 spawn argv（不经 shell）。
 */

import Fastify from "fastify";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { cp, mkdir, rm, chmod, chown, readdir, lstat } from "node:fs/promises";
import {
  EXECUTION_WIRE,
  type ExecutionCapabilities,
  type ExecutionRequest,
  type ExecutionResult,
} from "@away_from/shared/execution";
import { buildWorkloadEnv, workloadIdentity, WORKLOAD_HOME } from "./workload/environment.js";
import { loadSandboxConfig } from "./config.js";
import { existsForReady, validateCwd, validateBody, prepareWorkspace } from "./exec-api-validation.js";

// ─── 类型（execution/v1 对齐；保留旧名别名兼容内部调用） ─────────────────────
export type ExecRequest = ExecutionRequest;
export type ExecResult = ExecutionResult;

export interface ExecApiOptions {
  /** cwd 白名单根（默认 /data/workspaces——compose 共享卷路径约定，Task 12 统一） */
  workspacesRoot?: string;
  /** workload 私有工作区根（P0-3；容器内默认 /srv/workload——执行前拷贝进、执行后回拷） */
  privateRoot?: string;
  /** 共享密钥获取器（默认读 env SANDBOX_SHARED_SECRET——每次请求读取，测试可注入） */
  getSecret?: () => string | undefined;
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
  /** stdout 字节上限（默认 1MB） */
  maxStdoutBytes?: number;
  /** stderr 字节上限（默认 1MB） */
  maxStderrBytes?: number;
  /** P2-6：/ready 的额外就绪检查（如 kernel grant verifier 是否装配） */
  readinessChecks?: Array<{ name: string; check: () => boolean | Promise<boolean> }>;
}

// ─── 流式任务注册表 ────────────────────────────────────────────────
interface StreamJob {
  id: string;
  stdout: string[];
  stderr: string[];
  stdoutBytes: number;
  stderrBytes: number;
  /** P2-4：输出超限杀组标记（close 收尾时组装 truncated） */
  killedForLimit: "stdout" | "stderr" | null;
  listeners: Set<(stream: "stdout" | "stderr", data: string) => void>;
  /** S1-4：完成通知订阅者集合——每个 SSE 订阅独立收到 done，不再单槽覆盖 */
  doneCallbacks: Set<() => void>;
  proc: ChildProcess | null;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  finished: boolean;
  /** 完成后的 execution/v1 结果（含 truncated），供 GET /exec/:id 回放 */
  result?: ExecutionResult;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
}

function createJob(id: string): StreamJob {
  return {
    id,
    stdout: [],
    stderr: [],
    stdoutBytes: 0,
    stderrBytes: 0,
    killedForLimit: null,
    listeners: new Set(),
    doneCallbacks: new Set(),
    proc: null,
    exitCode: null,
    signal: null,
    timedOut: false,
    finished: false,
    result: undefined,
    cleanupTimer: null,
  };
}

function emitChunk(job: StreamJob, stream: "stdout" | "stderr", data: string): void {
  for (const l of [...job.listeners]) l(stream, data);
}

/** 任务完成：通知全部流式消费者 + 延迟清注册表（防内存泄漏；unref 不阻塞进程退出） */
function finishJob(job: StreamJob, jobs: Map<string, StreamJob>): void {
  job.finished = true;
  for (const cb of [...job.doneCallbacks]) cb();
  job.doneCallbacks.clear();
  job.listeners.clear();
  if (job.cleanupTimer) clearTimeout(job.cleanupTimer);
  job.cleanupTimer = setTimeout(() => jobs.delete(job.id), 60_000);
  job.cleanupTimer.unref();
}

/** 'close' 事件 (code, signal) → 统一 exitCode（被信号杀时 128+signal 号，如 SIGKILL→137） */
function exitCodeFromClose(code: number | null, signal: string | null): number | null {
  if (code !== null) return code;
  if (signal) {
    const num = (os.constants.signals as Record<string, number>)[signal];
    if (typeof num === "number") return 128 + num;
  }
  return null;
}

// ─── 执行 ────────────────────────────────────────────────────────────
function runExec(
  job: StreamJob,
  opts: { cmd: string | string[]; cwd: string; env?: Record<string, string>; timeoutMs: number; maxStdoutBytes: number; maxStderrBytes: number },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const cmdArray = Array.isArray(opts.cmd) ? opts.cmd : ["bash", "-lc", opts.cmd];
    const identity = workloadIdentity();
    const child = spawn(cmdArray[0], cmdArray.slice(1), {
      cwd: opts.cwd,
      env: buildWorkloadEnv({ ...(identity.uid ? { HOME: WORKLOAD_HOME } : {}), ...(opts.env ?? {}) }),
      ...identity,
      // detached：子进程独立进程组 → 超时用 kill(-pid, SIGKILL) 强杀整个子树
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    job.proc = child;

    const decOut = new StringDecoder("utf-8");
    const decErr = new StringDecoder("utf-8");
    const killForLimit = (field: "stdout" | "stderr") => {
      if (job.killedForLimit) return true;
      job.killedForLimit = field;
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* 子进程已退出 */ }
      return true;
    };
    child.stdout.on("data", (buf: Buffer) => {
      const s = decOut.write(buf);
      if (!s) return;
      const remaining = opts.maxStdoutBytes - job.stdoutBytes;
      if (remaining <= 0) { killForLimit("stdout"); return; }
      const keep = s.slice(0, Math.max(0, remaining));
      job.stdoutBytes += keep.length;
      job.stdout.push(keep);
      emitChunk(job, "stdout", keep);
      if (keep.length < s.length) killForLimit("stdout");
    });
    child.stderr.on("data", (buf: Buffer) => {
      const s = decErr.write(buf);
      if (!s) return;
      const remaining = opts.maxStderrBytes - job.stderrBytes;
      if (remaining <= 0) { killForLimit("stderr"); return; }
      const keep = s.slice(0, Math.max(0, remaining));
      job.stderrBytes += keep.length;
      job.stderr.push(keep);
      emitChunk(job, "stderr", keep);
      if (keep.length < s.length) killForLimit("stderr");
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        // 强杀进程组（含子进程的子孙）
        process.kill(-child.pid!, "SIGKILL");
      } catch { /* 子进程已退出——忽略 ESRCH */ }
    }, opts.timeoutMs);
    timer.unref();

    child.on("error", (err) => {
      // spawn 失败（如 argv 首项二进制不存在）——按 exit 127 语义回传，不中断注册表
      clearTimeout(timer);
      const outTail = decOut.end();
      const errTail = decErr.end();
      if (outTail) { job.stdout.push(outTail); emitChunk(job, "stdout", outTail); }
      if (errTail) { job.stderr.push(errTail); emitChunk(job, "stderr", errTail); }
      job.stderr.push(`spawn error: ${err.message}`);
      job.exitCode = 127;
      job.signal = null;
      job.timedOut = timedOut;
      // 不在此 finishJob——由调用方（sync POST await 后 / stream then）统一收尾
      resolve({ stdout: job.stdout.join(""), stderr: job.stderr.join(""), exitCode: 127, signal: null, timedOut });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const outTail = decOut.end();
      const errTail = decErr.end();
      if (outTail) { job.stdout.push(outTail); emitChunk(job, "stdout", outTail); }
      if (errTail) { job.stderr.push(errTail); emitChunk(job, "stderr", errTail); }
      job.exitCode = exitCodeFromClose(code, signal);
      job.signal = signal;
      job.timedOut = timedOut;
      resolve({
        stdout: job.stdout.join(""),
        stderr: job.stderr.join(""),
        exitCode: job.exitCode,
        signal,
        timedOut,
        ...(job.killedForLimit
          ? { truncated: { field: job.killedForLimit, originalLen: job.killedForLimit === "stdout" ? job.stdoutBytes : job.stderrBytes, keptLen: job.killedForLimit === "stdout" ? job.stdout.join("").length : job.stderr.join("").length } }
          : {}),
      });
    });
  });
}

// ─── app 构建 ────────────────────────────────────────────────────────
export function buildExecApp(options: ExecApiOptions = {}): FastifyInstance {
  const workspacesRoot = path.resolve(options.workspacesRoot ?? "/data/workspaces");
  const privateRoot = options.privateRoot ?? loadSandboxConfig().execPrivateRoot;
  const getSecret = options.getSecret ?? (() => process.env.SANDBOX_SHARED_SECRET);
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
  const maxOutBytes = options.maxStdoutBytes ?? 1024 * 1024;
  const maxErrBytes = options.maxStderrBytes ?? 1024 * 1024;
  const maxTimeoutMs = options.maxTimeoutMs ?? 600_000;

  const jobs = new Map<string, StreamJob>();
  const app = Fastify({ logger: false, bodyLimit: 6 * 1024 * 1024 });

  const capabilities: ExecutionCapabilities = {
    version: EXECUTION_WIRE.version,
    streaming: true,
    cancel: true,
    cwdWhitelist: true,
    uidIsolation: true,
    egressLocked: true,
    pathMapping: false,
  };

  // S1-4：shutdown dispose——app.close() 时终止全部在飞 stream 子进程并清注册表
  app.addHook("onClose", async () => {
    for (const job of jobs.values()) {
      if (job.cleanupTimer) clearTimeout(job.cleanupTimer);
      if (job.proc && job.proc.exitCode === null) {
        try { job.proc.kill("SIGKILL"); } catch { /* 忽略 */ }
      }
      job.finished = true;
      job.doneCallbacks.clear();
      job.listeners.clear();
    }
    jobs.clear();
  });

  type AuthResult = "ok" | "unauthorized" | "misconfigured";
  function checkAuth(req: FastifyRequest): AuthResult {
    const secret = getSecret();
    if (!secret) return "misconfigured";
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : header;
    return token === secret ? "ok" : "unauthorized";
  }
  function enforceAuth(req: FastifyRequest, reply: any): boolean {
    const auth = checkAuth(req);
    if (auth === "ok") return true;
    if (auth === "misconfigured") {
      reply.code(503).send({ error: "server misconfigured: SANDBOX_SHARED_SECRET not set" });
    } else {
      reply.code(401).send({ error: "unauthorized" });
    }
    return false;
  }

  app.get(EXECUTION_WIRE.paths.health, async () => ({ status: "ok" }));

  // execution/v1：能力声明（与 /exec 同样受共享密钥保护；能力无敏感信息）
  app.get(EXECUTION_WIRE.paths.capabilities, async (req, reply) => {
    if (!enforceAuth(req, reply)) return;
    return capabilities;
  });

  // P2-6：liveness/readiness 拆分。/health 只做 liveness（进程活着）；
  // /ready 检查执行前置条件：共享密钥、工作区根、私有根（若启用）与调用方额外检查。
  app.get("/ready", async (req, reply) => {
    const checks = [
      { name: "shared-secret", ok: Boolean(getSecret()) },
      { name: "workspaces-root", ok: existsForReady(workspacesRoot) },
      ...(privateRoot ? [{ name: "private-root", ok: existsForReady(privateRoot) }] : []),
    ];
    for (const extra of options.readinessChecks ?? []) {
      try {
        checks.push({ name: extra.name, ok: await extra.check() });
      } catch {
        checks.push({ name: extra.name, ok: false });
      }
    }
    const ready = checks.every((c) => c.ok);
    reply.code(ready ? 200 : 503);
    return { status: ready ? "ready" : "degraded", checks };
  });

  app.post(EXECUTION_WIRE.paths.exec, async (req, reply) => {
    if (!enforceAuth(req, reply)) return;
    const rawBody = (req.body ?? {}) as Record<string, unknown>;
    // 信任档由 backend 强制：sandbox 只接受未声明或 sandbox-untrusted；
    // 客户端声明 host/dev-container 一律拒绝（不得自我提升）。
    if (rawBody.profile !== undefined && rawBody.profile !== "sandbox-untrusted") {
      reply.code(400).send({ error: "profile must be sandbox-untrusted on this backend" });
      return;
    }
    if (rawBody.pathMapping !== undefined) {
      reply.code(400).send({ error: "pathMapping is not supported by sandbox backend" });
      return;
    }
    let cmd: string | string[];
    let timeoutMs: number;
    let maxStdoutBytes: number;
    let maxStderrBytes: number;
    try {
      ({ cmd, timeoutMs, maxStdoutBytes, maxStderrBytes } = validateBody(req.body, defaultTimeoutMs, maxTimeoutMs, maxOutBytes, maxErrBytes));
    } catch (err) {
      reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
    let cwd: string;
    try {
      cwd = validateCwd((req.body as ExecRequest | undefined)?.cwd, workspacesRoot);
    } catch (err) {
      reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
    const body = req.body as ExecRequest;
    let execCwd: string;
    let syncBack: () => Promise<string | null>;
    try {
      ({ execCwd, syncBack } = await prepareWorkspace(cwd, privateRoot));
    } catch (err) {
      reply.code(500).send({ error: `workspace prepare failed: ${(err as Error).message}` });
      return;
    }
    const job = createJob(crypto.randomUUID());
    jobs.set(job.id, job);
    const resultPromise = runExec(job, { cmd, cwd: execCwd, env: body.env, timeoutMs, maxStdoutBytes, maxStderrBytes });
    if (body.stream) {
      resultPromise.then(async (r) => {
        const syncErr = await syncBack();
        if (syncErr) r.stderr = `${r.stderr}\n${syncErr}`;
        job.result = { ...r, execId: job.id };
        finishJob(job, jobs);
      });
      return { execId: job.id, status: "running" };
    }
    const result = await resultPromise;
    const syncErr = await syncBack();
    if (syncErr) result.stderr = `${result.stderr}\n${syncErr}`;
    job.result = { ...result, execId: job.id };
    finishJob(job, jobs);
    return job.result;
  });

  app.post<{ Params: { id: string } }>(EXECUTION_WIRE.paths.cancel, async (req, reply) => {
    if (!enforceAuth(req, reply)) return;
    const job = jobs.get(req.params.id);
    if (!job) { reply.code(404).send({ error: "job not found" }); return; }
    if (!job.finished && job.proc && job.proc.pid !== undefined) {
      try {
        // 终止整个进程组（含子孙）——execution/v1 的 cancel 是尽力语义
        process.kill(-job.proc.pid, "SIGKILL");
      } catch { /* 子进程已退出 */ }
    }
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>(EXECUTION_WIRE.paths.job, async (req, reply) => {
    if (!enforceAuth(req, reply)) return;
    const job = jobs.get(req.params.id);
    if (!job) { reply.code(404).send({ error: "job not found" }); return; }
    if (!job.finished) return { status: "running", execId: job.id };
    return {
      status: "done",
      execId: job.id,
      result: job.result ?? {
        stdout: job.stdout.join(""),
        stderr: job.stderr.join(""),
        exitCode: job.exitCode,
        signal: job.signal,
        timedOut: job.timedOut,
      },
    };
  });

  app.get<{ Params: { id: string } }>(EXECUTION_WIRE.paths.stream, (req, reply) => {
    if (!enforceAuth(req, reply)) return;
    const job = jobs.get(req.params.id);
    if (!job) { reply.code(404).send({ error: "job not found" }); return; }

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const writeEvent = (event: string, data: unknown) => {
      raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onOutput = (stream: "stdout" | "stderr", data: string) =>
      writeEvent(EXECUTION_WIRE.events.output, { stream, data });
    const onDone = () => {
      writeEvent(EXECUTION_WIRE.events.done, { exitCode: job.exitCode, signal: job.signal, timedOut: job.timedOut });
      raw.end();
    };
    const replay = () => {
      for (const s of job.stdout) onOutput("stdout", s);
      for (const s of job.stderr) onOutput("stderr", s);
    };

    if (job.finished) {
      replay();
      onDone();
      return;
    }
    const push = (stream: "stdout" | "stderr", data: string) => onOutput(stream, data);
    job.listeners.add(push);
    const doneCb = () => {
      job.listeners.delete(push);
      onDone();
    };
    job.doneCallbacks.add(doneCb);
    // 订阅期间完成（竞态）→ 直接终结
    if (job.finished) {
      job.doneCallbacks.delete(doneCb);
      job.listeners.delete(push);
      onDone();
    }
    raw.on("close", () => {
      job.listeners.delete(push);
      job.doneCallbacks.delete(doneCb);
    });
  });

  return app;
}
