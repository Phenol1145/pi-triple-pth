/**
 * fetch-broker.ts — N29 Task 4：policy-bound artifact acquisition（SourceFetchBroker 实现）。
 *
 * 契约事实源：docs/pth/plan/n29-minimal-knowledge-intake-loop-feedback-plan.md §5 Task 4；
 * 类型事实源：src/pth/contracts/knowledge-intake.ts（SourceAcquisitionEnvelope / AcquireSourceInput）。
 *
 * 不可缩减的抓取边界（全部 fail closed，任何一条不成立即拒绝且不产出 envelope）：
 *  1. 只允许 HTTPS（首跳与每个 redirect 跳分别校验）；
 *  2. 逐跳重新授权：每跳都要通过人类签名 policy 的 `authorizeFetch()`，并且 redirect
 *     跳的 origin 必须落在**入口规则**的 `redirectOrigins` 内（自身另有规则也不算授权）；
 *  3. DNS/IP 防线复用既有 web transport：字面量私网/环回/链路本地拒绝 + DNS 全量校验 +
 *     连接 pin 到已受检地址（逐跳重复）；
 *  4. 字节预算取自命中规则的 `maxBytes`（流式超限立即断开上游，不消费预算外字节）；
 *  5. 时间预算由 broker 自持 AbortController + 可注入 timer 执行；
 *  6. raw bytes 原样保留不可变，`rawHash = sha256(rawBytes)`（hex）；
 *  7. HTML/文本按服务端确定性归一化产出 `normalizedText` 与 `normalizedTextHash`；
 *     content type 未被策略批准或不可归一化时 envelope 仍返回 raw，由 admission 拒绝 use；
 *  8. 条件请求（ETag / Last-Modified）命中 304 时返回零成本 envelope——不读 body，
 *     rawHash 取 server-furnished content-digest 或调用方已知 artifact hash；
 *     **任何情况下都不会返回缺少 rawHash 的 envelope**。
 *
 * 本模块只做「获取 + 取证」；是否允许使用由 admission.ts 的第二阶段判定（fetch/use 两阶段）。
 */

import { createHash } from "node:crypto";

import {
  isPolicyDecisionRefStructurallyValid,
  type AcquireSourceInput,
  type FetchPolicyDecision,
  type PolicyDecisionRef,
  type SourceAcquisitionEnvelope,
  type SourceFetchBroker,
  type TrustPolicyManifest,
  type TrustPolicyRule,
  type VerifiedTrustPolicy,
} from "@away_from/pth-contracts";
import {
  secureWebFetch,
  WebTransportError,
  type SecureFetchHopRecord,
  type WebLookup,
  type WebRequest,
  type WebTimerApi,
} from "../../impls/index.js";
import type { TrustPolicyClock } from "./trust-policy.js";

// ─── 通用工具 ─────────────────────────────────────────────────────────

/** sha256 十六进制（与 knowledge provenance 的 64-hex 约定一致）。 */
export function sha256Hex(data: string | Uint8Array): string {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  return createHash("sha256").update(buf).digest("hex");
}

/** 稳定 JSON（键排序）——决策摘要必须可重放。 */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const rec = value as Record<string, unknown>;
  return `{${Object.keys(rec)
    .filter((k) => rec[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(rec[k])}`)
    .join(",")}}`;
}

/** 只取 PolicyDecisionRef 的六个冻结字段（reason 等实现细节不进摘要）。 */
export function policyDecisionRefOf(decision: PolicyDecisionRef): PolicyDecisionRef {
  return {
    policyId: decision.policyId,
    policyVersion: decision.policyVersion,
    policyDigest: decision.policyDigest,
    ruleId: decision.ruleId,
    decision: decision.decision,
    decidedAt: decision.decidedAt,
  };
}

export function intakeNow(clock: TrustPolicyClock | undefined): Date {
  if (!clock) return new Date();
  return typeof clock === "function" ? clock() : clock.now();
}

// ─── 确定性归一化（服务端唯一真相） ───────────────────────────────────

const NORMALIZABLE_CONTENT_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "text/plain",
  "text/markdown",
  "text/x-markdown",
]);

const HTML_CONTENT_TYPES = new Set(["text/html", "application/xhtml+xml"]);

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  apos: "'",
  nbsp: "\u00a0",
  ndash: "\u2013",
  mdash: "\u2014",
  hellip: "\u2026",
  laquo: "\u00ab",
  raquo: "\u00bb",
};

/** content type essence（小写、去参数）。 */
export function contentTypeEssence(raw: string | undefined): string {
  if (!raw) return "";
  return raw.split(";")[0]!.trim().toLowerCase();
}

function contentTypeCharset(raw: string | undefined): string {
  if (!raw) return "utf-8";
  const match = /;\s*charset\s*=\s*"?([^";]+)"?/i.exec(raw);
  return (match?.[1] ?? "utf-8").trim().toLowerCase();
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? whole;
  });
}

function decodeBytes(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function normalizeHtml(decoded: string): string {
  const stripped = decoded
    .replace(/^\ufeff/, "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ");
  return decodeEntities(stripped)
    .normalize("NFC")
    .replace(/[\s\u00a0\u200b\ufeff]+/g, " ")
    .trim();
}

function normalizePlainText(decoded: string): string {
  return decoded
    .replace(/^\ufeff/, "")
    .replace(/\r\n?/g, "\n")
    .normalize("NFC")
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface NormalizedSourceRepresentation {
  readonly representation: "normalized-text" | "none";
  readonly text: string;
  readonly hash: string;
  readonly contentType: string;
  readonly charset: string;
}

/**
 * 服务端确定性归一化：同字节 + 同 content type 永远得到同一 text/hash。
 * 不可归一化（未知 content type）时返回 representation="none"、text=""，
 * hash 取空串 sha256——envelope 仍然携带 raw，由 admission 拒绝 use。
 */
export function normalizeSourceText(bytes: Uint8Array, contentType: string | undefined): NormalizedSourceRepresentation {
  const essence = contentTypeEssence(contentType);
  const charset = contentTypeCharset(contentType);
  if (!NORMALIZABLE_CONTENT_TYPES.has(essence)) {
    return Object.freeze({ representation: "none", text: "", hash: sha256Hex(""), contentType: essence, charset });
  }
  const decoded = decodeBytes(bytes, charset);
  const text = HTML_CONTENT_TYPES.has(essence) ? normalizeHtml(decoded) : normalizePlainText(decoded);
  return Object.freeze({ representation: "normalized-text", text, hash: sha256Hex(text), contentType: essence, charset });
}

/** 判定 content type 是否既被策略批准又可归一化（admission 复用）。 */
export function isApprovableContentType(rule: TrustPolicyRule, contentType: string | undefined): boolean {
  const essence = contentTypeEssence(contentType);
  return essence !== "" && rule.contentTypes.includes(essence) && NORMALIZABLE_CONTENT_TYPES.has(essence);
}

/** server-furnished 内容摘要（RFC 9530 content-digest / RFC 3230 digest）→ 64-hex。 */
export function parseServerContentDigest(headers: Readonly<Record<string, string>>): string | null {
  for (const name of ["content-digest", "digest"] as const) {
    const raw = headers[name];
    if (!raw) continue;
    for (const part of raw.split(",")) {
      const match = /^\s*sha-?256\s*=\s*:?([A-Za-z0-9+/=_-]+):?\s*$/i.exec(part);
      if (!match) continue;
      const value = match[1]!;
      if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
      const buf = Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
      if (buf.length === 32) return buf.toString("hex");
    }
  }
  return null;
}

// ─── 拒绝模型 ─────────────────────────────────────────────────────────

export type SourceFetchDenyCode =
  | "fetch-decision-not-allow"
  | "policy-mismatch"
  | "policy-rule-missing"
  | "policy-denied"
  | "not-https"
  | "redirect-origin-not-authorized"
  | "too-many-redirects"
  | "private-address"
  | "dns-empty"
  | "oversized"
  | "timeout"
  | "unexpected-status"
  | "artifact-hash-mismatch"
  | "not-modified-without-conditional"
  | "not-modified-without-artifact-hash"
  | "transport-error";

/** 抓取阶段的可判别拒绝：acquire 只返回合法 envelope，其余一律抛本错误。 */
export class SourceFetchDeniedError extends Error {
  readonly code: SourceFetchDenyCode;
  readonly hopUrl?: string;
  readonly status?: number;
  readonly policyDecision?: FetchPolicyDecision;

  constructor(
    code: SourceFetchDenyCode,
    message: string,
    detail: { hopUrl?: string; status?: number; policyDecision?: FetchPolicyDecision } = {},
  ) {
    super(`intake.fetch denied [${code}]: ${message}`);
    this.name = "SourceFetchDeniedError";
    this.code = code;
    if (detail.hopUrl !== undefined) this.hopUrl = detail.hopUrl;
    if (detail.status !== undefined) this.status = detail.status;
    if (detail.policyDecision !== undefined) this.policyDecision = detail.policyDecision;
  }
}

// ─── 端口与输入/输出 ──────────────────────────────────────────────────

/** broker 只需要 policy 的只读匹配面（manifest + authorizeFetch）。 */
export type IntakeFetchPolicySource = Pick<VerifiedTrustPolicy, "manifest" | "authorizeFetch">;
export type IntakeFetchPolicyProvider =
  | IntakeFetchPolicySource
  | (() => IntakeFetchPolicySource | Promise<IntakeFetchPolicySource>);

/**
 * 订阅级申报属性：`AcquireSourceInput` 是冻结契约（不含这些字段），
 * 因此由装配层（service lane 从 SourceSubscription + policy rule）提供。
 */
export interface DeclaredSourceAttributes {
  readonly sourceType: string;
  readonly contentType: string;
  readonly license: string;
}

export interface PolicyBoundFetchBrokerDeps {
  readonly policy: IntakeFetchPolicyProvider;
  readonly declaredSource:
    | DeclaredSourceAttributes
    | ((input: AcquireSourceInput) => DeclaredSourceAttributes | Promise<DeclaredSourceAttributes>);
  readonly lookup?: WebLookup;
  readonly request?: WebRequest;
  /** 时间预算（毫秒，缺省 30s）。 */
  readonly timeoutMs?: number;
  /** redirect 跳数上限（缺省 5）。 */
  readonly maxRedirects?: number;
  readonly clock?: TrustPolicyClock;
  readonly timers?: WebTimerApi;
}

/** 条件重爬时调用方已知的上一版事实（304 零成本路径用）。 */
export interface PolicyBoundAcquireSourceInput extends AcquireSourceInput {
  readonly knownRawHash?: string;
  readonly knownNormalizedText?: string;
  readonly knownNormalizedTextHash?: string;
  readonly knownContentType?: string;
}

/**
 * `SourceAcquisitionEnvelope` + 可回放取证扩展（byteLength / 逐跳决策 / 逐跳地址 /
 * policyDecisionRef / 条件请求与 304 语义）。结构上仍然可直接当契约 envelope 使用。
 */
export interface PolicyBoundSourceAcquisitionEnvelope extends SourceAcquisitionEnvelope {
  readonly headers: {
    readonly contentType: string;
    readonly etag?: string;
    readonly lastModified?: string;
    /** 原始 content-type 头（含参数）。 */
    readonly contentTypeRaw?: string;
    readonly charset?: string;
  };
  readonly tenantId: string;
  readonly space: string;
  readonly subscriptionId: string;
  readonly byteLength: number;
  readonly acquiredAt: string;
  /** 终态跳的 fetch 决策（含实际字节数复检）。 */
  readonly policyDecisionRef: FetchPolicyDecision;
  /** 逐跳 authorizeFetch 决策（按请求顺序）。 */
  readonly hopDecisions: readonly FetchPolicyDecision[];
  /** 逐跳取证：url/origin/status/location/已受检地址。 */
  readonly hops: readonly SecureFetchHopRecord[];
  readonly notModified: boolean;
  readonly contentTypeApproved: boolean;
  readonly normalization: "normalized-text" | "none";
  readonly conditional: { readonly ifNoneMatch?: string; readonly ifModifiedSince?: string };
}

export interface PolicyBoundSourceFetchBroker extends SourceFetchBroker {
  acquire(input: PolicyBoundAcquireSourceInput): Promise<PolicyBoundSourceAcquisitionEnvelope>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REDIRECTS = 5;
const FETCH_LABEL = "intake.fetch";

function exactOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

async function resolvePolicy(provider: IntakeFetchPolicyProvider): Promise<IntakeFetchPolicySource> {
  return typeof provider === "function" ? await provider() : provider;
}

function findRule(manifest: TrustPolicyManifest, ruleId: string): TrustPolicyRule | undefined {
  return manifest.rules.find((r) => r.ruleId === ruleId);
}

function mapTransportError(error: unknown, aborted: boolean, hopUrl: string | undefined): SourceFetchDeniedError {
  if (error instanceof SourceFetchDeniedError) return error;
  if (error instanceof WebTransportError) {
    // 协议/状态类错误自带具体 URL；其余（DNS/字节）用最后一次授权过的跳定位。
    const offending = error.url ?? hopUrl;
    const detail = offending === undefined ? {} : { hopUrl: offending };
    switch (error.code) {
      case "protocol-not-allowed":
        return new SourceFetchDeniedError("not-https", error.message, detail);
      case "private-address":
        return new SourceFetchDeniedError("private-address", error.message, detail);
      case "dns-empty":
        return new SourceFetchDeniedError("dns-empty", error.message, detail);
      case "too-large":
        return new SourceFetchDeniedError("oversized", error.message, detail);
      case "too-many-redirects":
        return new SourceFetchDeniedError("too-many-redirects", error.message, detail);
      case "unexpected-status":
        return new SourceFetchDeniedError("unexpected-status", error.message, {
          ...detail,
          ...(error.status === undefined ? {} : { status: error.status }),
        });
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  if (aborted) {
    return new SourceFetchDeniedError("timeout", `fetch budget exhausted (${message})`, hopUrl === undefined ? {} : { hopUrl });
  }
  return new SourceFetchDeniedError("transport-error", message, hopUrl === undefined ? {} : { hopUrl });
}

/**
 * 构造 policy-bound fetch broker。
 *
 * 所有安全判定都在本函数返回的 `acquire()` 内逐跳执行；调用方无法通过输入放宽任何一条。
 */
export function createPolicyBoundSourceFetchBroker(deps: PolicyBoundFetchBrokerDeps): PolicyBoundSourceFetchBroker {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = deps.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const timers: WebTimerApi = deps.timers ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as never),
  };

  return {
    async acquire(input: PolicyBoundAcquireSourceInput): Promise<PolicyBoundSourceAcquisitionEnvelope> {
      const policy = await resolvePolicy(deps.policy);
      const manifest = policy.manifest;
      const incoming = input.fetchPolicyDecision;

      // ① 入口决策必须是当前 policy 签出的 allow（fail closed，不做任何推断）
      if (!isPolicyDecisionRefStructurallyValid(incoming) || incoming.decision !== "allow") {
        throw new SourceFetchDeniedError("fetch-decision-not-allow", "fetch authorization is not an allow decision", {
          policyDecision: incoming,
        });
      }
      if (
        incoming.policyId !== manifest.policyId ||
        incoming.policyVersion !== manifest.version ||
        incoming.policyDigest !== manifest.digest
      ) {
        throw new SourceFetchDeniedError("policy-mismatch", "fetch authorization does not match the current verified policy", {
          policyDecision: incoming,
        });
      }
      const entryRule = findRule(manifest, incoming.ruleId);
      if (!entryRule) {
        throw new SourceFetchDeniedError("policy-rule-missing", `rule ${incoming.ruleId} is not part of the current policy`, {
          policyDecision: incoming,
        });
      }

      const declared = typeof deps.declaredSource === "function"
        ? await deps.declaredSource(input)
        : deps.declaredSource;
      const authorizedRedirectOrigins = entryRule.redirectOrigins
        .map(exactOrigin)
        .filter((o): o is string => o !== null);

      const hopDecisions: FetchPolicyDecision[] = [];
      let lastHopUrl: string | undefined;

      const conditionalHeaders: Record<string, string> = {};
      if (input.ifNoneMatch !== undefined) conditionalHeaders["if-none-match"] = input.ifNoneMatch;
      if (input.ifModifiedSince !== undefined) conditionalHeaders["if-modified-since"] = input.ifModifiedSince;
      const sentConditional = Object.keys(conditionalHeaders).length > 0;

      // ② 时间预算由 broker 自持（可注入 timer；secureWebFetch 只消费 signal）
      const ctrl = new AbortController();
      const timer = timers.setTimeout(() => ctrl.abort(), timeoutMs);

      let result: Awaited<ReturnType<typeof secureWebFetch>>;
      try {
        result = await secureWebFetch(input.requestedUri, {
          maxBytes: entryRule.maxBytes,
          maxRedirects,
          allowedProtocols: ["https:"],
          label: FETCH_LABEL,
          ...(deps.lookup ? { lookup: deps.lookup } : {}),
          ...(deps.request ? { request: deps.request } : {}),
          ...(sentConditional ? { headers: conditionalHeaders } : {}),
          signal: ctrl.signal,
          timers,
          acceptStatus: (status) => (status >= 200 && status < 300) || status === 304,
          authorizeHop: (ctx) => {
            const hopUrl = ctx.url.toString();
            lastHopUrl = hopUrl;
            // ③ redirect 跳必须落在入口规则授权的 redirectOrigins 内（逃逸即拒）
            if (ctx.hopIndex > 0 && !authorizedRedirectOrigins.includes(ctx.url.origin)) {
              throw new SourceFetchDeniedError(
                "redirect-origin-not-authorized",
                `redirect origin ${ctx.url.origin} is not authorized by rule ${entryRule.ruleId}`,
                { hopUrl },
              );
            }
            // ④ 逐跳重新授权（未命中 allow 即拒；byteLength 在本跳尚未知，按 0 预检）
            const decision = policy.authorizeFetch({
              tenantId: input.tenantId,
              space: input.space,
              url: hopUrl,
              redirectOrigins: [...ctx.origins],
              sourceType: declared.sourceType,
              contentType: declared.contentType,
              license: declared.license,
              byteLength: 0,
            });
            if (decision.decision !== "allow") {
              throw new SourceFetchDeniedError("policy-denied", decision.reason, { hopUrl, policyDecision: decision });
            }
            hopDecisions.push(decision);
          },
        });
      } catch (error) {
        throw mapTransportError(error, ctrl.signal.aborted, lastHopUrl);
      } finally {
        timers.clearTimeout(timer);
      }

      const acquiredAt = intakeNow(deps.clock).toISOString();
      const chainOrigins = result.hops.map((hop) => hop.origin);
      const contentTypeRaw = result.headers["content-type"];
      const serverDigest = parseServerContentDigest(result.headers);
      const notModified = result.status === 304;

      // ⑤ 304：零成本 envelope（不读 body），但绝不返回缺 rawHash 的 envelope
      if (notModified) {
        if (!sentConditional) {
          throw new SourceFetchDeniedError(
            "not-modified-without-conditional",
            "server answered 304 without a conditional request",
            { hopUrl: result.finalUri, status: 304 },
          );
        }
        if (serverDigest !== null && input.knownRawHash !== undefined && serverDigest !== input.knownRawHash) {
          throw new SourceFetchDeniedError(
            "artifact-hash-mismatch",
            `304 content-digest ${serverDigest} does not match known artifact hash`,
            { hopUrl: result.finalUri, status: 304 },
          );
        }
        const rawHash = input.knownRawHash ?? serverDigest;
        if (rawHash === null || rawHash === undefined || rawHash === "") {
          throw new SourceFetchDeniedError(
            "not-modified-without-artifact-hash",
            "304 carries neither a server content-digest nor a known artifact hash",
            { hopUrl: result.finalUri, status: 304 },
          );
        }
        const essence = contentTypeEssence(contentTypeRaw) || contentTypeEssence(input.knownContentType) ||
          contentTypeEssence(declared.contentType);
        return freezeEnvelope({
          input,
          result,
          acquiredAt,
          status: 304,
          contentType: essence,
          contentTypeRaw,
          charset: undefined,
          rawBytes: new Uint8Array(0),
          rawHash,
          normalizedText: input.knownNormalizedText ?? "",
          normalizedTextHash: input.knownNormalizedTextHash ?? sha256Hex(""),
          normalization: input.knownNormalizedTextHash === undefined ? "none" : "normalized-text",
          contentTypeApproved: isApprovableContentType(entryRule, essence),
          notModified: true,
          policyDecisionRef: hopDecisions[hopDecisions.length - 1] ?? incoming,
          hopDecisions,
          conditionalHeaders,
        });
      }

      // ⑥ 200 路径：hash → 归一化 → 以实际字节数做终态策略复检
      const rawHash = sha256Hex(result.rawBytes);
      if (serverDigest !== null && serverDigest !== rawHash) {
        throw new SourceFetchDeniedError(
          "artifact-hash-mismatch",
          `server content-digest ${serverDigest} does not match computed artifact hash ${rawHash}`,
          { hopUrl: result.finalUri, status: result.status },
        );
      }
      const normalized = normalizeSourceText(result.rawBytes, contentTypeRaw);
      const finalDecision = policy.authorizeFetch({
        tenantId: input.tenantId,
        space: input.space,
        url: result.finalUri,
        redirectOrigins: chainOrigins,
        sourceType: declared.sourceType,
        contentType: declared.contentType,
        license: declared.license,
        byteLength: result.byteLength,
      });
      if (finalDecision.decision !== "allow") {
        const code: SourceFetchDenyCode = result.byteLength > entryRule.maxBytes ? "oversized" : "policy-denied";
        throw new SourceFetchDeniedError(code, finalDecision.reason, {
          hopUrl: result.finalUri,
          policyDecision: finalDecision,
        });
      }

      return freezeEnvelope({
        input,
        result,
        acquiredAt,
        status: result.status,
        contentType: contentTypeEssence(contentTypeRaw),
        contentTypeRaw,
        charset: normalized.charset,
        rawBytes: result.rawBytes,
        rawHash,
        normalizedText: normalized.text,
        normalizedTextHash: normalized.hash,
        normalization: normalized.representation,
        contentTypeApproved: isApprovableContentType(entryRule, contentTypeRaw),
        notModified: false,
        policyDecisionRef: finalDecision,
        hopDecisions,
        conditionalHeaders,
      });
    },
  };
}

interface EnvelopeParts {
  input: PolicyBoundAcquireSourceInput;
  result: Awaited<ReturnType<typeof secureWebFetch>>;
  acquiredAt: string;
  status: number;
  contentType: string;
  contentTypeRaw: string | undefined;
  charset: string | undefined;
  rawBytes: Uint8Array;
  rawHash: string;
  normalizedText: string;
  normalizedTextHash: string;
  normalization: "normalized-text" | "none";
  contentTypeApproved: boolean;
  notModified: boolean;
  policyDecisionRef: FetchPolicyDecision;
  hopDecisions: readonly FetchPolicyDecision[];
  conditionalHeaders: Readonly<Record<string, string>>;
}

function freezeEnvelope(parts: EnvelopeParts): PolicyBoundSourceAcquisitionEnvelope {
  const { input, result } = parts;
  const etag = result.headers.etag ?? input.ifNoneMatch;
  const lastModified = result.headers["last-modified"] ?? input.ifModifiedSince;
  return Object.freeze({
    requestedUri: input.requestedUri,
    finalUri: result.finalUri,
    redirectChain: Object.freeze([...result.redirectChain]),
    status: parts.status,
    headers: Object.freeze({
      contentType: parts.contentType,
      ...(etag === undefined ? {} : { etag }),
      ...(lastModified === undefined ? {} : { lastModified }),
      ...(parts.contentTypeRaw === undefined ? {} : { contentTypeRaw: parts.contentTypeRaw }),
      ...(parts.charset === undefined ? {} : { charset: parts.charset }),
    }),
    tenantId: input.tenantId,
    space: input.space,
    subscriptionId: input.subscriptionId,
    rawBytes: parts.rawBytes,
    rawHash: parts.rawHash,
    normalizedText: parts.normalizedText,
    normalizedTextHash: parts.normalizedTextHash,
    byteLength: parts.rawBytes.byteLength,
    acquiredAt: parts.acquiredAt,
    policyDecisionRef: Object.freeze({ ...parts.policyDecisionRef }),
    hopDecisions: Object.freeze(parts.hopDecisions.map((d) => Object.freeze({ ...d }))),
    hops: Object.freeze(result.hops.map((hop) => Object.freeze({ ...hop, addresses: Object.freeze([...hop.addresses]) }))),
    notModified: parts.notModified,
    contentTypeApproved: parts.contentTypeApproved,
    normalization: parts.normalization,
    conditional: Object.freeze({
      ...(input.ifNoneMatch === undefined ? {} : { ifNoneMatch: input.ifNoneMatch }),
      ...(input.ifModifiedSince === undefined ? {} : { ifModifiedSince: input.ifModifiedSince }),
    }),
  });
}
