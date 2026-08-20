/**
 * execution/notebook-guide.ts — v1.3 Task 9 Step 3 确定性 nbformat v4 生成器 + 隐藏状态扫描。
 *
 *  - 九段 typed lesson 模型：objectives / prerequisites / environment / explanation /
 *    steps / checks / errorGuidance / exercises / citations。
 *  - cell 顺序与 cell id 全部由 canonical lesson 输入派生（sha256），
 *    不含随机数、时间戳或任何 LLM 生成的任意元数据；同一 canonical 输入两次
 *    生成字节一致。
 *  - scanNotebook 三扫：secrets / 宿主绝对路径 / 超限输出；干净 notebook 必须三空。
 */

import { createHash } from "node:crypto";

// ─── 九段 typed lesson 模型 ─────────────────────────────────────────────────

export interface NotebookLessonStep {
  readonly title: string;
  readonly code: string;
}

export interface NotebookLessonCheck {
  readonly name: string;
  readonly expected: string;
}

export interface NotebookLessonErrorGuidance {
  readonly symptom: string;
  readonly guidance: string;
}

export interface NotebookLessonExercise {
  readonly prompt: string;
  readonly hint?: string;
}

export interface NotebookLessonCitation {
  readonly jobId: string;
  readonly artifactHash?: string;
  readonly note?: string;
}

export interface NotebookLesson {
  readonly title: string;
  readonly objectives: readonly string[];
  readonly prerequisites: readonly string[];
  readonly environment: readonly string[];
  readonly explanation: readonly string[];
  readonly steps: readonly NotebookLessonStep[];
  readonly checks: readonly NotebookLessonCheck[];
  readonly errorGuidance: readonly NotebookLessonErrorGuidance[];
  readonly exercises: readonly NotebookLessonExercise[];
  readonly citations: readonly NotebookLessonCitation[];
}

// ─── nbformat v4.5 类型（本项目最小子集） ───────────────────────────────────

export interface NotebookOutput {
  readonly output_type: string;
  readonly [key: string]: unknown;
}

export interface NotebookCell {
  readonly cell_type: "markdown" | "code";
  readonly id: string;
  readonly metadata: Record<string, never>;
  readonly source: string;
  readonly execution_count?: number | null;
  readonly outputs?: NotebookOutput[];
}

export interface NotebookDocument {
  readonly nbformat: 4;
  readonly nbformat_minor: 5;
  readonly metadata: {
    readonly kernelspec: { readonly display_name: string; readonly language: string; readonly name: string };
    readonly language_info: { readonly name: string };
  };
  readonly cells: NotebookCell[];
}

// ─── canonical 序列化与 id 派生 ─────────────────────────────────────────────

/** 递归排序键的稳定 JSON；用于把 lesson 变成 canonical 输入。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function deriveCellId(canonicalLesson: string, ordinal: number): string {
  const digest = createHash("sha256").update(canonicalLesson).update(`:${ordinal}`).digest("hex");
  return `cell-${digest.slice(0, 16)}`;
}

// ─── builder ───────────────────────────────────────────────────────────────

export interface BuiltNotebookGuide {
  readonly notebook: NotebookDocument;
  /** 确定性字节序列：同一 canonical 输入两次生成完全一致。 */
  readonly bytes: string;
}

export function buildNotebookGuide(lesson: NotebookLesson): BuiltNotebookGuide {
  const canonicalLesson = canonicalJson(lesson);
  const segments: Array<{ cell_type: "markdown" | "code"; source: string }> = [];

  // 1. 目标（含标题）
  segments.push({
    cell_type: "markdown",
    source: `# ${lesson.title}\n\n## Objectives\n${lesson.objectives.map((o) => `- ${o}`).join("\n")}`,
  });
  // 2. 前置知识
  segments.push({
    cell_type: "markdown",
    source: `## Prerequisites\n${lesson.prerequisites.map((p) => `- ${p}`).join("\n")}`,
  });
  // 3. 环境
  segments.push({
    cell_type: "markdown",
    source: `## Environment\n${lesson.environment.map((e) => `- ${e}`).join("\n")}`,
  });
  // 4. 讲解
  segments.push({
    cell_type: "markdown",
    source: `## Explanation\n${lesson.explanation.join("\n\n")}`,
  });
  // 5. 分步操作（标题 markdown + 可执行 code）
  lesson.steps.forEach((step, index) => {
    segments.push({ cell_type: "markdown", source: `## Step ${index + 1}: ${step.title}` });
    segments.push({ cell_type: "code", source: step.code });
  });
  // 6. 预期检查
  segments.push({
    cell_type: "markdown",
    source: `## Expected Checks\n${lesson.checks.map((c) => `- **${c.name}**: \`${c.expected}\``).join("\n")}`,
  });
  // 7. 常见错误
  segments.push({
    cell_type: "markdown",
    source: `## Error Guidance\n${lesson.errorGuidance.map((g) => `- **${g.symptom}** — ${g.guidance}`).join("\n")}`,
  });
  // 8. 练习
  segments.push({
    cell_type: "markdown",
    source: `## Exercises\n${lesson.exercises.map((e) => `- ${e.prompt}${e.hint ? ` (hint: ${e.hint})` : ""}`).join("\n")}`,
  });
  // 9. 来源与版本
  segments.push({
    cell_type: "markdown",
    source: `## Citations\n${lesson.citations.map((c) =>
      `- job \`${c.jobId}\`${c.artifactHash ? ` artifact \`${c.artifactHash}\`` : ""}${c.note ? ` — ${c.note}` : ""}`,
    ).join("\n")}`,
  });

  const cells: NotebookCell[] = segments.map((segment, ordinal) => {
    if (segment.cell_type === "markdown") {
      return { cell_type: "markdown", id: deriveCellId(canonicalLesson, ordinal), metadata: {}, source: segment.source };
    }
    return {
      cell_type: "code",
      id: deriveCellId(canonicalLesson, ordinal),
      metadata: {},
      source: segment.source,
      execution_count: null,
      outputs: [],
    };
  });

  const notebook: NotebookDocument = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
      language_info: { name: "python" },
    },
    cells,
  };
  return { notebook, bytes: JSON.stringify(notebook, null, 1) };
}

// ─── scanNotebook 三扫 ─────────────────────────────────────────────────────

export interface NotebookScanFinding {
  readonly cellIndex: number;
  readonly cellId: string;
  readonly outputIndex?: number;
  readonly excerpt: string;
}

export interface NotebookScanReport {
  readonly secrets: readonly NotebookScanFinding[];
  readonly absolutePaths: readonly NotebookScanFinding[];
  readonly oversizedOutputs: readonly NotebookScanFinding[];
}

const DEFAULT_MAX_OUTPUT_BYTES = 128 * 1024;

const SECRET_PATTERNS: readonly RegExp[] = [
  /(?:api[_-]?key|secret|password|passwd|credential)\s*[=:]\s*['"][^'"]{6,}['"]/i,
  /\btoken\s*[=:]\s*['"][^'"]{6,}['"]/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bsk-[A-Za-z0-9-]{16,}\b/,
];

/** 宿主绝对路径：Unix 常见宿主根或 ~ 或 Windows 盘符；不匹配 URL scheme。 */
const ABSOLUTE_PATH_PATTERN = /(?:^|[\s'"(`=])(~?\/(?:Users|home|var|tmp|etc|opt|root|mnt|srv|data)\/[^\s'")`]+)|(?:^|[\s'"(`=])([A-Za-z]:\\[^\s'")`]+)/m;

function scanText(
  text: string,
  cellIndex: number,
  cellId: string,
  patterns: readonly { kind: "secrets" | "absolutePaths"; re: RegExp }[],
  outputIndex?: number,
): Array<{ kind: "secrets" | "absolutePaths"; finding: NotebookScanFinding }> {
  const found: Array<{ kind: "secrets" | "absolutePaths"; finding: NotebookScanFinding }> = [];
  for (const { kind, re } of patterns) {
    const match = re.exec(text);
    if (match) {
      const excerpt = (match[0] ?? "").slice(0, 80);
      const finding: NotebookScanFinding = outputIndex === undefined
        ? { cellIndex, cellId, excerpt }
        : { cellIndex, cellId, outputIndex, excerpt };
      found.push({ kind, finding });
    }
  }
  return found;
}

function outputText(output: NotebookOutput): string {
  const text = output.text ?? output.evalue ?? (isRecord(output.data) ? JSON.stringify(output.data) : "");
  return typeof text === "string" ? text : Array.isArray(text) ? text.join("") : JSON.stringify(text);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function outputBytes(output: NotebookOutput): number {
  return Buffer.byteLength(JSON.stringify(output), "utf8");
}

export function scanNotebook(
  notebook: NotebookDocument,
  opts: { maxOutputBytes?: number } = {},
): NotebookScanReport {
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const secrets: NotebookScanFinding[] = [];
  const absolutePaths: NotebookScanFinding[] = [];
  const oversizedOutputs: NotebookScanFinding[] = [];
  const patterns = [
    ...SECRET_PATTERNS.map((re) => ({ kind: "secrets" as const, re })),
    { kind: "absolutePaths" as const, re: ABSOLUTE_PATH_PATTERN },
  ];

  const cells = Array.isArray(notebook.cells) ? notebook.cells : [];
  cells.forEach((cell, cellIndex) => {
    const cellId = typeof cell.id === "string" ? cell.id : `cell-index-${cellIndex}`;
    const source = typeof cell.source === "string" ? cell.source : "";
    for (const hit of scanText(source, cellIndex, cellId, patterns)) {
      (hit.kind === "secrets" ? secrets : absolutePaths).push(hit.finding);
    }
    const outputs = Array.isArray(cell.outputs) ? cell.outputs : [];
    outputs.forEach((output, outputIndex) => {
      for (const hit of scanText(outputText(output), cellIndex, cellId, patterns, outputIndex)) {
        (hit.kind === "secrets" ? secrets : absolutePaths).push(hit.finding);
      }
      if (outputBytes(output) > maxOutputBytes) {
        oversizedOutputs.push({ cellIndex, cellId, outputIndex, excerpt: `${outputBytes(output)} bytes > ${maxOutputBytes}` });
      }
    });
  });

  return { secrets, absolutePaths, oversizedOutputs };
}
