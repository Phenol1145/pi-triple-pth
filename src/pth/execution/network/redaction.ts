/**
 * execution/network/redaction.ts — 敏感 query/URL 输入识别与脱敏。
 *
 * V1 只用于策略拒绝与 trace 脱敏；绝不把完整敏感 query 写入普通日志。
 */

const SENSITIVE_KEY_RE = /(?:api[_-]?key|apikey|secret|password|passwd|authorization|auth|access[_-]?token|token|bearer)/i;

const SENSITIVE_ASSIGN_RE = /(api[_-]?key|apikey|secret|password|passwd|authorization|auth|access[_-]?token|token|bearer)\s*[=:]\s*[^\s&,;]+/gi;

/** 是否命中敏感键名（策略拒绝用）。 */
export function containsSensitiveInput(input: string): boolean {
  return SENSITIVE_KEY_RE.test(input);
}

/** 把 `key=value` / `key: value` 形态的敏感值替换为 `[REDACTED]`。 */
export function redactSensitiveInput(input: string): string {
  return input.replace(SENSITIVE_ASSIGN_RE, "$1=[REDACTED]");
}

/** 更保守的 URL query 脱敏：对 `?` 后每个键值对中敏感键的值打码。 */
export function redactSensitiveQuery(query: string): string {
  if (!/[?&]/.test(query)) return redactSensitiveInput(query);
  try {
    const isUrl = /^https?:\/\//i.test(query);
    const url = new URL(isUrl ? query : `https://placeholder.invalid/?${query.replace(/^\?/, "")}`);
    const redacted = new URL(url.toString());
    for (const key of [...redacted.searchParams.keys()]) {
      if (SENSITIVE_KEY_RE.test(key)) redacted.searchParams.set(key, "[REDACTED]");
    }
    const out = isUrl ? redacted.toString() : redacted.search.replace(/^\?/, "");
    return out.replace(/%5BREDACTED%5D/g, "[REDACTED]");
  } catch {
    return redactSensitiveInput(query);
  }
}
