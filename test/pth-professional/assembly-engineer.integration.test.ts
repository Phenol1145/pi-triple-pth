/**
 * test/pth-professional/assembly-engineer.integration.test.ts — v1.3 Task 5
 * Assembly Engineer 垂直切片验收（真实工具链，绝不 mock as/ld/qemu）。
 *
 * 范围：x86-64 / AArch64 / RISC-V 三目标 byte-sum 例程 build+run+disassemble，
 * stdout 与 JS 参考实现（同源数据 reduce）逐字节比对；负路径覆盖非法 target、
 * 不支持指令、链接失败、超时、非零退出、输出不匹配、任意 command 字段注入。
 *
 * 工具链执行模型（纪律：工具缺失 = preflight FAIL，不是 skip）：
 *  - 宿主有 x86_64-linux-gnu-as → adapter 直接 spawn（pi 容器内生产路径）；
 *  - 宿主没有（如 macOS）→ 注入 `docker exec v13-asm-toolchain` 前缀；该容器以
 *    同路径挂载仓库（/Users/anzhize/pi-platform），asm-kernel 工作目录落在
 *    仓库内临时目录（WORK_DIR），路径对宿主与容器透明；
 *  - 可用 PTH_ASM_TOOLCHAIN_EXEC="docker exec <container>" 显式覆盖。
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  AssemblyJobSpec,
  AssemblyTarget,
  ProfessionalJobRequest,
  ProfessionalRuntimeLock,
} from "@away_from/pth-contracts";
import { createProfessionalArtifactPort } from "../../src/pth/bootstrap/professional-runtime-adapters.js";
import {
  createAssemblyRuntimeAdapter,
  type AssemblyJobValue,
} from "../../src/pth/execution/adapters/assembly-runtime-adapter.js";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const ASM_KERNEL_INDEX = join(REPO_ROOT, "toolstore/extensions/asm-kernel/index.js");
const LOCK_PATH = join(REPO_ROOT, "deploy/professional-runtime-lock.json");

const TENANT = "tenant-asm-vertical";
const sha256 = (s: string | Uint8Array) => `sha256:${createHash("sha256").update(s).digest("hex")}`;
const HOST_KERNEL_ARCH = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : "unknown";

/** 宿主无交叉工具链时经 docker 容器执行（容器同路径挂载仓库，路径透明）。 */
function resolveExecPrefix(): readonly string[] | undefined {
  const env = process.env.PTH_ASM_TOOLCHAIN_EXEC;
  if (env && env.trim() !== "") return env.split(" ").filter(Boolean);
  const hostProbe = spawnSync("which", ["x86_64-linux-gnu-as"], { stdio: "ignore" });
  if (hostProbe.status === 0) return undefined;
  return ["docker", "exec", "v13-asm-toolchain"];
}
const EXEC_PREFIX = resolveExecPrefix();
// asm-kernel 在此目录下写 main.s/main.o/main：必须在容器可见的仓库挂载内。
const WORK_DIR = join(REPO_ROOT, `.asm-work-test-${process.pid}`);

// ─── byte-sum 例程：对 .data 字节数组求和，十进制打印到 stdout，exit 0 ───
// 数据与参考实现同源（JS reduce），和 = 849 > 255 强制 itoa 多位转换，非平凡。
const DATA = [7, 19, 35, 91, 128, 200, 255, 64, 33, 17] as const;
const REFERENCE_SUM = DATA.reduce((a, b) => a + b, 0);
const REFERENCE_STDOUT = `${REFERENCE_SUM}\n`;
const BYTES = DATA.join(",");

const X86_64_SOURCE = `    .global _start
    .text
_start:
    lea data(%rip), %rsi
    mov $(data_end - data), %rcx
    xor %rax, %rax
1:
    movzbl (%rsi), %edx
    add %rdx, %rax
    inc %rsi
    dec %rcx
    jnz 1b
    lea buf+31(%rip), %rsi
    movb $10, (%rsi)
    mov $10, %r8
2:
    xor %rdx, %rdx
    div %r8
    add $48, %dl
    dec %rsi
    mov %dl, (%rsi)
    test %rax, %rax
    jnz 2b
    lea buf+32(%rip), %rdx
    sub %rsi, %rdx
    mov $1, %rax
    mov $1, %rdi
    syscall
    mov $60, %rax
    xor %rdi, %rdi
    syscall
    .data
data:
    .byte ${BYTES}
data_end:
    .bss
    .lcomm buf, 32
`;

const AARCH64_SOURCE = `    .global _start
    .text
_start:
    adr x1, data
    mov x2, #(data_end - data)
    mov x0, #0
1:
    ldrb w3, [x1], #1
    add x0, x0, x3
    subs x2, x2, #1
    b.ne 1b
    adr x1, buf_end
    mov w4, #10
    strb w4, [x1, #-1]!
2:
    mov x4, #10
    udiv x5, x0, x4
    msub x6, x5, x4, x0
    add w6, w6, #48
    strb w6, [x1, #-1]!
    mov x0, x5
    cbnz x0, 2b
    adr x2, buf_end
    sub x2, x2, x1
    mov x0, #1
    mov x8, #64
    svc #0
    mov x0, #0
    mov x8, #93
    svc #0
    .data
data:
    .byte ${BYTES}
data_end:
    .bss
buf: .skip 32
buf_end:
`;

const RISCV64_SOURCE = `    .global _start
    .text
    .option norelax
_start:
    la t0, data
    la t1, data_end
    sub t1, t1, t0
    li a0, 0
1:
    lbu t2, 0(t0)
    add a0, a0, t2
    addi t0, t0, 1
    addi t1, t1, -1
    bnez t1, 1b
    la t0, buf_end
    li t2, 10
    addi t0, t0, -1
    sb t2, 0(t0)
2:
    remu t3, a0, t2
    divu a0, a0, t2
    addi t3, t3, 48
    addi t0, t0, -1
    sb t3, 0(t0)
    bnez a0, 2b
    la a2, buf_end
    sub a2, a2, t0
    li a0, 1
    mv a1, t0
    li a7, 64
    ecall
    li a0, 0
    li a7, 93
    ecall
    .data
data:
    .byte ${BYTES}
data_end:
    .bss
buf: .skip 32
buf_end:
`;

interface TargetCase {
  readonly target: AssemblyTarget;
  readonly kernelArch: string;
  readonly fixture: string;
  readonly source: string;
  readonly syscallNeedle: RegExp;
  readonly divNeedle: RegExp;
}

const TARGET_CASES: readonly TargetCase[] = [
  { target: "x86-64", kernelArch: "x86_64", fixture: "bytesum-x86-64.s", source: X86_64_SOURCE, syscallNeedle: /syscall/, divNeedle: /\bdiv\b/ },
  { target: "aarch64", kernelArch: "aarch64", fixture: "bytesum-aarch64.s", source: AARCH64_SOURCE, syscallNeedle: /\bsvc\b/, divNeedle: /\budiv\b/ },
  { target: "riscv64", kernelArch: "riscv64", fixture: "bytesum-riscv64.s", source: RISCV64_SOURCE, syscallNeedle: /\becall\b/, divNeedle: /\bdivu\b/ },
];

// ─── 负路径 fixture ──
const BAD_INSTRUCTION_SOURCE = `    .global _start
    .text
_start:
    mov x0, #0
    svc #0
`;
const LINK_FAILURE_SOURCE = `    .global _start
    .text
_start:
    call missing_symbol
    mov $60, %rax
    xor %rdi, %rdi
    syscall
`;
const INFINITE_LOOP_SOURCE = `    .global _start
    .text
_start:
1:
    jmp 1b
`;
const EXIT_42_SOURCE = `    .global _start
    .text
_start:
    mov $60, %rax
    mov $42, %rdi
    syscall
`;

let artifactRoot: string;
let lockVersion: string;

function makeRequest(spec: AssemblyJobSpec, jobId: string, source: string): ProfessionalJobRequest<AssemblyJobSpec> {
  return {
    jobId,
    taskId: "task-asm-vertical",
    tenantId: TENANT,
    space: "default",
    worker: {
      workerId: "worker-asm-1",
      batchId: "batch-asm-1",
      role: { roleId: "assembly-engineer", revision: "rev-1" },
    },
    lease: { taskId: "task-asm-vertical", leaseId: "lease-asm-1", generation: 1 },
    roleRevision: "rev-1",
    runtimeId: "assembly",
    runtimeVersion: "lock:assembly",
    deadlineAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    inputHash: sha256(source),
    traceId: `trace-${jobId}`,
    spec,
  };
}

function sourceRefFor(fixture: string) {
  return { kind: "asm-source", uri: `artifact://${TENANT}/fixtures/${fixture}`, mediaType: "text/x-asm" };
}

function makeAdapter(extra: { runTimeoutMs?: number } = {}) {
  return createAssemblyRuntimeAdapter({
    artifactPort: createProfessionalArtifactPort({ artifactPath: artifactRoot }),
    asmKernelIndexPath: ASM_KERNEL_INDEX,
    lockVersion,
    workDir: WORK_DIR,
    ...(EXEC_PREFIX !== undefined ? { execPrefix: EXEC_PREFIX } : {}),
    ...(extra.runTimeoutMs !== undefined ? { runTimeoutMs: extra.runTimeoutMs } : {}),
  });
}

const RUN = process.env.PTH_PROFESSIONAL_INTEGRATION === "1";

describe.skipIf(!RUN)("professional integration (gated)", () => {

beforeAll(async () => {
  artifactRoot = await mkdtemp(join(tmpdir(), "asm-vertical-"));
  await mkdir(WORK_DIR, { recursive: true });
  const lock = JSON.parse(await readFile(LOCK_PATH, "utf8")) as ProfessionalRuntimeLock;
  lockVersion = lock.runtimes.assembly.version;
  const fixtureDir = join(artifactRoot, TENANT, "fixtures");
  await mkdir(fixtureDir, { recursive: true });
  // sourceRef 指向 artifact 树内的 fixture（生产路径：adapter 只经 artifactPort 读源码）。
  for (const c of TARGET_CASES) {
    await writeFile(join(fixtureDir, c.fixture), c.source, "utf8");
    await writeFile(join(fixtureDir, `${c.fixture}.expected`), REFERENCE_STDOUT, "utf8");
  }
  await writeFile(join(fixtureDir, "bad-instruction-x86-64.s"), BAD_INSTRUCTION_SOURCE, "utf8");
  await writeFile(join(fixtureDir, "link-failure-x86-64.s"), LINK_FAILURE_SOURCE, "utf8");
  await writeFile(join(fixtureDir, "infinite-loop-x86-64.s"), INFINITE_LOOP_SOURCE, "utf8");
  await writeFile(join(fixtureDir, "exit-42-x86-64.s"), EXIT_42_SOURCE, "utf8");
}, 60_000);

afterAll(async () => {
  await rm(artifactRoot, { recursive: true, force: true });
  await rm(WORK_DIR, { recursive: true, force: true });
});

describe("assembly engineer vertical slice", () => {
  it("preflight: toolchain probe available（缺失 = FAIL，不是 skip）", async () => {
    const adapter = makeAdapter();
    const probe = await adapter.probe();
    expect(
      probe.available,
      `assembly runtime 不可用：${probe.reason ?? "unknown"}（需要 binutils/qemu-user/交叉 binutils，见 deploy/Dockerfile）`,
    ).toBe(true);
    expect(probe.releaseChannel).toBe("stable");
    expect(probe.version).toBe(lockVersion);
  }, 60_000);

  for (const c of TARGET_CASES) {
    it(`${c.target}: build+run+disassemble byte-sum，输出与参考实现一致`, async () => {
      const adapter = makeAdapter();
      const jobId = `job-asm-${c.kernelArch}-bytesum`;
      const request = makeRequest(
        { operation: "build-run-disassemble", target: c.target, sourceRef: sourceRefFor(c.fixture) },
        jobId,
        c.source,
      );
      const result = await adapter.execute(request);

      expect(result.error).toBeUndefined();
      expect(result.status).toBe("succeeded");
      expect(result.runtime).toBe("assembly");
      expect(result.traceId).toBe(`trace-${jobId}`);
      expect(result.inputHash).toBe(request.inputHash);
      expect(result.outputHash).toMatch(/^sha256:[0-9a-f]{64}$/);

      // 产物链：source/object/binary/disassembly/run-log 全部落 artifact 树。
      const kinds = result.artifacts.map((a) => a.kind);
      for (const kind of ["source", "object", "binary", "disassembly", "run-log"]) {
        expect(kinds, `missing artifact kind ${kind}`).toContain(kind);
      }

      const value = result.value as AssemblyJobValue;
      expect(value.target).toBe(c.target);
      expect(value.exitCode).toBe(0);
      expect(value.timedOut).toBe(false);
      // 与参考实现逐字节比对。
      expect(value.stdout).toBe(REFERENCE_STDOUT);
      // 工具链版本留痕（as/ld/objdump 同源于 committed lock 的 binutils 版本；
      // 原生目标直跑 → qemu 为 null）。
      expect(value.toolchain.assembler).toBe(lockVersion);
      expect(value.toolchain.linker).toBe(lockVersion);
      expect(value.toolchain.objdump).toBe(lockVersion);
      if (c.kernelArch === HOST_KERNEL_ARCH) expect(value.toolchain.qemu).toBeNull();
      else expect(value.toolchain.qemu).toMatch(/^\d+\.\d+\.\d+$/);

      // 反汇编 artifact 可读且含关键指令。
      const disasmRef = result.artifacts.find((a) => a.kind === "disassembly")!;
      const disasm = new TextDecoder().decode(
        await createProfessionalArtifactPort({ artifactPath: artifactRoot }).getInput(TENANT, disasmRef),
      );
      expect(disasm).toMatch(c.syscallNeedle);
      expect(disasm).toMatch(c.divNeedle);
      expect(value.disassembly).toBe(disasm);
    }, 120_000);

    it(`${c.target}: verify 操作与 .expected artifact 比对通过`, async () => {
      const adapter = makeAdapter();
      const result = await adapter.execute(makeRequest(
        { operation: "verify", target: c.target, sourceRef: sourceRefFor(c.fixture) },
        `job-asm-${c.kernelArch}-verify`,
        c.source,
      ));
      expect(result.error).toBeUndefined();
      expect(result.status).toBe("succeeded");
      expect((result.value as AssemblyJobValue).stdout).toBe(REFERENCE_STDOUT);
    }, 120_000);
  }

  describe("负路径：全部无成功结果", () => {
    const expectFailure = async (
      name: string,
      spec: unknown,
      source: string,
      expectedCode: string,
      adapter = makeAdapter(),
    ) => {
      const result = await adapter.execute(
        makeRequest(spec as AssemblyJobSpec, `job-neg-${name}`, source),
      );
      expect(result.status, JSON.stringify(result.value ?? null)).not.toBe("succeeded");
      expect(result.outputHash).toBeNull();
      expect(result.error?.code).toBe(expectedCode);
    };

    it("非法 target → spec-invalid", async () => {
      await expectFailure(
        "bad-target",
        { operation: "build", target: "armv7", sourceRef: sourceRefFor("bytesum-x86-64.s") },
        X86_64_SOURCE,
        "spec-invalid",
      );
    });

    it("任意 command 字段注入 → spec-invalid", async () => {
      await expectFailure(
        "command-injection",
        { operation: "run", target: "x86-64", sourceRef: sourceRefFor("bytesum-x86-64.s"), command: "/bin/sh -c 'rm -rf /'" },
        X86_64_SOURCE,
        "spec-invalid",
      );
    });

    it("不支持指令（x86-64 源里写 AArch64 指令）→ assemble-failed", async () => {
      await expectFailure(
        "bad-instruction",
        { operation: "build", target: "x86-64", sourceRef: sourceRefFor("bad-instruction-x86-64.s") },
        BAD_INSTRUCTION_SOURCE,
        "assemble-failed",
      );
    });

    it("链接失败（未定义符号）→ link-failed", async () => {
      await expectFailure(
        "link-failure",
        { operation: "build-run-disassemble", target: "x86-64", sourceRef: sourceRefFor("link-failure-x86-64.s") },
        LINK_FAILURE_SOURCE,
        "link-failed",
      );
    });

    it("超时（死循环 + 500ms 上限）→ run-timeout", async () => {
      await expectFailure(
        "timeout",
        { operation: "run", target: "x86-64", sourceRef: sourceRefFor("infinite-loop-x86-64.s") },
        INFINITE_LOOP_SOURCE,
        "run-timeout",
        makeAdapter({ runTimeoutMs: 500 }),
      );
    }, 60_000);

    it("非零退出（exit 42）→ run-exit-nonzero", async () => {
      await expectFailure(
        "exit-42",
        { operation: "run", target: "x86-64", sourceRef: sourceRefFor("exit-42-x86-64.s") },
        EXIT_42_SOURCE,
        "run-exit-nonzero",
      );
    });

    it("输出不匹配（verify 对错误期望值）→ output-mismatch", async () => {
      // 专属 fixture：同名源 + 错误 .expected（不覆写正路径 fixture）。
      const fixtureDir = join(artifactRoot, TENANT, "fixtures");
      await writeFile(join(fixtureDir, "wrong-expected-x86-64.s"), X86_64_SOURCE, "utf8");
      await writeFile(join(fixtureDir, "wrong-expected-x86-64.s.expected"), "0\n", "utf8");
      await expectFailure(
        "output-mismatch",
        { operation: "verify", target: "x86-64", sourceRef: sourceRefFor("wrong-expected-x86-64.s") },
        X86_64_SOURCE,
        "output-mismatch",
      );
    }, 120_000);
  });
});
});
