/**
 * framework/execution/local-spawn-backend.ts —— P2 本地执行器驱动面。
 *
 * execution/v1.1 的 host spawn 后端：
 *  - sync 复用 shared LocalBackend（超时杀组 / 输出上限）；
 *  - stream 自实现 startJob（outputSnapshot 回放 + 订阅 + 进程组强杀）；
 *  - pathMapping：仅接受已登记映射（请求自带 mapping 或构造登记的第一条），
 *    cwd 翻译后交给本地 spawn——未登记 cwd 一律 CWD_NOT_ALLOWED。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import os from "node:os";
import { randomUUID } from "node:crypto";
import {
  ExecutionClientError,
  LocalBackend,
  EXECUTION_PROTOCOL_VERSION_V11,
  EXECUTION_WIRE,
  resolveExecutionMode,
  validateExecutionRequest,
  type ExecutionCapabilities,
  type ExecutionJob,
  type ExecutionJobBackend,
  type ExecutionJobHandlers,
  type ExecutionJobOutput,
  type ExecutionPathMapping,
  type ExecutionRequest,
  type ExecutionResult,
} from "@away_from/shared/execution";

export interface LocalSpawnBackendOptions {
  defaultTimeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  /** 已登记 pathMapping（请求自带 mapping 优先；都不存在且带 cwd → CWD_NOT_ALLOWED） */
  mappings?: readonly ExecutionPathMapping[];
}

const CAPABILITIES: ExecutionCapabilities = {
  version: EXECUTION_PROTOCOL_VERSION_V11,
  streaming: true,
  cancel: true,
  cwdWhitelist: false,
  uidIsolation: false,
  egressLocked: false,
  pathMapping: true,
  modes: { sync: true, stream: true, interactive: false, persistent: false },
};

function signalExitCode(signalName: string): number {
  return 128 + ((os.constants.signals as Record<string, number>)[signalName] ?? 1);
}

/** spawn 出的 stream 任务（输出缓冲 + 订阅 + 取消） */
class LocalSpawnJob implements ExecutionJob {
  readonly execId = randomUUID();
  status: "running" | "done" = "running";
  private readonly outputs: ExecutionJobOutput[] = [];
  private readonly handlers = new Set<ExecutionJobHandlers>();
  private result: ExecutionResult | undefined;
  private settled = false;

  constructor(
    private readonly child: ChildProcess,
    private readonly limits: { timeoutMs: number; maxStdoutBytes: number; maxStderrBytes: number },
  ) {
    const decOut = new StringDecoder("utf8");
    const decErr = new StringDecoder("utf8");
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated: ExecutionResult["truncated"];
    let killedForLimit: "stdout" | "stderr" | null = null;
    let timedOut = false;

    const killGroup = () => {
      try { process.kill(-this.child.pid!, "SIGKILL"); } catch { /* 已退出 */ }
    };
    const killForLimit = (field: "stdout" | "stderr") => {
      if (killedForLimit) return;
      killedForLimit = field;
      truncated = { field, originalLen: field === "stdout" ? stdoutBytes : stderrBytes, keptLen: 0 };
      killGroup();
    };
    const handleData = (buf: Buffer, field: "stdout" | "stderr") => {
      const text = field === "stdout" ? decOut.write(buf) : decErr.write(buf);
      if (!text) return;
      const limit = field === "stdout" ? this.limits.maxStdoutBytes : this.limits.maxStderrBytes;
      const used = field === "stdout" ? stdoutBytes : stderrBytes;
      const keep = text.slice(0, Math.max(0, limit - used));
      if (field === "stdout") {
        stdoutBytes += keep.length;
      } else {
        stderrBytes += keep.length;
      }
      if (keep.length > 0) {
        const event: ExecutionJobOutput = { stream: field, data: keep };
        this.outputs.push(event);
        for (const h of [...this.handlers]) h.onOutput?.({ stream: field, data: keep });
      }
      if (keep.length < text.length) killForLimit(field);
    };

    child.stdout?.on("data", (buf: Buffer) => handleData(buf, "stdout"));
    child.stderr?.on("data", (buf: Buffer) => handleData(buf, "stderr"));

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, this.limits.timeoutMs);
    timer.unref();

    child.on("close", (code, signalName) => {
      clearTimeout(timer);
      const tailOut = decOut.end();
      const tailErr = decErr.end();
      if (tailOut) {
        this.outputs.push({ stream: "stdout", data: tailOut });
        for (const h of [...this.handlers]) h.onOutput?.({ stream: "stdout", data: tailOut });
      }
      if (tailErr) {
        this.outputs.push({ stream: "stderr", data: tailErr });
        for (const h of [...this.handlers]) h.onOutput?.({ stream: "stderr", data: tailErr });
      }
      if (truncated) {
        truncated.originalLen = truncated.field === "stdout" ? stdoutBytes : stderrBytes;
        truncated.keptLen = this.outputs
          .filter((o) => o.stream === truncated!.field)
          .reduce((n, o) => n + o.data.length, 0);
      }
      this.result = {
        stdout: joinOutput(this.outputs, "stdout"),
        stderr: joinOutput(this.outputs, "stderr"),
        exitCode: code ?? (signalName ? signalExitCode(signalName) : null),
        signal: signalName,
        timedOut,
        ...(truncated ? { truncated } : {}),
        execId: this.execId,
      };
      this.settle();
    });
  }

  private settle(): void {
    if (this.settled) return;
    this.settled = true;
    this.status = "done";
    for (const h of [...this.handlers]) h.onDone?.(this.result!);
  }

  subscribe(handlers: ExecutionJobHandlers): () => void {
    this.handlers.add(handlers);
    return () => this.handlers.delete(handlers);
  }

  outputSnapshot(): ExecutionJobOutput[] {
    return [...this.outputs];
  }

  getResult(): ExecutionResult | undefined {
    return this.result;
  }

  cancel(): boolean {
    if (this.status === "done") return true;
    try { process.kill(-this.child.pid!, "SIGKILL"); } catch { /* 已退出 */ }
    return true;
  }
}

function joinOutput(outputs: readonly ExecutionJobOutput[], stream: "stdout" | "stderr"): string {
  return outputs.filter((o) => o.stream === stream).map((o) => o.data).join("");
}

export class LocalSpawnBackend implements ExecutionJobBackend {
  readonly id = "local-spawn";
  private readonly inner: LocalBackend;
  private readonly mappings: ExecutionPathMapping[];

  constructor(options: LocalSpawnBackendOptions = {}) {
    this.mappings = [...(options.mappings ?? [])];
    this.inner = new LocalBackend({
      defaultTimeoutMs: options.defaultTimeoutMs ?? 120_000,
      maxStdoutBytes: options.maxStdoutBytes ?? 4 * 1024 * 1024,
      maxStderrBytes: options.maxStderrBytes ?? 4 * 1024 * 1024,
    });
  }

  async getCapabilities(): Promise<ExecutionCapabilities> {
    return CAPABILITIES;
  }

  private prepare(input: ExecutionRequest): ExecutionRequest {
    const req = validateExecutionRequest(input, {
      timeoutMs: 120_000,
      maxStdoutBytes: 4 * 1024 * 1024,
      maxStderrBytes: 4 * 1024 * 1024,
    });
    if (req.profile !== undefined && req.profile !== "host") {
      throw new ExecutionClientError(
        EXECUTION_WIRE.errorCodes.invalidRequest,
        "local executor only accepts profile=host",
      );
    }
    const mode = resolveExecutionMode(req);
    if (mode === "interactive" || mode === "persistent") {
      throw new ExecutionClientError(
        EXECUTION_WIRE.errorCodes.modeNotSupported,
        `local executor does not support mode=${mode}`,
      );
    }
    return { ...req, cwd: this.translateCwd(req.cwd, req.pathMapping), pathMapping: undefined };
  }

  /** 已登记映射翻译；未登记 cwd → CWD_NOT_ALLOWED（§6.3 语义） */
  translateCwd(cwd: string | undefined, mapping?: ExecutionPathMapping): string | undefined {
    if (cwd === undefined) return undefined;
    const m = mapping ?? this.mappings[0];
    if (!m) {
      throw new ExecutionClientError(
        EXECUTION_WIRE.errorCodes.cwdNotAllowed,
        "no pathMapping registered for this request",
      );
    }
    if (!cwd.startsWith(m.hostRoot)) {
      throw new ExecutionClientError(
        EXECUTION_WIRE.errorCodes.cwdNotAllowed,
        `cwd outside hostRoot: ${cwd}`,
      );
    }
    const rel = cwd.slice(m.hostRoot.length).replace(/^\/+/, "");
    return rel ? `${m.execRoot.replace(/\/+$/, "")}/${rel}` : m.execRoot;
  }

  async execute(input: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult> {
    const req = this.prepare(input);
    if (resolveExecutionMode(req) !== "sync") {
      throw new ExecutionClientError(
        EXECUTION_WIRE.errorCodes.modeNotSupported,
        "execute() only accepts mode=sync; stream 走 startJob()",
      );
    }
    return this.inner.execute(req, signal);
  }

  async startJob(input: ExecutionRequest): Promise<ExecutionJob> {
    const req = this.prepare(input);
    if (resolveExecutionMode(req) !== "stream") {
      throw new ExecutionClientError(
        EXECUTION_WIRE.errorCodes.invalidRequest,
        "startJob() requires mode=stream",
      );
    }
    const cmdArray = Array.isArray(req.cmd) ? req.cmd : ["bash", "-lc", req.cmd];
    return new Promise<ExecutionJob>((resolve, reject) => {
      const child = spawn(cmdArray[0]!, cmdArray.slice(1), {
        cwd: req.cwd,
        env: req.env ? { ...process.env, ...req.env } : process.env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.once("error", (error) => {
        reject(new ExecutionClientError(
          EXECUTION_WIRE.errorCodes.backendUnavailable,
          `spawn failed: ${error.message}`,
        ));
      });
      child.once("spawn", () => {
        resolve(new LocalSpawnJob(child, {
          timeoutMs: req.timeoutMs!,
          maxStdoutBytes: req.maxStdoutBytes!,
          maxStderrBytes: req.maxStderrBytes!,
        }));
      });
    });
  }
}
