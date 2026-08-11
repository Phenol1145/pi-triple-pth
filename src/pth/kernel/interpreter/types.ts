export interface ExecuteOptions {
  timeoutMs?: number;
  stepLimit?: number;
  cwd?: string;
  env?: Record<string, string>;
  // ── Observation 协议（REPL 草案 §2.4.3）：输出可定制 ──
  maxStdout?: number;        // stdout 截断上限（默认 2KB）
  maxStderr?: number;        // stderr 上限（默认 2KB）
  structured?: boolean;      // value 序列化（默认 true——JSON）
  maxValueChars?: number;    // value 序列化上限（默认 8KB）
  captureResult?: boolean;   // 捕获 _result/return（默认 true）
  // ── 执行模式（2026-08-11 元命令拆分）：显式声明而非启发式猜测 ──
  // single：单表达式求值（return 包装——completion value 必回）；
  // program：程序执行（块包装——声明/多语句/控制流）；
  // auto（默认）：旧启发式判别（存量兼容）
  exec?: "single" | "program" | "auto";
}

export interface InterpreterResult {
  ok: boolean;
  value?: unknown;
  stdout?: string;
  stderr?: string;
  error?: { message: string; stack?: string; code?: string };
  durationMs: number;
  language?: string;
  /** 截断标记：LLM 感知信息不完整（Observation 协议 §2.4.4） */
  truncated?: { field: "stdout" | "stderr" | "value"; originalLen: number; keptLen: number };
}

/** 可持久化状态快照（refine 管线输入——持久化层草案 §4.1） */
export interface InterpreterSnapshot {
  variables: Array<{ key: string; value: unknown; serializable: boolean }>;
  functions: Array<{ key: string; source: string }>;   // toString 源码
  oversized: string[];                                  // 超限仅记 key
}

export interface Interpreter {
  readonly language: string;
  execute(program: string, opts?: ExecuteOptions): Promise<InterpreterResult>;
  readonly state: Record<string, unknown>;
  /** 导出可持久化状态（无状态解释器返回空快照） */
  snapshot(): InterpreterSnapshot | Promise<InterpreterSnapshot>;
  reset(): void;
  dispose(): void;
  /** ts 核专属：结果注册表写入（agent-loop 工具执行后调用——内部管理语言语义） */
  registerResult?(key: string, value: unknown): void;
  /** ts 核专属：读核内对象（results/context——任务尾沉淀等） */
  readObject?(name: "results" | "context"): Record<string, unknown>;
}

// ─── 调试协议（基本集——2026-08-09，agent-centric 高层接口待调研）───

export interface DebugBreakpoint {
  id: string;
  line: number;
  condition?: string;
}

export interface DebugStackFrame {
  id: number;
  name: string;
  file?: string;
  line?: number;
}

export interface DebugVariable {
  name: string;
  value: string;
  type?: string;
}

export interface DebugStopped {
  reason: "breakpoint-hit" | "step" | "exited" | "error";
  frame?: DebugStackFrame;
  breakpointId?: string;
  message?: string;
}

/** 调试会话事件（监视组件——attach/breakpoint/step/时长——CDebugSession 上报） */
export interface DebugEvent {
  type: "attach" | "breakpoint-set" | "breakpoint-hit" | "step" | "continue" | "detach";
  sessionId: string;
  ts: number;
  detail?: Record<string, unknown>;
}

export interface DebugSession {
  readonly id: string;
  readonly language: string;
  /** 调试事件回调（可选——监视组件接线；缺省 undefined） */
  onEvent?: (e: DebugEvent) => void;
  /** 启动调试会话（编译调试版 + 启动调试器） */
  attach(source: string): Promise<void>;
  setBreakpoint(line: number, condition?: string): Promise<DebugBreakpoint>;
  /** 继续执行到断点/结束 */
  continueExec(): Promise<DebugStopped>;
  /** 单步（into/over/out） */
  step(direction: "into" | "over" | "out"): Promise<DebugStopped>;
  stack(): Promise<DebugStackFrame[]>;
  variables(frameId?: number): Promise<DebugVariable[]>;
  evaluate(expr: string, frameId?: number): Promise<{ value: string }>;
  detach(): Promise<void>;
}

/** 可调试解释器（实现调试会话——无则返回 null） */
export interface Debuggable extends Interpreter {
  debug(): DebugSession | null;
}
