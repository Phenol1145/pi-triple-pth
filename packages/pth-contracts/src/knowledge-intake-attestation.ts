/**
 * contracts/knowledge-intake-attestation.ts — N29 再验收 P0-3：Trust Policy “已验证”的运行时 attestation。
 *
 * 背景（再验收反馈 §3 P0-3 / §8 条件 3）：`VerifiedTrustPolicy` 是 TypeScript **结构**接口，
 * 任何进程内调用者都能构造同形普通对象（含伪造 signature/digest）并让仓库把它写成“已验证”。
 * 类型名、注释与调用约定都不是信任边界，因此这里给出唯一的运行时可验证边界：
 *
 *  - `POLICY_VERIFIED_BRAND` 是模块内唯一 Symbol；**不从 contracts barrel（index.ts）导出**，
 *    只有验签实现（`execution/knowledge-intake/trust-policy.ts`）与需要校验的持久化边界显式 import；
 *  - 盖章同时写入模块私有 `WeakMap`：读取时要求 “Symbol 属性值 === WeakMap 中登记的同一 attestation 对象”，
 *    因此 `{...verified}`、`JSON.parse(JSON.stringify(verified))`、手工再贴一个同名属性都不成立
 *    （Symbol 属性以 non-enumerable/non-writable/non-configurable 定义，拷贝拿不到、也改不掉）；
 *  - attestation 记录验签当时的 policy 身份（tenant/policyId/version/digest）与签发人（human principal），
 *    持久化边界可以据此与 manifest 对账，避免“先验签、后换 manifest”。
 *
 * 边界约束：本文件只做纯内存 attestation 记账，不做签名/摘要计算（那属于 execution 层验签实现），
 * 也不引入任何运行时依赖（contracts 纯度规则）。
 */

import type { TrustPolicyManifest } from "./knowledge-intake.js";

/**
 * 运行时 attestation 品牌。故意不进 `contracts/index.ts` barrel：
 * 只有验签器与需要校验的写边界应当知道它，普通业务代码拿不到、也不该拿。
 */
export const POLICY_VERIFIED_BRAND: unique symbol = Symbol("pth.knowledge-intake.verified-trust-policy");

/** 验签当时被固定下来的事实（写边界只信这里，不信调用方另外传入的字段）。 */
export interface VerifiedPolicyAttestation {
  readonly tenantId: string;
  readonly policyId: string;
  readonly policyVersion: string;
  /** 由验签器用生产 canonical 算法计算并与 manifest.digest 比对通过的摘要。 */
  readonly digest: string;
  /** 签发人必须是人类 principal（kind=human, issuer=ptl-human-interface）。 */
  readonly signerKind: "human";
  readonly signerPrincipalId: string;
  readonly signerIssuer: string;
  /** 只支持 signed-manifest（Ed25519 detached signature）。 */
  readonly approvalMethod: string;
  readonly approvalKeyId: string;
  /** 验签时刻（ISO）。 */
  readonly verifiedAt: string;
}

/** 带运行时 attestation 的 `VerifiedTrustPolicy`：只能由验签器签发。 */
export type AttestedPolicy<T> = T & { readonly [POLICY_VERIFIED_BRAND]: VerifiedPolicyAttestation };

/** 模块私有登记簿：`attest` 之外没有任何写入口，拷贝对象也不会出现在这里。 */
const ATTESTED = new WeakMap<object, VerifiedPolicyAttestation>();

function isPlainNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

function assertAttestationShape(a: VerifiedPolicyAttestation): void {
  const fields: readonly (keyof VerifiedPolicyAttestation)[] = [
    "tenantId", "policyId", "policyVersion", "digest",
    "signerPrincipalId", "signerIssuer", "approvalMethod", "approvalKeyId", "verifiedAt",
  ];
  for (const f of fields) {
    if (!isPlainNonEmptyString(a[f])) {
      throw new Error(`verified policy attestation requires a non-empty ${String(f)}`);
    }
  }
  if (a.signerKind !== "human") {
    throw new Error("verified policy attestation requires signerKind=human");
  }
}

/**
 * 给验签结果盖运行时 attestation（只应由 `loadVerifiedTrustPolicy()` 在全部校验通过后调用）。
 *
 * 返回同一个对象引用（调用方随后可 `Object.freeze`）；重复盖章视为编程错误。
 */
export function attestVerifiedTrustPolicy<T extends object>(
  policy: T,
  attestation: VerifiedPolicyAttestation,
): AttestedPolicy<T> {
  assertAttestationShape(attestation);
  if (ATTESTED.has(policy) || Object.prototype.hasOwnProperty.call(policy, POLICY_VERIFIED_BRAND)) {
    throw new Error("verified trust policy is already attested");
  }
  const frozen = Object.freeze({ ...attestation });
  Object.defineProperty(policy, POLICY_VERIFIED_BRAND, {
    value: frozen,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  ATTESTED.set(policy, frozen);
  return policy as AttestedPolicy<T>;
}

/**
 * 读取运行时 attestation；不是验签器签发的那个对象一律返回 null。
 *
 * 双条件：Symbol 属性存在 **且** 与模块私有 WeakMap 登记的 attestation 是同一个对象。
 */
export function readVerifiedPolicyAttestation(candidate: unknown): VerifiedPolicyAttestation | null {
  if (typeof candidate !== "object" || candidate === null) return null;
  const registered = ATTESTED.get(candidate as object);
  if (registered === undefined) return null;
  const stamped = (candidate as Record<PropertyKey, unknown>)[POLICY_VERIFIED_BRAND];
  if (stamped !== registered) return null;
  return registered;
}

/** 运行时判定：该对象是否由验签器签发。 */
export function isVerifiedTrustPolicyAttested(candidate: unknown): boolean {
  return readVerifiedPolicyAttestation(candidate) !== null;
}

/**
 * attestation 与 manifest 的对账（写边界纵深防御）：验签后不得换 manifest 身份。
 * 返回不一致原因，一致时返回 null。
 */
export function attestationMismatchReason(
  attestation: VerifiedPolicyAttestation,
  manifest: TrustPolicyManifest,
): string | null {
  if (attestation.tenantId !== manifest.tenantId) {
    return `attested tenant ${attestation.tenantId} != manifest tenant ${manifest.tenantId}`;
  }
  if (attestation.policyId !== manifest.policyId) {
    return `attested policyId ${attestation.policyId} != manifest policyId ${manifest.policyId}`;
  }
  if (attestation.policyVersion !== manifest.version) {
    return `attested version ${attestation.policyVersion} != manifest version ${manifest.version}`;
  }
  if (attestation.digest !== manifest.digest) {
    return `attested digest ${attestation.digest} != manifest digest ${manifest.digest}`;
  }
  if (attestation.signerPrincipalId !== manifest.approvedBy?.principalId) {
    return `attested signer ${attestation.signerPrincipalId} != manifest approvedBy.principalId`;
  }
  if (attestation.approvalKeyId !== manifest.approvalProof?.keyId) {
    return `attested keyId ${attestation.approvalKeyId} != manifest approvalProof.keyId`;
  }
  return null;
}
