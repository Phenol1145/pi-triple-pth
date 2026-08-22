/**
 * notebook-guide.test.ts — v1.3 Task 9 Step 1 失败测试。
 *
 * 覆盖：
 *  - validateNotebookGuideManifest：合法 manifest 通过；sourceJobIds 空拒绝；
 *    artifactHash 缺/非法拒绝；跨租户拒绝（expectedTenantId 不一致）。
 *  - scanNotebook：干净 notebook 三扫（secrets / absolutePaths / oversizedOutputs）皆空；
 *    注入凭据、宿主绝对路径、超限输出时必须检出。
 *  - buildNotebookGuide：nbformat v4 确定性——同一 canonical 输入两次生成字节一致；
 *    cell id 从 canonical 输入派生（输入变化 → id 变化；不含随机数/时间戳）。
 */
import { describe, expect, it } from "vitest";
import {
  validateNotebookGuideManifest,
  type NotebookGuideManifest,
} from "@away_from/pth-contracts";
import {
  buildNotebookGuide,
  scanNotebook,
  type NotebookLesson,
} from "../../src/pth/execution/notebook-guide.js";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const HASH_C = `sha256:${"c".repeat(64)}`;
const HASH_D = `sha256:${"d".repeat(64)}`;

function validManifest(): NotebookGuideManifest {
  return {
    notebookId: "nb-assembly-byte-sum",
    title: "Assembly Byte-Sum Tutorial",
    tenantId: "tenant-a",
    educatorRoleRevision: "rev-1",
    reviewerRoleRevision: "rev-1",
    sourceJobIds: ["job-asm-byte-sum-1"],
    sourceArtifactHashes: [HASH_B],
    kernelId: "python3",
    runtimeLockHash: HASH_C,
    notebookHash: HASH_D,
    executedNotebookHash: null,
    status: "draft",
  };
}

function validLesson(): NotebookLesson {
  return {
    title: "Reproducing the RV32I byte-sum job",
    objectives: ["Understand how the verified byte-sum job was executed"],
    prerequisites: ["Basic RV32I assembly"],
    environment: ["kernel: python3", "runtime lock: assembly 2.40"],
    explanation: ["The job sums bytes in memory and exits with the sum."],
    steps: [
      { title: "Load the verified artifact", code: "artifact_uri = 'artifact://tenant-a/job-asm-byte-sum-1/stdout'" },
      { title: "Recompute the checksum", code: "print(sum(b'hello'))" },
    ],
    checks: [{ name: "byte sum matches job output", expected: "532" }],
    errorGuidance: [{ symptom: "SimulationError", guidance: "Check the exit ecall uses a7=93." }],
    exercises: [{ prompt: "Modify the program to sum 16 bytes.", hint: "Extend the data section." }],
    citations: [{ jobId: "job-asm-byte-sum-1", artifactHash: HASH_B, note: "verified stdout" }],
  };
}

describe("validateNotebookGuideManifest", () => {
  it("合法 manifest 通过", () => {
    const result = validateNotebookGuideManifest(validManifest(), { expectedTenantId: "tenant-a" });
    expect(result.ok).toBe(true);
  });

  it("sourceJobIds 为空时拒绝", () => {
    const result = validateNotebookGuideManifest(
      { ...validManifest(), sourceJobIds: [] },
      { expectedTenantId: "tenant-a" },
    );
    expect(result.ok).toBe(false);
  });

  it("sourceArtifactHashes 为空时拒绝", () => {
    const result = validateNotebookGuideManifest(
      { ...validManifest(), sourceArtifactHashes: [] },
      { expectedTenantId: "tenant-a" },
    );
    expect(result.ok).toBe(false);
  });

  it("artifactHash 不是 sha256 digest 时拒绝", () => {
    const result = validateNotebookGuideManifest(
      { ...validManifest(), sourceArtifactHashes: ["not-a-hash"] },
      { expectedTenantId: "tenant-a" },
    );
    expect(result.ok).toBe(false);
  });

  it("跨租户拒绝：manifest.tenantId 与 expectedTenantId 不一致", () => {
    const result = validateNotebookGuideManifest(
      { ...validManifest(), tenantId: "tenant-b" },
      { expectedTenantId: "tenant-a" },
    );
    expect(result.ok).toBe(false);
  });

  it("非 draft 状态必须有 executedNotebookHash（历史输出不能替代本轮执行）", () => {
    const result = validateNotebookGuideManifest(
      { ...validManifest(), status: "executed" },
      { expectedTenantId: "tenant-a" },
    );
    expect(result.ok).toBe(false);
  });
});

describe("buildNotebookGuide 确定性", () => {
  it("同一 canonical 输入两次生成字节一致", () => {
    const first = buildNotebookGuide(validLesson());
    const second = buildNotebookGuide(validLesson());
    expect(first.bytes).toBe(second.bytes);
    expect(first.notebook.nbformat).toBe(4);
    expect(first.notebook.nbformat_minor).toBe(5);
  });

  it("cell id 从 canonical 输入派生：输入不变 id 不变，输入变化 id 变化", () => {
    const first = buildNotebookGuide(validLesson());
    const second = buildNotebookGuide(validLesson());
    expect(first.notebook.cells.map((c) => c.id)).toEqual(second.notebook.cells.map((c) => c.id));
    const changed = buildNotebookGuide({ ...validLesson(), objectives: [...validLesson().objectives, "extra objective"] });
    expect(changed.bytes).not.toBe(first.bytes);
    expect(changed.notebook.cells.map((c) => c.id)).not.toEqual(first.notebook.cells.map((c) => c.id));
  });

  it("bytes 中不含时间戳或随机 id 模式", () => {
    const { bytes } = buildNotebookGuide(validLesson());
    expect(bytes).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

describe("scanNotebook", () => {
  it("干净 notebook 三扫皆为空", () => {
    const { notebook } = buildNotebookGuide(validLesson());
    expect(scanNotebook(notebook)).toEqual({ secrets: [], absolutePaths: [], oversizedOutputs: [] });
  });

  it("检出源码中的凭据", () => {
    const { notebook } = buildNotebookGuide({
      ...validLesson(),
      steps: [{ title: "leak", code: "api_key = 'sk-live-1234567890abcdef'" }],
    });
    const scan = scanNotebook(notebook);
    expect(scan.secrets.length).toBeGreaterThan(0);
  });

  it("检出宿主绝对路径", () => {
    const { notebook } = buildNotebookGuide({
      ...validLesson(),
      steps: [{ title: "host path", code: "data = open('/Users/alice/private/data.bin').read()" }],
    });
    const scan = scanNotebook(notebook);
    expect(scan.absolutePaths.length).toBeGreaterThan(0);
  });

  it("检出超限输出", () => {
    const { notebook } = buildNotebookGuide(validLesson());
    const big = "x".repeat(128 * 1024 + 1);
    notebook.cells.push({
      cell_type: "code",
      id: "cell-injected-output",
      metadata: {},
      source: "print('x')",
      execution_count: 1,
      outputs: [{ output_type: "stream", name: "stdout", text: big }],
    });
    const scan = scanNotebook(notebook);
    expect(scan.oversizedOutputs.length).toBeGreaterThan(0);
  });
});
