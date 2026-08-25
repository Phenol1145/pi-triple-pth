/**
 * interaction/presentation.ts —— N25 Presentation / Output Composer。
 *
 * 把内部结果改写为适合用户阅读的文本，保持事实与状态不变。
 */

export interface PresentationOptions {
  format?: "text" | "json";
  maxLength?: number;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `…（截断 ${s.length - max} 字符）`;
}

export function composePresentation(value: unknown, opts: PresentationOptions = {}): string {
  const format = opts.format ?? "text";
  const max = opts.maxLength ?? 4000;
  if (format === "json") {
    return truncate(JSON.stringify(value, null, 2), max);
  }
  if (value === null || value === undefined) return "（无结果）";
  if (typeof value === "string") return truncate(value, max);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const lines = value.map((v) => typeof v === "object" ? JSON.stringify(v) : String(v));
    return truncate(lines.join("\n"), max);
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    return truncate(entries.map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join("\n"), max);
  }
  return truncate(String(value), max);
}

export function composeTaskResult(result: { ok: boolean; value?: unknown; summary?: string }): string {
  if (!result.ok) return `执行失败：${result.summary ?? "未知错误"}`;
  if (result.summary) return result.summary;
  return composePresentation(result.value);
}
