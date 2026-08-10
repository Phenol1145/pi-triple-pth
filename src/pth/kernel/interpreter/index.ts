import type { ModelRouter } from "@away_from/infra";
import type { DataWorldAccess } from "../storage/index.js";
import type { InterpreterSnapshot } from "./types.js";
import { TsInterpreter } from "./ts-interpreter.js";
import { BashInterpreter } from "./bash-interpreter.js";
import { PythonInterpreter } from "./python-interpreter.js";
import { createLlmFn, type LlmFn } from "./llm-fn.js";
import { buildCapabilities } from "./capability.js";
import type { Interpreter } from "./types.js";

export interface WorkerKernel {
  ts: Interpreter;
  bash: Interpreter;
  python: Interpreter;
  llm: LlmFn;
  dataWorld: DataWorldAccess;
  /** 聚合快照（T4 refine 输入）：ts + python + bash 三 kernel 状态 */
  snapshot(): InterpreterSnapshot | Promise<InterpreterSnapshot>;
  reset(): void;
  dispose(): void;
}

export interface WorkerKernelDeps {
  modelRouter: ModelRouter;
  dataWorld: DataWorldAccess;
  sandbox?: { exec(req: any, signal?: AbortSignal): Promise<any> };
  pythonBin?: string;
}

/** 一个 worker = 三解释器 + llm 函数 + 数据世界连接（Spec B 消费） */
export function createWorkerKernel(deps: WorkerKernelDeps): WorkerKernel {
  const llm = createLlmFn({ modelRouter: deps.modelRouter });
  const bash = new BashInterpreter({ sandbox: deps.sandbox ?? { exec: async () => ({ ok: false, stdout: "", stderr: "sandbox not configured", exitCode: 1, durationMs: 0 }) } });
  const python = new PythonInterpreter({ pythonBin: deps.pythonBin });
  const capabilities = buildCapabilities({ llm, dataWorld: deps.dataWorld, bash, python });
  const ts = new TsInterpreter({ capabilities });
  return {
    ts, bash, python, llm, dataWorld: deps.dataWorld,
    snapshot: async () => {
      const tsSnap = await ts.snapshot();
      const pySnap = await python.snapshot();
      const bSnap = await bash.snapshot();
      return {
        variables: [...tsSnap.variables, ...pySnap.variables],
        functions: [...tsSnap.functions, ...pySnap.functions],
        oversized: [...tsSnap.oversized, ...pySnap.oversized, ...bSnap.oversized],
      };
    },
    reset() { ts.reset(); bash.reset(); python.reset(); },
    dispose() { ts.dispose(); bash.dispose(); python.dispose(); },
  };
}

export * from "./types.js";
export * from "./ts-interpreter.js";
export * from "./bash-interpreter.js";
// 适配说明：python-interpreter 与 ts-interpreter 均导出 DEFAULT_EXECUTION_TIMEOUT_MS，
// 双 star re-export 触发 TS2308（歧义成员）。显式只 re-export PythonInterpreter 类；
// DEFAULT_EXECUTION_TIMEOUT_MS 仍可从 ./python-interpreter.js 直接导入。
export {  } from "./python-interpreter.js";
export * from "./llm-fn.js";
export * from "./capability.js";
export * from "./kernel-manager.js";
