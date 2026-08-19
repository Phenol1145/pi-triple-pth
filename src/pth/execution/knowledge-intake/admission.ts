/**
 * admission.ts — N29 Task 4：确定性 fetch/use 两阶段准入（第二阶段）。
 *
 * 两阶段语义（计划 §5 Task 4 Step 4）：
 *  - 第一阶段 fetch：`fetch-broker` 只产出不可变 acquisition envelope；对应的 Source Revision
 *    只能以 `raw-quarantine` 落库，任何抽取/晋升都不得读它。
 *  - 第二阶段 use：本模块对 envelope 做**纯确定性**复核，并调用人类签名 policy 的
 *    `authorizeUse()`；只有二者同时通过，才给出「允许写入 admitted revision」的对外判定。
 *
 * 硬约束：
 *  - 不修改、不重算、不回写 envelope——判定结果是一个新对象（envelope 保持 fetch 时的真相）；
 *  - 未知许可、越权 redirect、非 TLS、私网地址、超字节、未批准/不可归一化 content type、
 *    fetch 后策略轮换或过期、订阅撤销/暂停，全部 deny；
 *  - deny 时 raw 保持 quarantine，不产生 admitted revision，也不允许进入 extractor；
 *  - 304 unchanged 只允许复用既有 artifact（`unchanged` revision），不产生 admitted revision。
 */

import {
  type PolicyDecisionRef,
  type SourceRevisionDisposition,
  type SubscriptionStatus,
  type TrustPolicyManifest,
  type TrustPolicyRule,
  type UsePolicyDecision,
  type VerifiedTrustPolicy,
} from "../../contracts/index.js";
import { isPrivateIpLiteral } from "../../impls/kernels/web-transport.js";
import {
  contentTypeEssence,
  intakeNow,
  isApprovableContentType,
  policyDecisionRefOf,
  sha256Hex,
  stableJson,
  type PolicyBoundSourceAcquisitionEnvelope,
} from "./fetch-broker.js";
import type { TrustPolicyClock } from "./trust-policy.js";

export type AdmissionDenyCode =
  | "fetch-decision-not-allow"
  | "policy-changed"
  | "policy-rule-missing"
  | "policy-denied"
  | "subscription-inactive"
  | "insecure-transport"
  | "escaped-redirect"
  | "private-address"
  | "oversized"
  | "artifact-hash-mismatch"
  | "missing-artifact-hash"
  | "content-type-not-approved"
  | "empty-normalized-text"
  | "unknown-license"
  | "source-type-not-approved"
  | "domain-not-approved"
  | "unexpected-status"
  | "tenant-scope-mismatch";

/** admission 只需要 policy 的只读使用面（manifest + authorizeUse）。 */
export type IntakeUsePolicySource = Pick<VerifiedTrustPolicy, "manifest" | "authorizeUse">;

export interface SourceAdmissionDeps {
  /** use 阶段必须读“当前”策略：fetch 后被轮换/撤销即在此翻红。 */
  readonly policy: IntakeUsePolicySource | (() => IntakeUsePolicySource);
  readonly clock?: TrustPolicyClock;
}

export interface SourceAdmissionInput {
  readonly envelope: PolicyBoundSourceAcquisitionEnvelope;
  readonly tenantId: string;
  readonly space: string;
  readonly subscriptionId: string;
  readonly domain: string;
  readonly sourceType: string;
  readonly license: string;
  readonly subscriptionStatus?: SubscriptionStatus;
  readonly subscriptionValidUntil?: string;
}

export interface SourceAdmissionVerdict {
  readonly verdict: "admit" | "reuse-unchanged" | "deny";
  /** raw acquisition 只能以此 disposition 落库（append-only，永不被原地改写）。 */
  readonly quarantinedDisposition: Extract<SourceRevisionDisposition, "raw-quarantine">;
  /** 允许追加的下一条 revision disposition；deny 时缺省（不得写新行）。 */
  readonly nextRevisionDisposition?: Extract<SourceRevisionDisposition, "admitted" | "unchanged">;
  readonly mayStoreAdmittedRevision: boolean;
  readonly mayExtract: boolean;
  readonly denyCodes: readonly AdmissionDenyCode[];
  readonly reasons: readonly string[];
  readonly fetchPolicyDecision: PolicyDecisionRef;
  readonly usePolicyDecision: UsePolicyDecision;
  readonly artifactHash: string;
  readonly normalizedTextHash: string;
  readonly representation: "normalized-text" | "none";
  /** sha256(stableJson({fetch,use}))——IntakeEvidenceReference.policyDecisionDigest 的事实源。 */
  readonly policyDecisionDigest: string;
  readonly decidedAt: string;
}

const ACTIVE_SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = ["probing", "active"];

/**
 * `IntakeEvidenceReference.policyDecisionDigest` 的**唯一**事实源：
 * `sha256(stableJson({fetch, use, artifactHash, normalizedTextHash}))`。
 *
 * L5 起由 admission 与 KnowledgeIngestor 共用同一实现——ingestor 用已落库
 * SourceRevision 的 `fetch_policy_decision` / `use_policy_decision` / `raw_hash` /
 * `normalized_text_hash` 逐字段重算，因此 evidence 自报的 digest 无法伪造。
 */
export function computeIntakePolicyDecisionDigest(input: {
  readonly fetchPolicyDecision: PolicyDecisionRef;
  readonly usePolicyDecision: PolicyDecisionRef;
  readonly artifactHash: string;
  readonly normalizedTextHash: string;
}): string {
  return sha256Hex(
    stableJson({
      fetch: policyDecisionRefOf(input.fetchPolicyDecision),
      use: policyDecisionRefOf(input.usePolicyDecision),
      artifactHash: input.artifactHash,
      normalizedTextHash: input.normalizedTextHash,
    }),
  );
}

function findRule(manifest: TrustPolicyManifest, ruleId: string): TrustPolicyRule | undefined {
  return manifest.rules.find((r) => r.ruleId === ruleId);
}

function isHttpsUri(uri: string): boolean {
  try {
    return new URL(uri).protocol === "https:";
  } catch {
    return false;
  }
}

function originOf(uri: string): string | null {
  try {
    return new URL(uri).origin;
  } catch {
    return null;
  }
}

function authorizedOrigins(rule: TrustPolicyRule): readonly string[] {
  const out: string[] = [];
  for (const value of [rule.httpsOrigin, ...rule.redirectOrigins]) {
    const origin = originOf(value);
    if (origin !== null) out.push(origin);
  }
  return out;
}

/**
 * 确定性两阶段准入判定。纯函数：同 envelope + 同策略 + 同时钟 ⇒ 同判定；envelope 不被改动。
 */
export function decideSourceAdmission(
  deps: SourceAdmissionDeps,
  input: SourceAdmissionInput,
): SourceAdmissionVerdict {
  const policy = typeof deps.policy === "function" ? deps.policy() : deps.policy;
  const manifest = policy.manifest;
  const now = intakeNow(deps.clock);
  const envelope = input.envelope;
  const denyCodes: AdmissionDenyCode[] = [];
  const reasons: string[] = [];
  const deny = (code: AdmissionDenyCode, reason: string): void => {
    if (!denyCodes.includes(code)) denyCodes.push(code);
    reasons.push(reason);
  };

  const fetchDecision = envelope.policyDecisionRef;

  // ① fetch 决策自身必须是 allow，且必须由“当前”策略签出（轮换/撤销即拒）
  if (fetchDecision.decision !== "allow") {
    deny("fetch-decision-not-allow", "acquisition carries a non-allow fetch decision");
  }
  const decisionsToCheck = [fetchDecision, ...envelope.hopDecisions];
  const policyChanged = decisionsToCheck.some(
    (d) =>
      d.policyId !== manifest.policyId ||
      d.policyVersion !== manifest.version ||
      d.policyDigest !== manifest.digest,
  );
  if (policyChanged) {
    deny("policy-changed", "trust policy changed between fetch and use");
  }
  const rule = findRule(manifest, fetchDecision.ruleId);
  if (!rule) {
    deny("policy-rule-missing", `rule ${fetchDecision.ruleId} is not part of the current policy`);
  }

  // ② tenant/space 作用域必须与 envelope 一致（跨 tenant 复用即拒）
  if (envelope.tenantId !== input.tenantId || envelope.space !== input.space || envelope.subscriptionId !== input.subscriptionId) {
    deny("tenant-scope-mismatch", "admission scope does not match the acquisition scope");
  }

  // ③ 状态语义：只接受 200 系与 304
  const isUnchanged = envelope.notModified || envelope.status === 304;
  if (!isUnchanged && !(envelope.status >= 200 && envelope.status < 300)) {
    deny("unexpected-status", `acquisition status ${envelope.status} is not usable`);
  }

  // ④ 传输事实复核：finalUri 与每一跳都必须 HTTPS 且落在授权 origin 内
  const allowedOrigins = rule ? authorizedOrigins(rule) : [];
  // redirectChain 末位即 finalUri；去重后逐个复核，避免同一跳产出重复 reason。
  const chain = [...new Set([...envelope.redirectChain, envelope.finalUri])];
  for (const uri of chain) {
    if (!isHttpsUri(uri)) {
      deny("insecure-transport", `non-TLS hop in acquisition chain: ${uri}`);
      continue;
    }
    const origin = originOf(uri);
    if (rule && origin !== null && !allowedOrigins.includes(origin)) {
      deny("escaped-redirect", `hop origin ${origin} is not authorized by rule ${rule.ruleId}`);
    }
  }
  for (const hop of envelope.hops) {
    if (!isHttpsUri(hop.url)) deny("insecure-transport", `non-TLS hop record: ${hop.url}`);
    for (const address of hop.addresses) {
      if (isPrivateIpLiteral(address.address)) {
        deny("private-address", `hop ${hop.url} resolved to non-public address ${address.address}`);
      }
    }
  }

  // ⑤ 字节预算与 artifact 完整性（不得信任 envelope 自称的 hash）
  if (rule && envelope.byteLength > rule.maxBytes) {
    deny("oversized", `byteLength ${envelope.byteLength} exceeds rule maxBytes ${rule.maxBytes}`);
  }
  if (envelope.rawHash === "" || !/^[0-9a-f]{64}$/.test(envelope.rawHash)) {
    deny("missing-artifact-hash", "acquisition lacks a usable sha256 artifact hash");
  } else if (!isUnchanged) {
    if (envelope.rawBytes.byteLength !== envelope.byteLength) {
      deny("artifact-hash-mismatch", "rawBytes length does not match declared byteLength");
    } else if (sha256Hex(envelope.rawBytes) !== envelope.rawHash) {
      deny("artifact-hash-mismatch", "recomputed artifact hash does not match the acquisition hash");
    }
  }

  // ⑥ content type / representation（未批准或不可归一化 → 不得进入 extractor）
  if (!isUnchanged) {
    if (!rule || !isApprovableContentType(rule, envelope.headers.contentTypeRaw ?? envelope.headers.contentType)) {
      deny(
        "content-type-not-approved",
        `content type ${contentTypeEssence(envelope.headers.contentType) || "(none)"} is not an approved normalizable type`,
      );
    } else if (envelope.normalization !== "normalized-text" || envelope.normalizedText === "") {
      deny("empty-normalized-text", "acquisition has no normalized representation to extract from");
    } else if (envelope.normalizedTextHash !== sha256Hex(envelope.normalizedText)) {
      deny("artifact-hash-mismatch", "normalized text hash does not match normalized text");
    }
  }

  // ⑦ 申报属性必须逐项落在规则集合内（未知 license 一律拒）
  if (rule) {
    if (!rule.licenses.includes(input.license)) deny("unknown-license", `license ${input.license} is not approved`);
    if (!rule.sourceTypes.includes(input.sourceType)) {
      deny("source-type-not-approved", `sourceType ${input.sourceType} is not approved`);
    }
    if (!rule.domains.includes(input.domain)) deny("domain-not-approved", `domain ${input.domain} is not approved`);
  }

  // ⑧ 订阅状态（撤销/暂停/退役都不得 use）
  if (input.subscriptionStatus !== undefined && !ACTIVE_SUBSCRIPTION_STATUSES.includes(input.subscriptionStatus)) {
    deny("subscription-inactive", `subscription status ${input.subscriptionStatus} does not allow use`);
  }

  // ⑨ 唯一授权源：人类签名 policy 的 authorizeUse（策略过期/撤销/规则不匹配即拒）
  const useDecision = policy.authorizeUse({
    tenantId: input.tenantId,
    space: input.space,
    url: envelope.finalUri,
    redirectOrigins: [...new Set(envelope.hops.map((hop) => hop.origin))],
    sourceType: input.sourceType,
    contentType: envelope.headers.contentType,
    license: input.license,
    byteLength: envelope.byteLength,
    domain: input.domain,
    ...(input.subscriptionStatus === undefined ? {} : { subscriptionStatus: input.subscriptionStatus }),
    ...(input.subscriptionValidUntil === undefined ? {} : { subscriptionValidUntil: input.subscriptionValidUntil }),
  });
  if (useDecision.decision !== "allow") {
    deny("policy-denied", `authorizeUse denied: ${useDecision.reason}`);
  }

  const denied = denyCodes.length > 0;
  const verdict: SourceAdmissionVerdict["verdict"] = denied ? "deny" : isUnchanged ? "reuse-unchanged" : "admit";
  const policyDecisionDigest = computeIntakePolicyDecisionDigest({
    fetchPolicyDecision: fetchDecision,
    usePolicyDecision: useDecision,
    artifactHash: envelope.rawHash,
    normalizedTextHash: envelope.normalizedTextHash,
  });

  return Object.freeze({
    verdict,
    quarantinedDisposition: "raw-quarantine" as const,
    ...(verdict === "admit"
      ? { nextRevisionDisposition: "admitted" as const }
      : verdict === "reuse-unchanged"
        ? { nextRevisionDisposition: "unchanged" as const }
        : {}),
    mayStoreAdmittedRevision: verdict === "admit",
    mayExtract: verdict === "admit",
    denyCodes: Object.freeze([...denyCodes]),
    reasons: Object.freeze([...reasons]),
    fetchPolicyDecision: Object.freeze(policyDecisionRefOf(fetchDecision)),
    usePolicyDecision: Object.freeze({ ...useDecision }),
    artifactHash: envelope.rawHash,
    normalizedTextHash: envelope.normalizedTextHash,
    representation: envelope.normalization,
    policyDecisionDigest,
    decidedAt: now.toISOString(),
  });
}

export interface SourceAdmissionController {
  decide(input: SourceAdmissionInput): SourceAdmissionVerdict;
}

/** 绑定 policy/clock 的 admission 控制器（service lane 注入用）。 */
export function createSourceAdmissionController(deps: SourceAdmissionDeps): SourceAdmissionController {
  return { decide: (input) => decideSourceAdmission(deps, input) };
}
