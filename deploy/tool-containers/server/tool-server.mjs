#!/usr/bin/env node
/**
 * tool-server.mjs —— tool container 内的 execution/v1.1 服务端（T2，PTH 仓事实源）。
 *
 * 只执行 tool-manifest.json 中本域登记的 argv 白名单；Bearer 认证：
 *  - compiled/network：ENGINE_TOKEN（缺省回退 HOST_TOKEN）
 *  - secrets：HOST_TOKEN（ENGINE_TOKEN 物理上不注入）
 * 纯 JS（Node ≥22 直跑，无构建步骤）。
 */

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { readFileSync } from "node:fs";
import {
  ExecutionHttpServer,
  ExecutionClientError,
  EXECUTION_WIRE,
  resolveExecutionMode,
  validateExecutionRequest,
} from "@away_from/shared/execution";

let nodePty = null;
try {
  nodePty = await import("node-pty");
} catch {
  // 镜像未装 node-pty（dev/宿主直跑）——pty 请求回 INVALID_REQUEST，pipes 交互仍可用
}

const DOMAIN = process.env.TOOL_DOMAIN ?? "";
const PORT = Number(process.env.PORT ?? 8080);
const HOST_TOKEN = process.env.HOST_TOKEN ?? "";
const ENGINE_TOKEN = process.env.ENGINE_TOKEN ?? "";

const manifest = JSON.parse(readFileSync(process.env.TOOL_MANIFEST_PATH ?? "/opt/tool-server/tool-manifest.json", "utf8"));
const domainEntry = manifest?.domains?.[DOMAIN];
if (!domainEntry || !Array.isArray(domainEntry.tools)) {
  throw new Error(`tool-server: domain ${DOMAIN} not found in tool-manifest`);
}
const ALLOWED_TOOLS = domainEntry.tools.map((t) => ({ name: t.name, argv: Array.isArray(t.argv) ? t.argv : [t.name], modes: t.modes ?? ["sync"] }));
const ALLOWED_PREFIXES = ALLOWED_TOOLS.map((t) => t.argv);

function cmdMatches(cmd) {
  if (!Array.isArray(cmd)) return false;
  return ALLOWED_PREFIXES.some((prefix) => prefix.every((part, i) => cmd[i] === part));
}

function signalExitCode(signalName) {
  return 128 + ((os.constants.signals ?? {})[signalName] ?? 1);
}

function makeResult(outputs, code, signalName, timedOut, truncated, execId) {
  const join = (stream) => outputs.filter((o) => o.stream === stream).map((o) => o.data).join("");
  return {
    stdout: join("stdout"),
    stderr: join("stderr"),
    exitCode: code ?? (signalName ? signalExitCode(signalName) : null),
    signal: signalName,
    timedOut,
    ...(truncated ? { truncated } : {}),
    execId,
  };
}

class ToolJob {
  constructor(child, limits, execId, ptyProcess) {
    this.child = child;
    this.pty = ptyProcess;
    this.execId = execId;
    this.status = "running";
    this.outputs = [];
    this.handlers = new Set();
    this.result = undefined;
    this.settled = false;

    const decOut = new StringDecoder("utf8");
    const decErr = new StringDecoder("utf8");
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated;
    let killedForLimit = null;
    let timedOut = false;

    const killGroup = () => {
      if (this.pty) { try { this.pty.kill(); } catch { /* 已退出 */ } return; }
      try { process.kill(-this.child.pid, "SIGKILL"); } catch { /* 已退出 */ }
    };
    const killForLimit = (field) => {
      if (killedForLimit) return;
      killedForLimit = field;
      truncated = { field, originalLen: field === "stdout" ? stdoutBytes : stderrBytes, keptLen: 0 };
      killGroup();
    };
    const push = (stream, data) => {
      if (!data) return;
      const limit = stream === "stdout" ? limits.maxStdoutBytes : limits.maxStderrBytes;
      const used = stream === "stdout" ? stdoutBytes : stderrBytes;
      const keep = data.slice(0, Math.max(0, limit - used));
      if (stream === "stdout") stdoutBytes += keep.length; else stderrBytes += keep.length;
      if (keep.length > 0) {
        this.outputs.push({ stream, data: keep });
        for (const h of [...this.handlers]) h.onOutput?.({ stream, data: keep });
      }
      if (keep.length < data.length) killForLimit(stream);
    };
    const finish = (code, signalName) => {
      clearTimeout(timer);
      if (killedForLimit !== "stdout") push("stdout", decOut.end() ?? "");
      if (killedForLimit !== "stderr") push("stderr", decErr.end() ?? "");
      if (truncated) {
        truncated.originalLen = truncated.field === "stdout" ? stdoutBytes : stderrBytes;
        truncated.keptLen = this.outputs.filter((o) => o.stream === truncated.field).reduce((n, o) => n + o.data.length, 0);
      }
      this.result = makeResult(this.outputs, code, signalName, timedOut, truncated, this.execId);
      this.status = "done";
      this.settled = true;
      for (const h of [...this.handlers]) h.onDone?.(this.result);
    };
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, limits.timeoutMs);
    timer.unref();

    if (this.pty) {
      // pty 输出为合并流（stdout；stderr 通道保留为空）
      this.pty.onData((data) => push("stdout", data));
      this.pty.onExit(({ exitCode, signal }) => finish(typeof exitCode === "number" ? exitCode : null, signal ?? null));
    } else {
      const handleData = (buf, field) => push(field, (field === "stdout" ? decOut : decErr).write(buf));
      child.stdout?.on("data", (buf) => handleData(buf, "stdout"));
      child.stderr?.on("data", (buf) => handleData(buf, "stderr"));
      child.on("close", (code, signalName) => finish(code, signalName));
    }
  }

  writeStdin(data) {
    if (this.pty) { this.pty.write(data); return; }
    if (this.child.stdin && this.child.stdin.writable) this.child.stdin.write(data);
  }

  resize(cols, rows) {
    if (this.pty && Number.isInteger(cols) && Number.isInteger(rows)) {
      try { this.pty.resize(Math.max(1, cols), Math.max(1, rows)); } catch { /* 忽略 */ }
    }
  }

  subscribe(handlers) {
    this.handlers.add(handlers);
    return () => this.handlers.delete(handlers);
  }

  outputSnapshot() { return [...this.outputs]; }
  getResult() { return this.result; }

  cancel() {
    if (this.settled) return true;
    if (this.pty) { try { this.pty.kill(); } catch { /* 已退出 */ } return true; }
    try { process.kill(-this.child.pid, "SIGKILL"); } catch { /* 已退出 */ }
    return true;
  }
}

const BACKEND = {
  id: `tools-${DOMAIN}`,
  async getCapabilities() {
    const modes = { sync: false, stream: false, interactive: false, persistent: false };
    for (const tool of ALLOWED_TOOLS) for (const mode of tool.modes) modes[mode] = true;
    return {
      version: "execution/v1.1",
      streaming: modes.stream,
      cancel: true,
      cwdWhitelist: false,
      uidIsolation: false,
      egressLocked: DOMAIN === "compiled",
      pathMapping: false,
      modes,
    };
  },
  async prepare(input) {
    const req = validateExecutionRequest(input, {
      timeoutMs: 120_000,
      maxStdoutBytes: 4 * 1024 * 1024,
      maxStderrBytes: 4 * 1024 * 1024,
    });
    if (!cmdMatches(req.cmd)) {
      throw new ExecutionClientError(
        EXECUTION_WIRE.errorCodes.invalidRequest,
        `tool not allowed on ${DOMAIN} domain: ${JSON.stringify(req.cmd)}`,
      );
    }
    const mode = resolveExecutionMode(req);
    const allowed = (await this.getCapabilities()).modes;
    if (!allowed[mode]) {
      throw new ExecutionClientError(EXECUTION_WIRE.errorCodes.modeNotSupported, `mode=${mode} not supported on ${DOMAIN}`);
    }
    return req;
  },
  async execute(input, signal) {
    const req = await this.prepare(input);
    if (resolveExecutionMode(req) !== "sync") {
      throw new ExecutionClientError(EXECUTION_WIRE.errorCodes.modeNotSupported, "use startJob for stream/interactive");
    }
    return runSync(req, signal);
  },
  async startJob(input) {
    const req = await this.prepare(input);
    const mode = resolveExecutionMode(req);
    if (mode === "sync") throw new ExecutionClientError(EXECUTION_WIRE.errorCodes.invalidRequest, "startJob requires stream/interactive");
    const execId = randomUUID();
    const limits = {
      timeoutMs: req.timeoutMs ?? 120_000,
      maxStdoutBytes: req.maxStdoutBytes ?? 4 * 1024 * 1024,
      maxStderrBytes: req.maxStderrBytes ?? 4 * 1024 * 1024,
    };
    return new Promise((resolve, reject) => {
      const argv = Array.isArray(req.cmd) ? req.cmd : ["bash", "-lc", req.cmd];
      if (mode === "interactive" && req.pty) {
        if (!nodePty) {
          reject(new ExecutionClientError(EXECUTION_WIRE.errorCodes.invalidRequest, "pty requested but node-pty is unavailable"));
          return;
        }
        let ptyProcess;
        try {
          ptyProcess = nodePty.spawn(argv[0], argv.slice(1), {
            name: req.pty.term ?? "xterm-256color",
            cols: req.pty.cols ?? 80,
            rows: req.pty.rows ?? 24,
            cwd: req.cwd,
            env: req.env ? { ...process.env, ...req.env } : process.env,
          });
        } catch (error) {
          reject(new ExecutionClientError(EXECUTION_WIRE.errorCodes.backendUnavailable, `pty spawn failed: ${error.message}`));
          return;
        }
        resolve(new ToolJob(null, limits, execId, ptyProcess));
        return;
      }
      const child = spawn(argv[0], argv.slice(1), {
        cwd: req.cwd,
        env: req.env ? { ...process.env, ...req.env } : process.env,
        detached: true,
        stdio: mode === "interactive" ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
      });
      child.once("error", (error) => reject(new ExecutionClientError(EXECUTION_WIRE.errorCodes.backendUnavailable, `spawn failed: ${error.message}`)));
      child.once("spawn", () => resolve(new ToolJob(child, limits, execId)));
    });
  },
};

function runSync(req, signal) {
  return new Promise((resolve, reject) => {
    const argv = Array.isArray(req.cmd) ? req.cmd : ["bash", "-lc", req.cmd];
    const child = spawn(argv[0], argv.slice(1), {
      cwd: req.cwd,
      env: req.env ? { ...process.env, ...req.env } : process.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const job = new ToolJob(child, {
      timeoutMs: req.timeoutMs ?? 120_000,
      maxStdoutBytes: req.maxStdoutBytes ?? 4 * 1024 * 1024,
      maxStderrBytes: req.maxStderrBytes ?? 4 * 1024 * 1024,
    }, randomUUID());
    const onAbort = () => job.cancel();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error) => {
      signal?.removeEventListener("abort", onAbort);
      reject(new ExecutionClientError(EXECUTION_WIRE.errorCodes.backendUnavailable, `spawn failed: ${error.message}`));
    });
    job.subscribe({
      onDone: (result) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(result);
      },
    });
  });
}

const tokenFor = DOMAIN === "secrets" ? HOST_TOKEN : (ENGINE_TOKEN || HOST_TOKEN);
if (!tokenFor) {
  throw new Error(`tool-server: ${DOMAIN} 域必须注入 ${DOMAIN === "secrets" ? "HOST_TOKEN" : "ENGINE_TOKEN"}`);
}

const server = new ExecutionHttpServer({
  backend: BACKEND,
  token: tokenFor,
  capabilities: await BACKEND.getCapabilities(),
});
await server.listen(PORT, "0.0.0.0");
console.log(`tool-server ${DOMAIN} listening on :${PORT}`);
