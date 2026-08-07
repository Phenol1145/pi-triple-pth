import { describe, it, expect } from "vitest";
import { PythonInterpreter } from "../../src/pth/kernel/interpreter/python-interpreter";

describe("python interpreter", () => {
  it("executes simple python program", async () => {
    const itp = new PythonInterpreter({});
    const res = await itp.execute("print(1 + 1)");
    expect(res.ok).toBe(true);
    expect(res.stdout).toContain("2");
  }, 30_000);

  it("returns error on python exception", async () => {
    const itp = new PythonInterpreter({});
    const res = await itp.execute("raise ValueError('boom')");
    expect(res.ok).toBe(false);
    expect(res.stderr).toContain("ValueError");
  }, 30_000);

  it("enforces timeout (kill process group)", async () => {
    const itp = new PythonInterpreter({ timeoutMs: 500 });
    const start = Date.now();
    const res = await itp.execute("import time; time.sleep(10)", { timeoutMs: 500 });
    const elapsed = Date.now() - start;
    expect(res.ok).toBe(false);
    expect(elapsed).toBeLessThan(5000);  // 被超时杀死，不真等 10s
  }, 30_000);
});
