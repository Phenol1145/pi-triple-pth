import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  baselineKey,
  collectBoundaryViolations,
  loadBoundaryBaseline,
  type BoundaryViolation,
} from "../../scripts/check/pth-boundaries-core.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

async function writeSrcTree(root: string, files: Record<string, string>): Promise<string> {
  const src = path.join(root, "src", "pth");
  await mkdir(src, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(src, rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, "utf8");
  }
  return src;
}

describe("pth boundary checker: fixture rules", () => {
  let root: string;
  it("flags gateway imports of KernelRuntime and kernel.pool/dataWorld member access", async () => {
    root = await mkdtemp(path.join(tmpdir(), "pth-boundaries-"));
    const src = await writeSrcTree(root, {
      "kernel/assembly.ts": `export interface KernelRuntime { pool: unknown; dataWorld: unknown }`,
      "gateway/routes-x.ts": `
import type { KernelRuntime } from "../kernel/assembly.js";
export async function handler(kernel: KernelRuntime) {
  return kernel.dataWorld.memory.get("x") + kernel.pool.query("SELECT 1");
}
`,
    });
    const violations = await collectBoundaryViolations(src);
    expect(violations.filter((v) => v.rule === "gateway-kernel-import")).toHaveLength(1);
    expect(violations.filter((v) => v.rule === "gateway-kernel-member-access")).toHaveLength(2);
  }, 30_000);

  it("rejects sandbox runtime adapter imports outside the allowlist only", async () => {
    const src = await writeSrcTree(root, {
      "domain/service.ts": `import { SandboxKernel } from "@away_from/pth-sandbox";`,
      "impls/kernels/adapter.ts": `import { SandboxKernel } from "@away_from/pth-sandbox";`,
      "main.ts": `import { SandboxExecClient } from "@away_from/pth-sandbox";`,
      "domain/type-only.ts": `import type { Interpreter } from "@away_from/pth-sandbox";`,
    });
    const violations = (await collectBoundaryViolations(src)).filter((v) => v.rule === "sandbox-runtime-adapter");
    expect(violations.map((v) => v.file)).toEqual(["domain/service.ts"]);
  }, 30_000);

  it("flags tasking/runner/execution/catalog imports of kernel storage adapters and other modules' private files", async () => {
    const src = await writeSrcTree(root, {
      "kernel/storage/task-store-pg.ts": `export class PgTaskStore {}`,
      "tasking/service.ts": `import { PgTaskStore } from "../kernel/storage/task-store-pg.js";`,
      "runner/loop.ts": `import { hidden } from "../tasking/adapters/secret.js";`,
      "tasking/adapters/secret.ts": `export const hidden = 1;`,
      "tasking/index.ts": `export const tasking = 1;`,
      "runner/ok.ts": `import { tasking } from "../tasking/index.js";`,
    });
    const violations = await collectBoundaryViolations(src);
    expect(violations.some((v) => v.rule === "cross-module-storage-adapter" && v.file === "tasking/service.ts")).toBe(true);
    expect(violations.some((v) => v.rule === "cross-module-private-import" && v.file === "runner/loop.ts")).toBe(true);
    expect(violations.some((v) => v.file === "runner/ok.ts")).toBe(false);
  }, 30_000);

  it("rejects forbidden runtime imports inside src/pth/contracts", async () => {
    const src = await writeSrcTree(root, {
      "contracts/bad.ts": `import Fastify from "fastify";`,
    });
    const violations = (await collectBoundaryViolations(src)).filter((v) => v.rule === "contracts-forbidden-import");
    expect(violations).toHaveLength(1);
  }, 30_000);

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });
});

describe("pth boundary checker: production baseline", () => {
  it("records current violations explicitly in baseline and fails only on NEW violations", async () => {
    const src = path.join(REPO_ROOT, "src", "pth");
    const baseline = await loadBoundaryBaseline(path.join(REPO_ROOT, "scripts", "check", "pth-boundaries.baseline.json"));
    const current = await collectBoundaryViolations(src);

    // 基线 = 已入账违规台账；阶段推进时逐项清零并同步收紧基线（当前 P0-5 后可为空）。
    const baselineKeys = new Set(baseline.map(baselineKey));
    for (const v of current) {
      expect(baselineKeys.has(baselineKey(v)), `新增未入账的边界违规: ${v.rule} ${v.file}:${v.line} ${v.detail}`).toBe(true);
    }
  }, 30_000);
});

it("exports baseline JSON matching script comparison schema", async () => {
  const baseline = JSON.parse(
    await readFile(path.join(REPO_ROOT, "scripts", "check", "pth-boundaries.baseline.json"), "utf8"),
  ) as BoundaryViolation[];
  for (const v of baseline) {
    expect(typeof v.rule).toBe("string");
    expect(typeof v.file).toBe("string");
    expect(typeof v.line).toBe("number");
    expect(typeof v.detail).toBe("string");
  }
});
