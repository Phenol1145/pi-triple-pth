/**
 * catalog/capability-policy.ts — 能力策略声明与校验（模块化 v2 P3-1）。
 *
 * policy = 显式 allow 面 + deny 面（deny 必须是 allow 的子集——缩小而非扩大）。
 * 非法能力名、重复、deny 越界一律 fail-closed。
 */

export interface CapabilityPolicy {
  readonly allow: readonly string[];
  readonly deny?: readonly string[];
}

export interface CapabilityPolicyValidation {
  ok: boolean;
  error?: string;
}

const CAPABILITY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isCapabilityName(v: unknown): v is string {
  return typeof v === "string" && CAPABILITY_RE.test(v);
}

export function validateCapabilityPolicy(policy: CapabilityPolicy): CapabilityPolicyValidation {
  if (!policy || typeof policy !== "object" || !Array.isArray(policy.allow)) {
    return { ok: false, error: "capability policy: allow list required" };
  }
  if (policy.allow.length === 0) return { ok: false, error: "capability policy: allow list empty（fail-closed）" };
  const allow = [...policy.allow];
  if (allow.some((c) => !isCapabilityName(c))) return { ok: false, error: `capability policy: invalid capability name: ${allow.find((c) => !isCapabilityName(c))}` };
  if (new Set(allow).size !== allow.length) return { ok: false, error: "capability policy: duplicate capability in allow" };

  const deny = policy.deny ?? [];
  if (!Array.isArray(deny)) return { ok: false, error: "capability policy: deny must be array" };
  if (deny.some((c) => !isCapabilityName(c))) return { ok: false, error: "capability policy: invalid deny name" };
  if (new Set(deny).size !== deny.length) return { ok: false, error: "capability policy: duplicate capability in deny" };
  for (const c of deny) {
    if (!allow.includes(c)) return { ok: false, error: `capability policy: deny not in allow: ${c}` };
  }
  return { ok: true };
}
