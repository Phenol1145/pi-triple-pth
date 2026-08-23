import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InternalExecutorRegistry } from "../../src/pth/execution/internal-executor-registry.js";
import { registerDevWriteDebugExecutors } from "../../src/pth/execution/internal-executor-adapters.js";
import type { AgentToolCtx } from "@away_from/pth-kernel-execution";

let dir = "";
let ctx: AgentToolCtx;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pth-internal-adapter-"));
  ctx = {
    kernel: {} as never,
    caps: {},
    taskWorkspace: dir,
    toolstore: undefined,
  } as AgentToolCtx;
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("internal-executor-adapters TCE P4", () => {
  it("dev/write/debug 族注册进 registry 并执行 dev.write", async () => {
    const reg = new InternalExecutorRegistry();
    registerDevWriteDebugExecutors(reg, () => ctx);
    expect(reg.has("dev.write")).toBe(true);
    expect(reg.has("debug.sessions")).toBe(true);

    const r = await reg.execute("dev.write", { path: "main.c", code: "int main(){}" });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.value as { path: string }).path).toBe("main.c");
  });

  it("write.list 读取任务工作区", async () => {
    const reg = new InternalExecutorRegistry();
    registerDevWriteDebugExecutors(reg, () => ctx);
    const r = await reg.execute("write.list", {});
    expect(r.ok).toBe(true);
  });
});
