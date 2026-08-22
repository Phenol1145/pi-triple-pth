/**
 * test/pth-professional/lean4-prover.integration.test.ts — v1.3 Task 6
 * Lean 4 Prover 垂直切片验收（真实 elan/Lean/Lake + Mathlib cache，绝不 mock lean/lake）。
 *
 * 正路径：fresh task workspace 中 `lake build` 一个依赖 Mathlib 的 fixture 工程
 * （定理 `two_mul_add_two` 需要 ring tactic——非 `rfl` 可证），断言：
 *  - 源码无 `sorry`/`admit`/`by_contra?` 等占位（adapter 门禁 + `#print axioms` 双重校验）；
 *  - 无未闭 goal（lake build 零 error 即无未闭 goal）；
 *  - 产物链：source / build-log / lake-manifest / tool-versions 全部落 artifact 树。
 * 负路径：语法错误、未决定理（unclosed goals）、sorry、构建超时、workspace 逃逸、
 * 依赖锁变更（require rev 篡改 / 夹带 lake-manifest.json）、任意 command 注入、版本不匹配。
 *
 * 工具链执行模型（纪律：工具缺失 = preflight FAIL，不是 skip）：
 *  - 宿主有 lean → adapter 直接 spawn（pi 容器内生产路径）；
 *  - 宿主没有（如 macOS）→ 注入 `docker exec -e HOME=… -e PATH=… v13-asm-toolchain` 前缀；
 *    该容器以同路径挂载仓库，job workspace 落在仓库内临时目录（WORK_DIR），路径透明；
 *    Mathlib 及传递依赖（含 cache oleans）驻留容器共享目录 PTH_LEAN4_PACKAGES_DIR
 *    （缺省 /home/node/lean-packages），各 job workspace 以 .lake/packages 符号链接共享。
 *  - 可用 PTH_LEAN4_TOOLCHAIN_EXEC 显式覆盖执行前缀。
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  Lean4JobSpec,
  ProfessionalJobRequest,
  ProfessionalRuntimeLock,
} from "@away_from/pth-contracts";
import { createProfessionalArtifactPort } from "../../src/pth/bootstrap/professional-runtime-adapters.js";
import {
  createLean4RuntimeAdapter,
  type Lean4JobValue,
} from "../../src/pth/execution/adapters/lean4-runtime-adapter.js";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const LEAN4_INDEX = join(REPO_ROOT, "toolstore/extensions/lean4-runtime/index.js");
const LOCK_PATH = join(REPO_ROOT, "deploy/professional-runtime-lock.json");

const TENANT = "tenant-lean4-vertical";
const PACKAGE_NAME = "job";
const MODULE_NAME = "Job";
const DECLARATION = "two_mul_add_two";
const sha256 = (s: string | Uint8Array) => `sha256:${createHash("sha256").update(s).digest("hex")}`;

interface Lean4LockExtra {
  toolchain?: string;
  dependencies?: { mathlib?: { tag?: string; rev?: string } };
}
type Lean4LockEntry = ProfessionalRuntimeLock["runtimes"]["lean4"] & Lean4LockExtra;

/** 宿主无 Lean 工具链时经 docker 容器执行（容器同路径挂载仓库，路径透明）。 */
function resolveExecPrefix(): readonly string[] | undefined {
  const env = process.env.PTH_LEAN4_TOOLCHAIN_EXEC;
  if (env && env.trim() !== "") return env.split(" ").filter(Boolean);
  const hostProbe = spawnSync("which", ["lean"], { stdio: "ignore" });
  if (hostProbe.status === 0) return undefined;
  return [
    "docker", "exec",
    "-e", "HOME=/home/node",
    "-e", "PATH=/home/node/.elan/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "v13-asm-toolchain",
  ];
}
const EXEC_PREFIX = resolveExecPrefix();
const WORK_DIR = join(REPO_ROOT, `.lean-work-test-${process.pid}`);
const SHARED_PACKAGES_DIR = process.env.PTH_LEAN4_PACKAGES_DIR ?? "/home/node/lean-packages";

// ─── fixture 工程（Mathlib 依赖；定理需 ring tactic，非 rfl 可证） ──────────

let lockEntry: Lean4LockEntry;
let mathlibRev: string;

const lakefileFor = (rev: string) => `import Lake
open Lake DSL

package «${PACKAGE_NAME}» where

require mathlib from git
  "https://github.com/leanprover-community/mathlib4" @ "${rev}"

@[default_target]
lean_lib ${MODULE_NAME} where
`;

/** 正路径定理：2*n+2 = 2*(n+1) 在自由变量 n 上非定义性相等——rfl 不可证，ring 可证。 */
const GOOD_MODULE = `import Mathlib.Tactic.Ring

/-- 环恒等式：\`2 * n + 2 = 2 * (n + 1)\`，需 Mathlib 的 \`ring\` 规范化。 -/
theorem ${DECLARATION} (n : ℕ) : 2 * n + 2 = 2 * (n + 1) := by
  ring
`;

const SYNTAX_ERROR_MODULE = `import Mathlib.Tactic.Ring

theorem broken (n : ℕ : n = n := rfl
`;

/** 未决定理：省略 succ 分支 → 确定性 "unsolved goals"。 */
const UNPROVEN_MODULE = `import Mathlib.Tactic.Ring

theorem unclosed (n : ℕ) : 0 + n = n := by
  induction n with
  | zero => rfl
`;

const SORRY_MODULE = `import Mathlib.Tactic.Ring

theorem cheated : 0 = 1 := by
  sorry
`;

interface ProjectBundle {
  readonly schemaVersion: 1;
  readonly files: readonly { readonly path: string; readonly content: string }[];
}

const bundle = (files: Record<string, string>): string =>
  JSON.stringify({ schemaVersion: 1, files: Object.entries(files).map(([path, content]) => ({ path, content })) });

const goodBundle = () =>
  bundle({
    "lakefile.lean": lakefileFor(mathlibRev),
    "lean-toolchain": `${(lockEntry.toolchain ?? `leanprover/lean4:v${lockEntry.version}`)}\n`,
    [`${MODULE_NAME}.lean`]: GOOD_MODULE,
  });

// ─── 测试基础设施 ─────────────────────────────────────────────────────────

let artifactRoot: string;

function makeRequest(spec: Lean4JobSpec, jobId: string, bundleJson: string): ProfessionalJobRequest<Lean4JobSpec> {
  return {
    jobId,
    taskId: "task-lean4-vertical",
    tenantId: TENANT,
    space: "default",
    worker: {
      workerId: "worker-lean4-1",
      batchId: "batch-lean4-1",
      role: { roleId: "lean4-prover", revision: "rev-1" },
    },
    lease: { taskId: "task-lean4-vertical", leaseId: "lease-lean4-1", generation: 1 },
    roleRevision: "rev-1",
    runtimeId: "lean4",
    runtimeVersion: "lock:lean4",
    deadlineAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    inputHash: sha256(bundleJson),
    traceId: `trace-${jobId}`,
    spec,
  };
}

function projectRefFor(fixture: string) {
  return { kind: "lean4-project", uri: `artifact://${TENANT}/fixtures/${fixture}`, mediaType: "application/json" };
}

function makeAdapter(extra: { buildTimeoutMs?: number; lockVersion?: string } = {}) {
  return createLean4RuntimeAdapter({
    artifactPort: createProfessionalArtifactPort({ artifactPath: artifactRoot }),
    lean4IndexPath: LEAN4_INDEX,
    lockVersion: extra.lockVersion ?? lockEntry.version,
    mathlibRev,
    workDir: WORK_DIR,
    sharedPackagesDir: SHARED_PACKAGES_DIR,
    ...(EXEC_PREFIX !== undefined ? { execPrefix: EXEC_PREFIX } : {}),
    ...(extra.buildTimeoutMs !== undefined ? { buildTimeoutMs: extra.buildTimeoutMs } : {}),
  });
}

const RUN = process.env.PTH_PROFESSIONAL_INTEGRATION === "1";

describe.skipIf(!RUN)("professional integration (gated)", () => {

beforeAll(async () => {
  artifactRoot = await mkdtemp(join(tmpdir(), "lean4-vertical-"));
  await mkdir(WORK_DIR, { recursive: true });
  const lock = JSON.parse(await readFile(LOCK_PATH, "utf8")) as ProfessionalRuntimeLock;
  lockEntry = lock.runtimes.lean4 as Lean4LockEntry;
  const rev = lockEntry.dependencies?.mathlib?.rev;
  if (typeof rev !== "string" || !/^[0-9a-f]{40}$/.test(rev)) {
    throw new Error("committed lock lean4.dependencies.mathlib.rev 缺失或非法——Task 6 Step 3 未落实");
  }
  mathlibRev = rev;
  const fixtureDir = join(artifactRoot, TENANT, "fixtures");
  await mkdir(fixtureDir, { recursive: true });
  await writeFile(join(fixtureDir, "good.json"), goodBundle(), "utf8");
  await writeFile(join(fixtureDir, "syntax-error.json"), bundle({
    "lakefile.lean": lakefileFor(mathlibRev),
    "lean-toolchain": `leanprover/lean4:v${lockEntry.version}\n`,
    [`${MODULE_NAME}.lean`]: SYNTAX_ERROR_MODULE,
  }), "utf8");
  await writeFile(join(fixtureDir, "unproven.json"), bundle({
    "lakefile.lean": lakefileFor(mathlibRev),
    "lean-toolchain": `leanprover/lean4:v${lockEntry.version}\n`,
    [`${MODULE_NAME}.lean`]: UNPROVEN_MODULE,
  }), "utf8");
  await writeFile(join(fixtureDir, "sorry.json"), bundle({
    "lakefile.lean": lakefileFor(mathlibRev),
    "lean-toolchain": `leanprover/lean4:v${lockEntry.version}\n`,
    [`${MODULE_NAME}.lean`]: SORRY_MODULE,
  }), "utf8");
}, 120_000);

afterAll(async () => {
  await rm(artifactRoot, { recursive: true, force: true });
  await rm(WORK_DIR, { recursive: true, force: true });
});

describe("lean4 prover vertical slice", () => {
  it("preflight: toolchain probe available（缺失 = FAIL，不是 skip）", async () => {
    const adapter = makeAdapter();
    const probe = await adapter.probe();
    expect(
      probe.available,
      `lean4 runtime 不可用：${probe.reason ?? "unknown"}（需要 elan + Lean ${lockEntry.version} + Mathlib cache，见 deploy/Dockerfile）`,
    ).toBe(true);
    expect(probe.releaseChannel).toBe("stable");
    expect(probe.version).toBe(lockEntry.version);
  }, 120_000);

  it("lake-build: fresh workspace 构建 Mathlib fixture，产物链完整且无占位", async () => {
    const adapter = makeAdapter();
    const jobId = "job-lean4-lake-build";
    const bundleJson = goodBundle();
    const result = await adapter.execute(makeRequest(
      { operation: "lake-build", projectRef: projectRefFor("good.json"), module: MODULE_NAME },
      jobId,
      bundleJson,
    ));

    expect(result.error).toBeUndefined();
    expect(result.status).toBe("succeeded");
    expect(result.runtime).toBe("lean4");
    expect(result.traceId).toBe(`trace-${jobId}`);
    expect(result.inputHash).toBe(makeRequest(
      { operation: "lake-build", projectRef: projectRefFor("good.json"), module: MODULE_NAME }, jobId, bundleJson,
    ).inputHash);
    expect(result.outputHash).toMatch(/^sha256:[0-9a-f]{64}$/);

    // 产物链：source / build-log / lake-manifest / tool-versions 全部落 artifact 树。
    const kinds = result.artifacts.map((a) => a.kind);
    for (const kind of ["source", "build-log", "lake-manifest", "tool-versions"]) {
      expect(kinds, `missing artifact kind ${kind}`).toContain(kind);
    }

    const value = result.value as Lean4JobValue;
    expect(value.operation).toBe("lake-build");
    expect(value.noPlaceholders).toBe(true);
    expect(value.unclosedGoals).toBe(0);
    expect(value.toolchain.lean).toBe(lockEntry.version);
    expect(value.toolchain.mathlib).toBe(mathlibRev);

    // lake-manifest artifact 可读且 mathlib rev 与 committed lock 一致。
    const port = createProfessionalArtifactPort({ artifactPath: artifactRoot });
    const manifestRef = result.artifacts.find((a) => a.kind === "lake-manifest")!;
    const manifest = JSON.parse(new TextDecoder().decode(await port.getInput(TENANT, manifestRef))) as {
      packages: { name: string; rev?: string }[];
    };
    const mathlibPkg = manifest.packages.find((p) => p.name === "mathlib");
    expect(mathlibPkg?.rev).toBe(mathlibRev);
  }, 1_800_000);

  it("check-imports: import Mathlib.Tactic.Ring 解析与模块 elaboration 通过", async () => {
    const adapter = makeAdapter();
    const result = await adapter.execute(makeRequest(
      { operation: "check-imports", projectRef: projectRefFor("good.json"), module: MODULE_NAME },
      "job-lean4-check-imports",
      goodBundle(),
    ));
    expect(result.error).toBeUndefined();
    expect(result.status).toBe("succeeded");
  }, 1_800_000);

  it("prove: #print axioms 双重校验——无 sorryAx，声明存在", async () => {
    const adapter = makeAdapter();
    const result = await adapter.execute(makeRequest(
      { operation: "prove", projectRef: projectRefFor("good.json"), module: MODULE_NAME, declaration: DECLARATION },
      "job-lean4-prove",
      goodBundle(),
    ));
    expect(result.error).toBeUndefined();
    expect(result.status).toBe("succeeded");
    const value = result.value as Lean4JobValue;
    expect(value.declaration).toBe(DECLARATION);
    expect(value.axioms ?? []).not.toContain("sorryAx");
  }, 1_800_000);

  describe("负路径：全部无成功结果", () => {
    const expectFailure = async (
      name: string,
      fixture: string,
      expectedCode: string,
      opts: { spec?: unknown; adapter?: ReturnType<typeof makeAdapter>; operation?: Lean4JobSpec["operation"] } = {},
    ) => {
      const adapter = opts.adapter ?? makeAdapter();
      const spec = (opts.spec ?? {
        operation: opts.operation ?? "lake-build",
        projectRef: projectRefFor(fixture),
        module: MODULE_NAME,
      }) as Lean4JobSpec;
      const bundleJson = await readFile(join(artifactRoot, TENANT, "fixtures", fixture), "utf8");
      const result = await adapter.execute(makeRequest(spec, `job-neg-${name}`, bundleJson));
      expect(result.status, JSON.stringify(result.value ?? null)).not.toBe("succeeded");
      expect(result.outputHash).toBeNull();
      expect(result.error?.code).toBe(expectedCode);
      return result;
    };

    it("任意 command 字段注入 → spec-invalid", async () => {
      await expectFailure("command-injection", "good.json", "spec-invalid", {
        spec: { operation: "lake-build", projectRef: projectRefFor("good.json"), command: "/bin/sh -c 'rm -rf /'" },
      });
    });

    it("语法错误 → build-failed 且诊断带 line/column/severity", async () => {
      const result = await expectFailure("syntax-error", "syntax-error.json", "build-failed");
      const errorDiags = result.diagnostics.filter((d) => d.severity === "error");
      expect(errorDiags.length).toBeGreaterThan(0);
      expect(errorDiags[0]!.message).toMatch(/syntax|expected|error/i);
      const withPos = result.diagnostics.find((d) => typeof (d as { line?: number }).line === "number");
      expect(withPos, "诊断缺少 line/column 定位").toBeDefined();
    }, 1_800_000);

    it("未决定理（unclosed goals）→ build-failed 且诊断定位到 succ 分支", async () => {
      const result = await expectFailure("unproven", "unproven.json", "build-failed");
      // Lean 4.33 对缺 induction 分支的规范报错；断言定位到 succ 且诊断带位置。
      expect(
        result.diagnostics.some(
          (d) => /succ|unsolved goals/i.test(d.message) && typeof (d as { line?: number }).line === "number",
        ),
      ).toBe(true);
    }, 1_800_000);

    it("sorry 占位源码 → placeholder-source（构建前拒绝）", async () => {
      await expectFailure("sorry", "sorry.json", "placeholder-source");
    });

    it("构建超时（1ms 上限）→ build-timeout", async () => {
      // 缓存命中的同内容工程不会触发真实构建；此处用内容变体强制 cache miss。
      const fixtureDir = join(artifactRoot, TENANT, "fixtures");
      const variant = `import Mathlib.Tactic.Ring\n\n/-- timeout fixture (cache-buster ${Date.now()}) -/\ntheorem timeout_probe (n : Nat) : 2 * n + 2 = 2 * (n + 1) := by\n  ring\n`;
      await writeFile(join(fixtureDir, "timeout.json"), bundle({
        "lakefile.lean": lakefileFor(mathlibRev),
        "lean-toolchain": `leanprover/lean4:v${lockEntry.version}\n`,
        [`${MODULE_NAME}.lean`]: variant,
      }), "utf8");
      await expectFailure("timeout", "timeout.json", "build-timeout", {
        adapter: makeAdapter({ buildTimeoutMs: 1_000 }),
      });
    }, 120_000);

    it("workspace 逃逸（../ 路径）→ project-escape", async () => {
      const fixtureDir = join(artifactRoot, TENANT, "fixtures");
      await writeFile(join(fixtureDir, "escape.json"), bundle({
        "lakefile.lean": lakefileFor(mathlibRev),
        [`../escape-${process.pid}.lean`]: "theorem evil : True := trivial\n",
      }), "utf8");
      await expectFailure("escape", "escape.json", "project-escape");
    });

    it("依赖锁变更（require rev 篡改）→ dependency-lock-mismatch", async () => {
      const fixtureDir = join(artifactRoot, TENANT, "fixtures");
      const tamperedRev = mathlibRev.replace(/^./, mathlibRev.startsWith("0") ? "1" : "0");
      await writeFile(join(fixtureDir, "tampered-require.json"), bundle({
        "lakefile.lean": lakefileFor(tamperedRev),
        "lean-toolchain": `leanprover/lean4:v${lockEntry.version}\n`,
        [`${MODULE_NAME}.lean`]: GOOD_MODULE,
      }), "utf8");
      await expectFailure("tampered-require", "tampered-require.json", "dependency-lock-mismatch");
    });

    it("夹带 lake-manifest.json（依赖清单注入）→ dependency-lock-mismatch", async () => {
      const fixtureDir = join(artifactRoot, TENANT, "fixtures");
      await writeFile(join(fixtureDir, "smuggled-manifest.json"), bundle({
        "lakefile.lean": lakefileFor(mathlibRev),
        "lean-toolchain": `leanprover/lean4:v${lockEntry.version}\n`,
        "lake-manifest.json": "{\"version\":\"1.1.0\",\"packages\":[]}",
        [`${MODULE_NAME}.lean`]: GOOD_MODULE,
      }), "utf8");
      await expectFailure("smuggled-manifest", "smuggled-manifest.json", "dependency-lock-mismatch");
    });

    it("工具链版本不匹配（lockVersion 伪造）→ toolchain-unavailable", async () => {
      const adapter = makeAdapter({ lockVersion: "0.0.0-not-real" });
      const probe = await adapter.probe();
      expect(probe.available).toBe(false);
      expect(probe.reason ?? "").toMatch(/4\.33|版本|version/i);
      const result = await adapter.execute(makeRequest(
        { operation: "lake-build", projectRef: projectRefFor("good.json"), module: MODULE_NAME },
        "job-neg-version-mismatch",
        goodBundle(),
      ));
      expect(result.status).not.toBe("succeeded");
      expect(result.error?.code).toBe("toolchain-unavailable");
    }, 120_000);
  });
});
});
