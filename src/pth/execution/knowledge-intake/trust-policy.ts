/**
 * trust-policy.ts — N29 Task 2：人类签名 Trust Policy 的验证与双阶段 matcher。
 *
 *  - canonical digest：稳定 JSON 序列化（键排序），排除 approvalProof.signature 与顶层 digest，
 *    拒绝 NaN/Infinity/非普通对象；digest = sha256(canonical bytes) 的 base64url。
 *  - Ed25519 detached signature：仅 approvalProof.method="signed-manifest"；
 *    公钥只来自 read-only keyring（stable human principal -> PEM public key）。
 *  - authorizeFetch：deny-first；exact https origin/pathPrefix/tenant/space/redirectOrigins/
 *    sourceTypes/contentTypes/licenses/maxBytes；未命中 fail closed。
 *  - authorizeUse：在 fetch 之上追加 domains 与订阅/策略时效、撤销检查。
 */

import { createHash, timingSafeEqual, verify as cryptoVerify } from "node:crypto";
import {
  isTrustPolicyManifestStructurallyValid,
  type FetchAuthorizationInput,
  type FetchPolicyDecision,
  type TrustPolicyManifest,
  type TrustPolicyRule,
  type UseAuthorizationInput,
  type UsePolicyDecision,
  type VerifiedTrustPolicy,
} from "../../contracts/index.js";

export type TrustPolicyKeyring = Readonly<Record<string, string>>;
export type TrustPolicyClock = Readonly<{ now(): Date }> | (() => Date);

const HUMAN_ISSUER = "ptl-human-interface";

function nowOf(clock: TrustPolicyClock | undefined): Date {
  if (!clock) return new Date();
  if (typeof clock === "function") return clock();
  return clock.now();
}

// ─── canonical digest ─────────────────────────────────────────────────

function canonicalJson(value: unknown, path: string): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`trust policy digest: non-finite number at ${path}`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v, i) => canonicalJson(v, `${path}[${i}]`)).join(",")}]`;
  }
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value) as unknown;
    if (proto !== Object.prototype && proto !== null) {
      throw new Error(`trust policy digest: non-plain object at ${path}`);
    }
    const rec = value as Record<string, unknown>;
    return `{${Object.keys(rec).sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k], `${path}.${k}`)}`)
      .join(",")}}`;
  }
  throw new Error(`trust policy digest: unsupported ${typeof value} at ${path}`);
}

function signingPayload(manifest: TrustPolicyManifest): Record<string, unknown> {
  const { digest: _digest, approvalProof, ...rest } = manifest as TrustPolicyManifest & Record<string, unknown>;
  return {
    ...rest,
    approvalProof: {
      method: approvalProof.method,
      keyId: approvalProof.keyId,
    },
  };
}

/** 签名/摘要使用的规范字节：排除 approvalProof.signature 与顶层 digest。 */
export function canonicalPolicySigningBytes(manifest: TrustPolicyManifest): Buffer {
  return Buffer.from(canonicalJson(signingPayload(manifest), "$"), "utf8");
}

/** sha256(canonical signing bytes)，base64url 无 padding。 */
export function computePolicyDigest(manifest: TrustPolicyManifest): string {
  return createHash("sha256").update(canonicalPolicySigningBytes(manifest)).digest("base64url");
}

// ─── Ed25519 detached signature ───────────────────────────────────────

function decodeDetachedSignature(signature: string): Buffer {
  const compact = signature.replace(/\s/g, "");
  if (compact === "") throw new Error("trust policy signature is empty");
  const buf = Buffer.from(compact, "base64");
  if (buf.length === 0) throw new Error("trust policy signature is not valid base64");
  return buf;
}

/** 只验证签名本身；密钥形态由调用方负责。 */
export function verifyPolicySignature(manifest: TrustPolicyManifest, publicKeyPem: string): boolean {
  const signature = decodeDetachedSignature(manifest.approvalProof.signature);
  const data = canonicalPolicySigningBytes(manifest);
  return cryptoVerify(null, data, publicKeyPem, signature);
}

// ─── 规则/URL 工具 ────────────────────────────────────────────────────

function parseHttpsUrl(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  return url;
}

function parseExactHttpsOrigin(value: string): URL | null {
  const url = parseHttpsUrl(value);
  if (!url) return null;
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
  return url;
}

function validateRuleShape(rule: TrustPolicyRule, ruleIndex: number, manifest: TrustPolicyManifest): void {
  const origin = parseExactHttpsOrigin(rule.httpsOrigin);
  if (!origin) {
    throw new Error(`trust policy rule ${rule.ruleId ?? ruleIndex}: httpsOrigin must be an exact https origin`);
  }
  if (!rule.pathPrefix.startsWith("/")) {
    throw new Error(`trust policy rule ${rule.ruleId ?? ruleIndex}: pathPrefix must start with "/"`);
  }
  if (!Number.isInteger(rule.maxBytes) || rule.maxBytes <= 0) {
    throw new Error(`trust policy rule ${rule.ruleId ?? ruleIndex}: maxBytes must be a positive integer`);
  }
  for (const redirect of rule.redirectOrigins) {
    if (!parseExactHttpsOrigin(redirect)) {
      throw new Error(`trust policy rule ${rule.ruleId ?? ruleIndex}: redirectOrigins must be exact https origins`);
    }
  }
  for (const space of rule.spaces) {
    if (!manifest.spaces.includes(space)) {
      throw new Error(`trust policy rule ${rule.ruleId ?? ruleIndex}: authorizes space outside manifest spaces`);
    }
  }
}

function decisionRef(
  manifest: TrustPolicyManifest,
  ruleId: string,
  decision: "allow" | "deny",
  decidedAt: Date,
): Omit<FetchPolicyDecision, "reason"> {
  return {
    policyId: manifest.policyId,
    policyVersion: manifest.version,
    policyDigest: manifest.digest,
    ruleId,
    decision,
    decidedAt: decidedAt.toISOString(),
  };
}

function ruleMatchesFetch(
  manifest: TrustPolicyManifest,
  rule: TrustPolicyRule,
  url: URL,
  redirectOrigins: readonly string[],
  input: FetchAuthorizationInput,
): boolean {
  if (input.tenantId !== manifest.tenantId) return false;
  if (!manifest.spaces.includes(input.space) || !rule.spaces.includes(input.space)) return false;
  if (url.origin !== new URL(rule.httpsOrigin).origin) return false;
  if (!url.pathname.startsWith(rule.pathPrefix)) return false;
  if (!redirectOrigins.every((origin) => rule.redirectOrigins.includes(origin))) return false;
  if (!rule.sourceTypes.includes(input.sourceType)) return false;
  if (!rule.contentTypes.includes(input.contentType)) return false;
  if (!rule.licenses.includes(input.license)) return false;
  if (!Number.isInteger(input.byteLength) || input.byteLength < 0 || input.byteLength > rule.maxBytes) return false;
  return true;
}

function normalizeRedirectOrigins(input: FetchAuthorizationInput): readonly string[] | null {
  const out: string[] = [];
  for (const origin of input.redirectOrigins) {
    const parsed = parseExactHttpsOrigin(origin);
    if (!parsed) return null;
    out.push(parsed.origin);
  }
  return out;
}

// ─── 双阶段 matcher ───────────────────────────────────────────────────

function policyWindowDecision(
  manifest: TrustPolicyManifest,
  now: Date,
): FetchPolicyDecision | null {
  const validFrom = Date.parse(manifest.validFrom);
  const validUntil = Date.parse(manifest.validUntil);
  if (now.getTime() >= validUntil) {
    return { ...decisionRef(manifest, "fail-closed", "deny", now), reason: "trust policy expired" };
  }
  if (now.getTime() < validFrom) {
    return { ...decisionRef(manifest, "fail-closed", "deny", now), reason: "trust policy not yet valid" };
  }
  return null;
}

export function authorizeFetch(
  manifest: TrustPolicyManifest,
  input: FetchAuthorizationInput,
  clock?: TrustPolicyClock,
): FetchPolicyDecision {
  const now = nowOf(clock);
  const windowDecision = policyWindowDecision(manifest, now);
  if (windowDecision) return windowDecision;

  const url = parseHttpsUrl(input.url);
  if (!url) {
    return { ...decisionRef(manifest, "fail-closed", "deny", now), reason: "fetch url must be an https URL" };
  }
  const redirectOrigins = normalizeRedirectOrigins(input);
  if (redirectOrigins === null) {
    return { ...decisionRef(manifest, "fail-closed", "deny", now), reason: "redirectOrigins must be exact https origins" };
  }

  let firstDeny: FetchPolicyDecision | null = null;
  let firstAllow: FetchPolicyDecision | null = null;
  for (const rule of manifest.rules) {
    if (!ruleMatchesFetch(manifest, rule, url, redirectOrigins, input)) continue;
    if (rule.effect === "deny") {
      if (!firstDeny) {
        firstDeny = { ...decisionRef(manifest, rule.ruleId, "deny", now), reason: `deny rule ${rule.ruleId} matched` };
      }
    } else if (!firstAllow) {
      firstAllow = { ...decisionRef(manifest, rule.ruleId, "allow", now), reason: `allow rule ${rule.ruleId} matched` };
    }
  }
  if (firstDeny) return firstDeny;
  if (firstAllow) return firstAllow;
  return { ...decisionRef(manifest, "fail-closed", "deny", now), reason: "no matching allow rule" };
}

function subscriptionUseDecision(
  manifest: TrustPolicyManifest,
  input: UseAuthorizationInput,
  now: Date,
): UsePolicyDecision | null {
  if (input.subscriptionStatus !== undefined) {
    if (input.subscriptionStatus === "revoked") {
      return { ...decisionRef(manifest, "fail-closed", "deny", now), reason: "subscription revoked" };
    }
    if (input.subscriptionStatus === "paused" || input.subscriptionStatus === "retired") {
      return { ...decisionRef(manifest, "fail-closed", "deny", now), reason: `subscription ${input.subscriptionStatus}` };
    }
  }
  if (input.subscriptionValidUntil !== undefined) {
    const validUntil = Date.parse(input.subscriptionValidUntil);
    if (!Number.isFinite(validUntil)) {
      return { ...decisionRef(manifest, "fail-closed", "deny", now), reason: "subscription validUntil is invalid" };
    }
    if (now.getTime() >= validUntil) {
      return { ...decisionRef(manifest, "fail-closed", "deny", now), reason: "subscription expired" };
    }
  }
  return null;
}

export function authorizeUse(
  manifest: TrustPolicyManifest,
  input: UseAuthorizationInput,
  clock?: TrustPolicyClock,
): UsePolicyDecision {
  const now = nowOf(clock);
  const windowDecision = policyWindowDecision(manifest, now);
  if (windowDecision) return windowDecision;

  const subscriptionDecision = subscriptionUseDecision(manifest, input, now);
  if (subscriptionDecision) return subscriptionDecision;

  const url = parseHttpsUrl(input.url);
  if (!url) {
    return { ...decisionRef(manifest, "fail-closed", "deny", now), reason: "use url must be an https URL" };
  }
  const redirectOrigins = normalizeRedirectOrigins(input);
  if (redirectOrigins === null) {
    return { ...decisionRef(manifest, "fail-closed", "deny", now), reason: "redirectOrigins must be exact https origins" };
  }

  let firstDeny: UsePolicyDecision | null = null;
  let firstAllow: UsePolicyDecision | null = null;
  for (const rule of manifest.rules) {
    if (!ruleMatchesFetch(manifest, rule, url, redirectOrigins, input)) continue;
    if (!rule.domains.includes(input.domain)) continue;
    if (rule.effect === "deny") {
      if (!firstDeny) {
        firstDeny = { ...decisionRef(manifest, rule.ruleId, "deny", now), reason: `deny rule ${rule.ruleId} matched` };
      }
    } else if (!firstAllow) {
      firstAllow = { ...decisionRef(manifest, rule.ruleId, "allow", now), reason: `allow rule ${rule.ruleId} matched` };
    }
  }
  if (firstDeny) return firstDeny;
  if (firstAllow) return firstAllow;
  return { ...decisionRef(manifest, "fail-closed", "deny", now), reason: "no matching allow rule" };
}

// ─── 加载并验证 ───────────────────────────────────────────────────────

function verifyDigest(manifest: TrustPolicyManifest): void {
  const expected = computePolicyDigest(manifest);
  const actualBuf = Buffer.from(manifest.digest, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) {
    throw new Error("trust policy digest mismatch");
  }
}

/**
 * 验证签名、issuer、有效期与 digest，并返回带 matcher 的 VerifiedTrustPolicy。
 *
 * 只接受 approvalProof.method="signed-manifest"；approvedBy 必须为
 * {kind:"human", principalId, tenantId, issuer:"ptl-human-interface"}。
 * keyring 是 read-only JSON：stable human principal -> PEM public key。
 */
export async function loadVerifiedTrustPolicy(
  manifest: TrustPolicyManifest,
  keyring: TrustPolicyKeyring,
  clock?: TrustPolicyClock,
): Promise<VerifiedTrustPolicy> {
  // 先于结构校验判断“人签”，保证 service/错 issuer 报 human signer 而不是泛化结构错误。
  const approvedByCandidate = (manifest as unknown as { approvedBy?: unknown }).approvedBy as Record<string, unknown> | undefined;
  if (
    typeof approvedByCandidate === "object" && approvedByCandidate !== null &&
    (approvedByCandidate.kind !== "human" || approvedByCandidate.issuer !== HUMAN_ISSUER)
  ) {
    throw new Error("trust policy must be signed by a human signer (kind=human, issuer=ptl-human-interface)");
  }

  if (!isTrustPolicyManifestStructurallyValid(manifest)) {
    throw new Error("invalid trust policy manifest");
  }

  const validFrom = Date.parse(manifest.validFrom);
  const validUntil = Date.parse(manifest.validUntil);

  if (manifest.approvalProof.method !== "signed-manifest") {
    throw new Error(`unsupported approval proof method: ${manifest.approvalProof.method}`);
  }

  const approvedBy = manifest.approvedBy;
  if (approvedBy.kind !== "human" || approvedBy.issuer !== HUMAN_ISSUER) {
    throw new Error("trust policy must be signed by a human signer (kind=human, issuer=ptl-human-interface)");
  }
  if (approvedBy.principalId !== manifest.approvalProof.keyId) {
    throw new Error("trust policy signer principal does not match approval proof key");
  }
  if (approvedBy.tenantId !== manifest.tenantId) {
    throw new Error("trust policy approvedBy tenant does not match manifest tenant");
  }

  manifest.rules.forEach((rule, index) => validateRuleShape(rule, index, manifest));

  const publicKeyPem = keyring[manifest.approvalProof.keyId];
  if (typeof publicKeyPem !== "string" || publicKeyPem.trim() === "") {
    throw new Error("unknown human principal in keyring");
  }
  if (publicKeyPem.includes("PRIVATE KEY")) {
    throw new Error("keyring must contain only public keys");
  }

  let signatureOk = false;
  try {
    signatureOk = verifyPolicySignature(manifest, publicKeyPem);
  } catch (error) {
    throw new Error(
      `trust policy signature verification failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!signatureOk) {
    throw new Error("trust policy signature verification failed");
  }

  verifyDigest(manifest);

  const now = nowOf(clock);
  if (now.getTime() >= validUntil) {
    throw new Error("trust policy expired");
  }
  if (now.getTime() < validFrom) {
    throw new Error("trust policy not yet valid");
  }

  return Object.freeze({
    manifest,
    authorizeFetch: (input: FetchAuthorizationInput): FetchPolicyDecision =>
      authorizeFetch(manifest, input, clock),
    authorizeUse: (input: UseAuthorizationInput): UsePolicyDecision =>
      authorizeUse(manifest, input, clock),
  });
}
