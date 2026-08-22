/**
 * bootstrap/intake-mode-gates.ts —— N29 refix P0-9：draft/full 模式的纯判定门。
 *
 * - draft：stage handler 集合剔除 promote（只到 private draft + open plan）。
 * - full：启动必须出示绑定当前构建 commit 的 MIN_INNER_LOOP_GO 验收 envelope；
 *   缺失/非 GO/不绑定一律抛错（启动期 fail closed）。
 * - D-5（2026-08-22）：full 还必须出示 CI/发布密钥签名的 acceptance envelope——
 *   启动时用只读公钥验签（Ed25519 detached signature over canonical envelope bytes）。
 *
 * 纯函数无副作用，可单测；batch-process.ts 只做薄装配。
 */

import { createHash, verify as cryptoVerify } from "node:crypto";

export type IntakeMode = "off" | "draft" | "full";

/** D-5：验收 envelope 的签名算法（目前只支持 Ed25519 detached signature）。 */
export const ACCEPTANCE_SIGNING_ALGORITHM = "ed25519" as const;

/** draft 模式剔除 promote handler；full 原样返回；off 返回空集合。 */
export function selectIntakeStageHandlers<T>(
  mode: IntakeMode,
  handlers: Record<string, T>,
  promoteKind: string,
): Record<string, T> {
  if (mode === "off") return {};
  if (mode === "draft") {
    const out = { ...handlers };
    delete out[promoteKind];
    return out;
  }
  return { ...handlers };
}

export interface IntakeAcceptanceEnvelopeLike {
  readonly decision?: string;
  readonly evaluatedCommit?: string;
  readonly implementationTreeClean?: boolean;
  /** D-5：签名算法（缺省/签名脚本写入 "ed25519"）。 */
  readonly signingAlgorithm?: string;
  /** D-5：签名密钥标识（审计用；参与 canonical payload）。 */
  readonly signingKeyId?: string;
  /** D-5：Ed25519 detached signature（base64）。 */
  readonly signature?: string;
}

/** 稳定 JSON 序列化（递归按键排序，跳过 undefined）——与签名脚本共用同一 canonical 语义。 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const rec = value as Record<string, unknown>;
  return `{${Object.keys(rec)
    .filter((k) => rec[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(rec[k])}`)
    .join(",")}}`;
}

/**
 * D-5：验收 envelope 的 canonical 签名载荷。`signature` 是签名产物，不能参与自身签名；
 * 其余字段（含 signingAlgorithm/signingKeyId）都参与，确保签名绑定决策、commit 与密钥标识。
 */
export function acceptanceEnvelopeCanonicalBytes(envelope: IntakeAcceptanceEnvelopeLike): Buffer {
  const { signature: _signature, ...payload } = envelope as Record<string, unknown>;
  return Buffer.from(stableStringify(payload), "utf8");
}

/** D-5：用只读 Ed25519 公钥验签 acceptance envelope；签名缺失/非法返回 false。 */
export function verifyIntakeAcceptanceSignature(
  envelope: IntakeAcceptanceEnvelopeLike,
  publicKeyPem: string,
): boolean {
  if (envelope.signingAlgorithm !== ACCEPTANCE_SIGNING_ALGORITHM) return false;
  if (typeof envelope.signature !== "string" || envelope.signature.trim() === "") return false;
  const signature = Buffer.from(envelope.signature.replace(/\s/g, ""), "base64");
  if (signature.length === 0) return false;
  try {
    return cryptoVerify(null, acceptanceEnvelopeCanonicalBytes(envelope), publicKeyPem, signature);
  } catch {
    return false;
  }
}

export interface IntakeFullAcceptanceVerifyOptions {
  /** 只读 Ed25519 公钥 PEM。requireSignature=true 时必填。 */
  readonly publicKeyPem?: string;
  /** 生产 full 模式必须验签；缺省 false 保持纯函数单测的宽松入口。 */
  readonly requireSignature?: boolean;
}

/**
 * full 模式启动门：验收 envelope 必须 decision=MIN_INNER_LOOP_GO、绑定非空
 * evaluatedCommit、implementationTreeClean=true；若提供 buildCommit 则必须一致。
 * requireSignature=true 时还必须出示公钥并验签通过。
 * 任一不符抛错（启动失败）。
 */
export function assertIntakeFullAcceptance(
  envelope: IntakeAcceptanceEnvelopeLike,
  buildCommit?: string,
  opts: IntakeFullAcceptanceVerifyOptions = {},
): void {
  if (envelope.decision !== "MIN_INNER_LOOP_GO") {
    throw new Error(
      `PTH_KNOWLEDGE_INTAKE_MODE=full 被拒绝：验收 envelope decision=${envelope.decision ?? "<missing>"}（需要 MIN_INNER_LOOP_GO）`,
    );
  }
  if (!envelope.evaluatedCommit || envelope.implementationTreeClean !== true) {
    throw new Error("PTH_KNOWLEDGE_INTAKE_MODE=full 被拒绝：envelope 缺少 evaluatedCommit 或 implementationTreeClean");
  }
  const commit = (buildCommit ?? "").trim();
  if (commit && envelope.evaluatedCommit !== commit) {
    throw new Error(
      `PTH_KNOWLEDGE_INTAKE_MODE=full 被拒绝：envelope evaluatedCommit=${envelope.evaluatedCommit} 与当前构建 ${commit} 不一致`,
    );
  }
  if (opts.requireSignature) {
    if (!opts.publicKeyPem || opts.publicKeyPem.trim() === "") {
      throw new Error(
        "PTH_KNOWLEDGE_INTAKE_MODE=full 被拒绝：缺少验收 envelope 签名公钥"
        + "（PTH_KNOWLEDGE_INTAKE_ACCEPTANCE_PUBLIC_KEY_PATH 未配置或为空）",
      );
    }
    if (envelope.signingAlgorithm !== ACCEPTANCE_SIGNING_ALGORITHM) {
      throw new Error(
        `PTH_KNOWLEDGE_INTAKE_MODE=full 被拒绝：验收 envelope 必须是 ${ACCEPTANCE_SIGNING_ALGORITHM} 签名`
        + `（signingAlgorithm=${String(envelope.signingAlgorithm ?? "<missing>")}）`,
      );
    }
    if (!verifyIntakeAcceptanceSignature(envelope, opts.publicKeyPem)) {
      throw new Error("PTH_KNOWLEDGE_INTAKE_MODE=full 被拒绝：验收 envelope 签名验证失败");
    }
  }
}
