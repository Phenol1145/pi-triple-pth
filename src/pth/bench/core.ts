/**
 * pth/bench/core.ts —— PTH Bench W0：统一抽象核心类型与纯函数。
 *
 * 设计依据：docs/pth/design/pth-bench-unified-design.md。
 * 本模块只做数据/纯函数，不依赖服务；driver/target 由后续 wave 接入。
 */

export interface BenchExecPolicy {
  repeats: number;
  warmup: number;
  concurrency: number;
  timeoutMs: number;
  execMode?: "tool-call" | "asp" | "ptc" | "pulse";
  env?: Record<string, string>;
}

export interface BenchScenario {
  id: string;
  title: string;
  tags?: string[];
  execPolicy?: Partial<BenchExecPolicy>;
  graders: BenchGrader[];
}

export type BenchGrader =
  | { kind: "status"; expect: string }
  | { kind: "value"; path: string; equals?: unknown; contains?: unknown; approx?: number }
  | { kind: "latency"; maxMs?: number; field?: "totalMs" | "execMs" }
  | { kind: "tokens"; maxTotal?: number; maxInput?: number; maxOutput?: number };

export interface BenchRunRecord {
  scenarioId: string;
  repeat: number;
  startedAt: string;
  status: string;
  timing: { totalMs: number; queueMs?: number; execMs?: number };
  value?: unknown;
  error?: string | null;
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
}

export interface BenchGrade {
  pass: boolean;
  score: number;
  reason?: string;
}

export interface BenchScenarioResult {
  scenarioId: string;
  grades: BenchGrade[];
  score: number;
  runs: BenchRunRecord[];
}

export interface BenchReport {
  reportVersion: 1;
  ts: string;
  suite: string;
  results: BenchScenarioResult[];
  summary: { total: number; passed: number; meanScore: number; wallMs: number };
}

function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object" && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

function approxEq(a: unknown, b: unknown, tolerance?: number): boolean {
  if (typeof a === "number" && typeof b === "number") {
    const t = tolerance ?? 0;
    return Math.abs(a - b) <= t;
  }
  return a === b;
}

export function gradeRun(rec: BenchRunRecord, grader: BenchGrader): BenchGrade {
  switch (grader.kind) {
    case "status":
      return rec.status === grader.expect
        ? { pass: true, score: 1 }
        : { pass: false, score: 0, reason: `status=${rec.status}, expect=${grader.expect}` };
    case "value": {
      const actual = getPath(rec.value, grader.path);
      if (grader.equals !== undefined) {
        return approxEq(actual, grader.equals, grader.approx)
          ? { pass: true, score: 1 }
          : { pass: false, score: 0, reason: `${grader.path}=${JSON.stringify(actual)}` };
      }
      if (grader.contains !== undefined) {
        const pass = typeof actual === "string" && actual.includes(String(grader.contains));
        return pass ? { pass: true, score: 1 } : { pass: false, score: 0, reason: `${grader.path} 不含 ${grader.contains}` };
      }
      return actual !== undefined ? { pass: true, score: 1 } : { pass: false, score: 0, reason: `${grader.path} 缺失` };
    }
    case "latency": {
      const ms = grader.field === "execMs" ? rec.timing.execMs ?? rec.timing.totalMs : rec.timing.totalMs;
      if (grader.maxMs !== undefined && ms > grader.maxMs) {
        return { pass: false, score: 0, reason: `${grader.field ?? "totalMs"}=${ms} > ${grader.maxMs}` };
      }
      return { pass: true, score: 1 };
    }
    case "tokens": {
      const input = rec.usage?.inputTokens ?? 0;
      const output = rec.usage?.outputTokens ?? 0;
      const total = input + output;
      if (grader.maxTotal !== undefined && total > grader.maxTotal) return { pass: false, score: 0, reason: `tokens=${total} > ${grader.maxTotal}` };
      if (grader.maxInput !== undefined && input > grader.maxInput) return { pass: false, score: 0, reason: `input=${input} > ${grader.maxInput}` };
      if (grader.maxOutput !== undefined && output > grader.maxOutput) return { pass: false, score: 0, reason: `output=${output} > ${grader.maxOutput}` };
      return { pass: true, score: 1 };
    }
  }
}

export function scoreScenario(scenarioId: string, runs: BenchRunRecord[], graders: BenchGrader[]): BenchScenarioResult {
  const grades = runs.map((r) => graders.map((g) => gradeRun(r, g))).flat();
  const score = grades.length > 0 ? grades.reduce((s, g) => s + g.score, 0) / grades.length : 0;
  return { scenarioId, grades, score, runs };
}

export function buildReport(suite: string, results: BenchScenarioResult[], wallMs: number): BenchReport {
  const passed = results.filter((r) => r.score >= 0.999).length;
  const meanScore = results.length > 0 ? results.reduce((s, r) => s + r.score, 0) / results.length : 0;
  return {
    reportVersion: 1,
    ts: new Date().toISOString(),
    suite,
    results,
    summary: { total: results.length, passed, meanScore, wallMs },
  };
}
