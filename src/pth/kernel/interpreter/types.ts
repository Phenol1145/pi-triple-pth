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
  /** 仅编译不运行（生产核 dev.build——编译核专用；其他核忽略） */
  buildOnly?: boolean;
  /** 记忆桥盖章（2026-08-12 批 3）：当前空间注入——kernel 层前置 stamp 到执行环境，
   * 记忆库访问带 space（PTH 侧 isVisible(meta, space) 过滤）。由 agent-loop 按 asp 会话空间传入。 */
  space?: string;
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

// ─── 调试协议（agent-centric 高层接口——字段与 @vscode/debugprotocol 对齐）───
// 对齐说明（2026-08-12 小缺口）：字段名/语义对照 DAP 类型（StackFrame/Variable/Breakpoint/
// StoppedEvent body），只保留 agent 聚合所需子集；reason 枚举是 agent 视角归一化
// （DAP StoppedEvent.reason 全枚举 → breakpoint-hit/step/exited/error）。
// DebugStopped.output 对应 DAP output 事件（程序 stdout——continue/step 期间收集回传）。

export interface DebugBreakpoint {
  id: string;
  line: number;
  condition?: string;
}

/** 对齐 DAP StackFrame（id/name/source/line/column）——file 即 source.path 简化 */
export interface DebugStackFrame {
  id: number;
  name: string;
  file?: string;
  line?: number;
  column?: number;
}

/** 对齐 DAP Variable（name/value/type/variablesReference）——聚合接口不展开子变量 */
export interface DebugVariable {
  name: string;
  value: string;
  type?: string;
  variablesReference?: number;
}

export interface DebugStopped {
  reason: "breakpoint-hit" | "step" | "exited" | "error";
  frame?: DebugStackFrame;
  breakpointId?: string;
  message?: string;
  /** 程序 stdout（本次 continue/step 期间收集——对齐 DAP output 事件） */
  output?: string;
}

/** debug.snapshot 聚合（一次调用拿全帧 + 顶帧变量——sandbox 原生端点 2026-08-12） */
export interface DebugSnapshot {
  frames: DebugStackFrame[];
  variables: DebugVariable[];
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
  /** 全帧 + 顶帧变量聚合（原生 snapshot 端点——2026-08-12） */
  snapshot(): Promise<DebugSnapshot>;
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
