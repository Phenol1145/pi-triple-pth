import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDataWorld } from "../../src/pth/kernel/storage/index.js";
import { createPthGatewayFacade } from "../../src/pth/application/gateway/pth-gateway-facade.js";
import type { KernelRuntime } from "../../src/pth/kernel/assembly.js";

const SRC = path.resolve(import.meta.dirname, "../../src/pth");

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(abs));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(abs);
  }
  return out;
}

describe("P0-4：DataWorldAccess 收缩为 assembly-only legacy", () => {
  it("storage/index.ts 将 DataWorldAccess/createDataWorld 标注为 deprecated legacy", async () => {
    const source = await readFile(path.join(SRC, "kernel/storage/index.ts"), "utf8");
    expect(source).toContain("@deprecated");
    expect(source).toContain("assembly-only");
  });

  it("gateway/application 源码不 import storage/index（DataWorldAccess 唯一入口已收进 facade）", async () => {
    const dirs = [path.join(SRC, "gateway"), path.join(SRC, "application")];
    for (const dir of dirs) {
      for (const file of await walk(dir)) {
        const source = await readFile(file, "utf8");
        expect(source, `${path.relative(SRC, file)} 不得 import storage/index`).not.toMatch(
          /from ["'][^"']*kernel\/storage\/index\.js["']/,
        );
      }
    }
  });

  it("createDataWorld 保留为装配兼容对象，返回四访问器 + 只读查询面", () => {
    const dataWorld = createDataWorld({ query: async () => ({ rows: [] }) } as never);
    expect(typeof dataWorld.tasks.publish).toBe("function");
    expect(typeof dataWorld.memory.retrieve).toBe("function");
    expect(typeof dataWorld.transcripts.listByTask).toBe("function");
    expect(typeof dataWorld.audit.write).toBe("function");
    expect(typeof dataWorld.queryReadOnly).toBe("function");
    expect(typeof dataWorld.queryTemplate).toBe("function");
    expect(typeof dataWorld.pgStat).toBe("function");
  });

  it("gateway facade 构造器只暴露窄端口，不暴露 dataWorld/pool", () => {
    const fake = {
      dataWorld: {} as never,
      pool: {} as never,
      batchManager: {} as never,
      activityHub: { stream: () => ({} as never) } as never,
      triggerEngine: { reload: async () => 0 } as never,
      watchdog: { getCrashLog: () => [] } as never,
      execChannel: { execute: async () => ({}) } as never,
      shutdown: async () => {},
    } as unknown as KernelRuntime;
    const facade = createPthGatewayFacade(fake);
    expect("dataWorld" in facade).toBe(false);
    expect("pool" in facade).toBe(false);
    expect("batchManager" in facade).toBe(false);
  });
});
