/**
 * logger.ts — PTH 统一日志（日志体系设计 SPEC v1.0）
 *
 * 分层 + 结构化 + 链路追踪：
 *   - JSON 默认（pino 兼容，生产采集）/ pretty 可切（PTH_LOG_FORMAT）
 *   - 级别过滤（PTH_LOG_LEVEL，默认 info）
 *   - 组件白名单（13 类）——label 基数可控
 *   - child 继承 baseCtx（taskId/batchId/role 自动携带——链路追踪）
 *
 * batch 子进程经 IPC 转发日志（BatchManager 收 log 消息 → 主进程统一打标）；
 * 本 logger 的 sink 可注入（测试/IPC 转发目标）。
 */

export const LOG_COMPONENTS = [
  "gateway", "engine", "kernel", "batch", "worker", "taskloop",
  "resolver", "refiner", "pykernel", "bashkernel", "tskernel",
  "toolstore", "watchdog", "chain", "recall",
] as const;

export type LogComponent = (typeof LOG_COMPONENTS)[number];

export function isKnownComponent(c: string): boolean {
  return (LOG_COMPONENTS as readonly string[]).includes(c);
}

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerSink {
  write(line: string): void;
}

export interface KernelLogger {
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
  debug(msg: string, ctx?: Record<string, unknown>): void;
  child(component: string, baseCtx?: Record<string, unknown>): KernelLogger;
}

export interface CreateLoggerOptions {
  sink?: LoggerSink;
  env?: NodeJS.ProcessEnv;
  /** IPC 转发目标（batch 子进程）：日志消息发给主进程 */
  ipcSend?: (msg: unknown) => void;
}

export function createKernelLogger(opts: CreateLoggerOptions = {}): KernelLogger {
  const env = opts.env ?? process.env;
  const format = env.PTH_LOG_FORMAT === "pretty" ? "pretty" : "json";
  const level = (env.PTH_LOG_LEVEL ?? "info") as LogLevel;
  const minOrder = LEVEL_ORDER[level] ?? LEVEL_ORDER.info;
  const sink = opts.sink ?? process.stdout;

  function emit(component: string, lvl: LogLevel, msg: string, ctx: Record<string, unknown> = {}, base: Record<string, unknown> = {}): void {
    if (LEVEL_ORDER[lvl] < minOrder) return;
    const merged = { ...base, ...ctx };
    if (opts.ipcSend) {
      // batch 子进程：IPC 转发主进程
      opts.ipcSend({ type: "log", level: lvl, component, msg, ctx: merged });
      return;
    }
    const line = format === "pretty"
      ? formatPretty(lvl, component, msg, merged)
      : formatJson(lvl, component, msg, merged);
    sink.write(line + "\n");
  }

  return {
    // 顶层方法：info(component, msg, ctx) 或 info(msg, ctx)——组件缺省 kernel
    info: (a: string, b?: unknown, c?: Record<string, unknown>) => {
      const [comp, msg, ctx] = normalizeArgs(a, b, c);
      emit(comp, "info", msg, ctx);
    },
    warn: (a: string, b?: unknown, c?: Record<string, unknown>) => {
      const [comp, msg, ctx] = normalizeArgs(a, b, c);
      emit(comp, "warn", msg, ctx);
    },
    error: (a: string, b?: unknown, c?: Record<string, unknown>) => {
      const [comp, msg, ctx] = normalizeArgs(a, b, c);
      emit(comp, "error", msg, ctx);
    },
    debug: (a: string, b?: unknown, c?: Record<string, unknown>) => {
      const [comp, msg, ctx] = normalizeArgs(a, b, c);
      emit(comp, "debug", msg, ctx);
    },
    child(component, baseCtx = {}) {
      const comp = isKnownComponent(component) ? component : "kernel";
      const mergedBase = { ...baseCtx };
      return {
        info: (m, c) => emit(comp, "info", m, c, mergedBase),
        warn: (m, c) => emit(comp, "warn", m, c, mergedBase),
        error: (m, c) => emit(comp, "error", m, c, mergedBase),
        debug: (m, c) => emit(comp, "debug", m, c, mergedBase),
        child: (c2, b2) => {
          const comp2 = isKnownComponent(c2) ? c2 : "kernel";
          const base2 = { ...mergedBase, ...b2 };
          return {
            info: (m, c) => emit(comp2, "info", m, c, base2),
            warn: (m, c) => emit(comp2, "warn", m, c, base2),
            error: (m, c) => emit(comp2, "error", m, c, base2),
            debug: (m, c) => emit(comp2, "debug", m, c, base2),
            child: () => { throw new Error("logger child depth > 2 not supported"); },
          };
        },
      };
    },
  };
}

function normalizeArgs(a: string, b?: unknown, c?: Record<string, unknown>): [string, string, Record<string, unknown>] {
  // 两种形态：info(component, msg, ctx) | info(msg, ctx)
  if (typeof b === "string") {
    return [isKnownComponent(a) ? a : "kernel", b, c ?? {}];
  }
  return ["kernel", a, (b as Record<string, unknown>) ?? {}];
}

function formatJson(lvl: LogLevel, component: string, msg: string, ctx: Record<string, unknown>): string {
  return JSON.stringify({
    ts: new Date().toISOString(),
    level: lvl,
    component,
    msg,
    ...ctx,
  });
}

function formatPretty(lvl: LogLevel, component: string, msg: string, ctx: Record<string, unknown>): string {
  const time = new Date().toISOString().slice(11, 23);
  const tag = ctx.taskId ? `[${ctx.taskId}]` : ctx.batchId ? `[${ctx.batchId}]` : "";
  const icon = lvl === "error" ? "❌" : lvl === "warn" ? "⚠️" : lvl === "debug" ? "🔍" : "✅";
  const ctxStr = Object.entries(ctx)
    .filter(([k]) => !["taskId", "batchId"].includes(k))
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(" ");
  return `[${time}] [${component}] ${tag} ${icon} ${msg}${ctxStr ? ` (${ctxStr})` : ""}`;
}
