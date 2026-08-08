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
