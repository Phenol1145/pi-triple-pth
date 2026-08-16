import { describe, expect, it } from "vitest";
import {
  BashInterpreter,
  BashKernel,
  PyKernel,
  SandboxKernel,
} from "@away_from/pth-sandbox";
import type {
  ExecuteOptions,
  Interpreter,
  InterpreterResult,
  WorkerKernel,
} from "@away_from/pth-sandbox";

/**
 * 模块化 v2 P0-5：内核契约归属回归（拆分裁决——内核 interpreter 契约留在 pth-sandbox）。
 * 本测试守护两件事：
 *  1. 契约类型（Interpreter/InterpreterResult/WorkerKernel）仍从包稳定导出；
 *  2. 持久核实现类仍从包导出（契约与实现同包，不迁移到 core）。
 */
describe("pth-sandbox 内核契约导出", () => {
  it("Interpreter 契约与持久核实现同包导出", () => {
    const interpreter: Interpreter = new BashKernel({ lazySpawn: true });
    expect(interpreter.language).toBe("bash");
    interpreter.dispose();

    expect(typeof BashKernel).toBe("function");
    expect(typeof PyKernel).toBe("function");
    expect(typeof SandboxKernel).toBe("function");
    expect(typeof BashInterpreter).toBe("function");
  });

  it("InterpreterResult 形状仍是核心消费契约", () => {
    const result: InterpreterResult = { ok: true, stdout: "", stderr: "", durationMs: 0, language: "bash" };
    expect(result.ok).toBe(true);
  });

  it("WorkerKernel 契约形状可被核心侧结构实现（无反向依赖）", () => {
    const kernel: Interpreter = new BashKernel({ lazySpawn: true });
    const worker: WorkerKernel = {
      ts: kernel,
      bash: kernel,
      python: kernel,
      llm: null,
      dataWorld: null,
      snapshot: async () => ({ variables: [], functions: [], oversized: [] }),
      reset() {},
      dispose() {},
    };
    expect(worker.ts.language).toBe("bash");
    worker.dispose();
  });

  it("ExecuteOptions 协议字段导出完整（REPL/Observation 协议）", () => {
    const opts: ExecuteOptions = { timeoutMs: 1000, maxStdout: 512, exec: "program", space: "meta" };
    expect(opts.exec).toBe("program");
  });
});
