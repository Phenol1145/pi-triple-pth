/**
 * gdb-mi.ts —— gdb MI（machine interface）协议解析器 + C 调试适配器。
 *
 * gdb -i=mi2 管道协议（基本调试集——2026-08-09）：
 *   命令：-break-insert / -exec-continue / -exec-next / -exec-step /
 *         -stack-list-frames / -stack-list-variables / -data-evaluate-expression / -gdb-exit
 *   输出：^done,var=val  /  *stopped,reason=...,frame={...}  /  ~"text"  /  (gdb)
 *
 * 解析器为纯函数（可单测）；适配器本机无 gdb 时跳过（sandbox Linux 集成验证）。
 */

import type { DebugSession, DebugStackFrame, DebugVariable, DebugStopped, DebugBreakpoint, DebugEvent } from "./types.js";

// ─── MI 输出解析（纯函数）────────────────────────────────────────────

export type MiValue = string | number | { [k: string]: MiValue } | MiValue[];

export interface MiRecord {
  kind: "result" | "exec" | "notify" | "console" | "target" | "prompt";
  cls?: string;            // done / running / stopped / breakpoint-created ...
  results?: Record<string, MiValue>;
  text?: string;
}

/** 解析 gdb MI 单行输出（^done,a=1,b={c="x"} / *stopped,reason="hit" / ~"text" / (gdb)） */
export function parseMiLine(line: string): MiRecord | null {
  const t = line.trim();
  if (t === "(gdb)") return { kind: "prompt" };
  if (!t) return null;
  let kind: MiRecord["kind"];
  let rest = t;
  if (t.startsWith("^")) { kind = "result"; rest = t.slice(1); }
  else if (t.startsWith("*")) { kind = "exec"; rest = t.slice(1); }
  else if (t.startsWith("+")) { kind = "notify"; rest = t.slice(1); }
  else if (t.startsWith("~")) { kind = "console"; return { kind, text: t.slice(1).replace(/^"|"$/g, "").replace(/\\n/g, "\n") }; }
  else if (t.startsWith("@")) { kind = "target"; rest = t.slice(1); }
  else return null;
  // cls: 直到第一个逗号
  const comma = rest.indexOf(",");
  const cls = comma === -1 ? rest : rest.slice(0, comma);
  const results: Record<string, MiValue> = {};
  if (comma !== -1) {
    for (const pair of splitTopLevel(rest.slice(comma + 1))) {
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      results[pair.slice(0, eq).trim()] = parseMiValue(pair.slice(eq + 1).trim());
    }
  }
  return { kind, cls, results };
}

/** 顶层逗号分割（忽略 {} / [] / "" 内） */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (inStr) {
      cur += ch;
      if (ch === "\\" && i + 1 < s.length) { cur += s[i + 1]!; i++; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; cur += ch; continue; }
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** 解析 MI 值：字符串 / 元组 {...} / 列表 [...] / 裸键值 frame={...} */
function parseMiValue(s: string): MiValue {
  if (s.startsWith('"')) {
    return s.slice(1, s.length - 1).replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
  }
  if (s.startsWith("{")) {
    const inner = s.slice(1, s.length - 1).trim();
    if (!inner) return {};
    const obj: { [k: string]: MiValue } = {};
    for (const pair of splitTopLevel(inner)) {
      const eq = pair.indexOf("=");
      if (eq === -1) { obj[pair.trim()] = ""; continue; }
      obj[pair.slice(0, eq).trim()] = parseMiValue(pair.slice(eq + 1).trim());
    }
    return obj;
  }
  if (s.startsWith("[")) {
    const inner = s.slice(1, s.length - 1).trim();
    if (!inner) return [];
    return splitTopLevel(inner).map(parseMiValue);
  }
  // 裸键值：frame={...} / func="main"（列表元素形态）
  const eq = s.indexOf("=");
  if (eq > 0) {
    const key = s.slice(0, eq).trim();
    if (/^[a-zA-Z_][\w-]*$/.test(key)) {
      return { [key]: parseMiValue(s.slice(eq + 1).trim()) };
    }
  }
  return s;
}

// ─── 从 MI 记录提取调试数据（纯函数）────────────────────────────────

/** *stopped 记录 → DebugStopped */
export function stoppedFromRecord(rec: MiRecord | null): DebugStopped | null {
  if (!rec || rec.kind !== "exec" || rec.cls !== "stopped") return null;
  const r = rec.results ?? {};
  const reason = String(r["reason"] ?? "unknown");
  const frame = r["frame"];
  const frameObj = frame && typeof frame === "object" && !Array.isArray(frame) ? (frame as { [k: string]: MiValue }) : null;
  return {
    reason: reason.includes("breakpoint") ? "breakpoint-hit" : reason === "exited" ? "exited" : "step",
    breakpointId: typeof r["bkptno"] === "string" ? r["bkptno"] : undefined,
    frame: frameObj ? {
      id: 0,
      name: String(frameObj["func"] ?? "?"),
      file: typeof frameObj["file"] === "string" ? frameObj["file"] : undefined,
      line: frameObj["line"] !== undefined ? Number(frameObj["line"]) : undefined,
    } : undefined,
  };
}

/** -stack-list-frames 结果 → DebugStackFrame[] */
export function framesFromResult(rec: MiRecord | null): DebugStackFrame[] {
  if (!rec || rec.kind !== "result" || rec.cls !== "done") return [];
  const stack = rec.results?.["stack"];
  if (!stack || !Array.isArray(stack)) return [];
  const out: DebugStackFrame[] = [];
  for (const f of stack) {
    if (typeof f !== "object" || Array.isArray(f)) continue;
    // gdb 列表元素形态：frame={level=...}（裸键）或直接 {level=...}
    const raw = f as { [k: string]: MiValue };
    const o = raw["frame"] && typeof raw["frame"] === "object" && !Array.isArray(raw["frame"])
      ? (raw["frame"] as { [k: string]: MiValue })
      : raw;
    out.push({
      id: Number(o["level"] ?? out.length),
      name: String(o["func"] ?? "?"),
      file: typeof o["file"] === "string" ? o["file"] : undefined,
      line: o["line"] !== undefined ? Number(o["line"]) : undefined,
    });
  }
  return out;
}

/** -stack-list-variables 结果 → DebugVariable[] */
export function variablesFromResult(rec: MiRecord | null): DebugVariable[] {
  if (!rec || rec.kind !== "result" || rec.cls !== "done") return [];
  const vars = rec.results?.["variables"];
  if (!vars || !Array.isArray(vars)) return [];
  const out: DebugVariable[] = [];
  for (const v of vars) {
    if (typeof v !== "object" || Array.isArray(v)) continue;
    const raw = v as { [k: string]: MiValue };
    const o = raw["variable"] && typeof raw["variable"] === "object" && !Array.isArray(raw["variable"])
      ? (raw["variable"] as { [k: string]: MiValue })
      : raw;
    out.push({ name: String(o["name"] ?? "?"), value: String(o["value"] ?? ""), type: typeof o["type"] === "string" ? o["type"] : undefined });
  }
  return out;
}

// ─── C 调试适配器（gdb MI 管道）───────────────────────────────────────

import { spawn, type ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

export interface CDebugAdapterOptions {
  workDir: string;
  cc?: string;
  gdb?: string; // 默认 gdb（sandbox Linux）；本机无 gdb 时 attach 抛错
  timeoutMs?: number;
  /** 调试事件回调（监视组件——attach/breakpoint/step/时长） */
  onEvent?: (e: DebugEvent) => void;
}

export class CDebugSession implements DebugSession {
  readonly id: string;
  readonly language = "c";
  onEvent?: (e: DebugEvent) => void;
  private workDir: string;
  private cc: string;
  private gdbBin: string;
  private timeoutMs: number;
  private child: ChildProcess | null = null;
  private buffer = "";
  private decoder = new StringDecoder("utf8");
  private pending: Array<{ resolve: (recs: MiRecord[]) => void }> = [];
  private records: MiRecord[] = [];
  private binaryPath = "";
  private breakpoints = new Map<string, DebugBreakpoint>();

  private emitEvent: (e: DebugEvent) => void;

  constructor(opts: CDebugAdapterOptions) {
    this.id = `c-debug-${Date.now().toString(36)}`;
    this.workDir = opts.workDir;
    this.cc = opts.cc ?? "cc";
    this.gdbBin = opts.gdb ?? "gdb";
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.emitEvent = opts.onEvent ?? (() => {});
    this.onEvent = opts.onEvent;
  }

  /** 启动调试会话：编译 -g 调试版 → spawn gdb -i=mi2 */
  async attach(source: string): Promise<void> {
    this.emitEvent({ type: "attach", sessionId: this.id, ts: Date.now() });
    const hash = createHash("sha256").update(source).digest("hex").slice(0, 16);
    const dir = path.join(this.workDir, ".debug", this.id);
    await fs.mkdir(dir, { recursive: true });
    const srcPath = path.join(dir, "main.c");
    this.binaryPath = path.join(dir, "main");
    await fs.writeFile(srcPath, source);
    const compile = await new Promise<number>((resolve) => {
      execFile(this.cc, ["-g", "-O0", "-o", this.binaryPath, srcPath, "-lm"], { timeout: this.timeoutMs }, (err) => resolve(err ? 1 : 0));
    });
    if (compile !== 0) throw new Error(`编译失败（调试版）：${srcPath} — 请先确保源码可编译`);
    this.child = spawn(this.gdbBin, ["-i=mi2", "-q", this.binaryPath], { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout?.on("data", (d: Buffer) => this.onData(d));
    this.child.stderr?.on("data", (d: Buffer) => this.onStderr(d));
    this.child.on("exit", () => {
      this.child = null;
      this.flushPending();
    });
    await this.waitPrompt();
  }

  private onData(d: Buffer): void {
    this.buffer += this.decoder.write(d);
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).trimEnd();
      this.buffer = this.buffer.slice(idx + 1);
      const rec = parseMiLine(line);
      if (rec) {
        if (rec.kind === "prompt") this.flushPending();
        else if (rec.kind === "exec" && rec.cls === "stopped") {
          // 异步停止（*stopped——^running 后程序运行至断点/退出）——推给等待器（优先）
          this.records.push(rec);
          const waiter = this.stoppedWaiters.shift();
          if (waiter) waiter.resolve(rec);
        }
        else this.records.push(rec);
      }
    }
  }

  private onStderr(d: Buffer): void {
    // gdb 非 MI 噪音（警告等）——忽略 v1
    void d;
  }

  private flushPending(): void {
    const recs = this.records;
    this.records = [];
    const pending = this.pending;
    this.pending = [];
    for (const p of pending) p.resolve(recs);
  }

  /** 等程序停止（-exec-run/-exec-continue 等"程序启动"命令——^running 立即 prompt，
   *  *stopped 是异步——等 stopped 而非 prompt（端到端发现：prompt 在程序停止前出现，记录丢失） */
  private stoppedWaiters: Array<{ resolve: (rec: MiRecord) => void }> = [];
  private waitStopped(): Promise<MiRecord> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("程序未在超时内停止")), this.timeoutMs);
      this.stoppedWaiters.push({
        resolve: (rec) => { clearTimeout(timer); resolve(rec); },
      });
    });
  }

  private waitPrompt(): Promise<void> {
    if (this.pending.length > 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("gdb 无响应（超时）")), this.timeoutMs);
      this.pending.push({
        resolve: (recs) => {
          clearTimeout(timer);
          void recs;
          resolve();
        },
      });
    });
  }

  /** 发 MI 命令并等提示符返回 */
  private async command(cmd: string): Promise<MiRecord[]> {
    if (!this.child?.stdin) throw new Error("gdb 未运行");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`gdb 命令超时: ${cmd}`)), this.timeoutMs);
      this.pending.push({
        resolve: (recs) => {
          clearTimeout(timer);
          resolve(recs);
        },
      });
      const stdin = this.child?.stdin;
      if (!stdin) {
        clearTimeout(timer);
        reject(new Error("gdb 管道不可用"));
        return;
      }
      stdin.write(cmd + "\n");
    });
  }

  async setBreakpoint(line: number, condition?: string): Promise<DebugBreakpoint> {
    this.emitEvent({ type: "breakpoint-set", sessionId: this.id, ts: Date.now(), detail: { line } });
    const bp: DebugBreakpoint = { id: `bp-${line}`, line, condition };
    // -break-insert main.c:line（条件：-break-insert -c "expr" main.c:line）
    const cond = condition ? ` -c "${condition.replace(/"/g, '\\"')}"` : "";
    await this.command(`-break-insert${cond} main.c:${line}`);
    this.breakpoints.set(bp.id, bp);
    return bp;
  }

  async continueExec(): Promise<DebugStopped> {
    // 等"命令确认"（prompt）与"程序停止"（异步 stopped）——并发等待（stopped 后命令确认已出）
    const stoppedPromise = this.waitStopped().catch(() => null);
    const recs = await this.command("-exec-continue");
    // 程序未运行（"The program is not being run"）→ 自动 -exec-run（attach 只起 gdb）
    const err = recs.find((r) => r.kind === "result" && r.cls === "error");
    if (err && String(err.results?.["msg"] ?? "").includes("not being run")) {
      // waiter #1（stoppedPromise）就是等 run 的 stopped（push 先于 run command——onData 推给它）
      await this.command("-exec-run");
      const stoppedRec = await stoppedPromise;
      return stoppedRec ? (stoppedFromRecord(stoppedRec) ?? { reason: "exited" }) : { reason: "exited" };
    }
    // 程序运行中：命令已确认（^running）——等异步 stopped
    const stoppedRec = await stoppedPromise;
    if (stoppedRec) return stoppedFromRecord(stoppedRec) ?? { reason: "exited" };
    const stopped = recs.map(stoppedFromRecord).find(Boolean);
    return stopped ?? { reason: "exited" };
  }

  async step(direction: "into" | "over" | "out"): Promise<DebugStopped> {
    const cmd = direction === "into" ? "-exec-step" : direction === "over" ? "-exec-next" : "-exec-finish";
    const recs = await this.command(cmd);
    const stopped = recs.map(stoppedFromRecord).find(Boolean);
    return stopped ?? { reason: "exited" };
  }

  async stack(): Promise<DebugStackFrame[]> {
    const recs = await this.command("-stack-list-frames");
    const done = recs.find((r) => r.kind === "result" && r.cls === "done");
    return framesFromResult(done ?? null);
  }

  async variables(frameId?: number): Promise<DebugVariable[]> {
    // frame 选择：MI 的 -stack-list-variables 对当前 frame——frameId 需先 select（
    // --thread/--frame 参数不被支持——端到端发现 variables 返回空的原因）
    if (frameId !== undefined && frameId !== 0) await this.command(`-stack-select-frame ${frameId}`);
    const recs = await this.command(`-stack-list-variables 1`);   // 1 = locals + args
    const done = recs.find((r) => r.kind === "result" && r.cls === "done");
    return variablesFromResult(done ?? null);
  }

  async evaluate(expr: string, frameId?: number): Promise<{ value: string }> {
    const recs = await this.command(`-data-evaluate-expression --thread 1 --frame ${frameId ?? 0} "${expr.replace(/"/g, '\\"')}"`);
    const done = recs.find((r) => r.kind === "result" && r.cls === "done");
    const v = done?.results?.["value"];
    return { value: typeof v === "string" ? v : JSON.stringify(v ?? "") };
  }

  async detach(): Promise<void> {
    try {
      await this.command("-gdb-exit");
    } catch { /* 已退出容忍 */ }
    this.child?.kill();
    this.child = null;
  }
}
