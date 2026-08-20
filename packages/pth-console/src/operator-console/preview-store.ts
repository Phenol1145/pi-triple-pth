/**
 * operator-console/preview-store.ts — 一次性命令预览与提交（N33 Task 5 Step 3）
 *
 * 安全不变量：
 *  - 预览一次性：成功提交后 record 置 consumed，任何重放在触达原生面之前拒绝；
 *  - digest 绑定：service 用 canonicalPreviewDigest 重算 adapter 返回的 digest
 *    （防 adapter 漏算/错算），submit 时逐字节比对调用方回执的 digest；
 *  - tenant/space 绑定：digest 含 tenant/space，且提交上下文必须与预览上下文一致；
 *  - 过期：TTL 15 分钟（默认），过期 record 清除并拒绝；
 *  - 幂等：消费与幂等登记在同一进程内互斥锁内完成、先于原生调用；
 *    歧义结果（如网络超时）保持 submitting，同 key 同 digest 重试继续原生调用
 *    （adapter 以 previewId 派生原生幂等键），完成后同 key 查询直接返回原 ref；
 *    同 key 不同 digest → 冲突拒绝；
 *  - 上限：pending 预览最多 100 个（过期先清理）。
 *
 * 不引入任何通用 workflow 抽象：这里只有「预览 → 确认 → 提交 → 原生状态」一条通道。
 */

import { randomBytes } from "node:crypto";
import type { WorkMode } from "@away_from/shared";
import type { OperatorActionRegistry } from "./action-registry.js";
import type { OperatorChannelAudit, OperatorAuditErrorCode } from "./channel-audit.js";
import {
  assertCanonicalJsonValue,
  assertOperatorContext,
  canonicalPreviewDigest,
  deepFreezeJson,
  isPlainObject,
  type NativeWorkProjection,
  type NativeWorkRef,
  type OperatorAcceptanceProjection,
  type OperatorCommandPreview,
  type OperatorContext,
  type OperatorFormDescriptor,
  type OperatorModeAdapter,
} from "./contracts.js";

export const OPERATOR_PREVIEW_TTL_MS = 15 * 60 * 1000;
export const OPERATOR_MAX_PENDING_PREVIEWS = 100;
export const OPERATOR_IDEMPOTENCY_KEY_MAX_LENGTH = 128;

/** 归一化错误的拒绝原因（message 关键字供操作员/测试识别，code 供审计归一化）。 */
export class OperatorWorkError extends Error {
  constructor(
    readonly code: OperatorAuditErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OperatorWorkError";
  }
}

export interface OperatorSubmitRequest {
  readonly previewId: string;
  readonly previewDigest: string;
  readonly idempotencyKey: string;
}

export interface OperatorActionListing {
  readonly mode: WorkMode;
  readonly action: string;
  readonly nativeKind: string;
  readonly descriptor: OperatorFormDescriptor;
}

export interface OperatorWorkService {
  listActions(): readonly OperatorActionListing[];
  describe(mode: WorkMode, action: string): OperatorFormDescriptor;
  preview(
    mode: WorkMode,
    action: string,
    input: unknown,
    context: OperatorContext,
  ): Promise<OperatorCommandPreview>;
  submit(request: OperatorSubmitRequest, context: OperatorContext): Promise<NativeWorkRef>;
  inspect(ref: NativeWorkRef, context: OperatorContext): Promise<NativeWorkProjection>;
  evaluate(ref: NativeWorkRef, context: OperatorContext): Promise<OperatorAcceptanceProjection>;
}

export interface OperatorWorkServiceDeps {
  readonly registry: OperatorActionRegistry;
  readonly audit: OperatorChannelAudit;
  readonly clock?: () => number;
  readonly previewTtlMs?: number;
  readonly maxPendingPreviews?: number;
  readonly previewIdFactory?: () => string;
}

type PreviewStatus = "pending" | "submitting" | "consumed";

interface PreviewRecord {
  readonly preview: OperatorCommandPreview;
  readonly adapter: OperatorModeAdapter;
  readonly tenant: string;
  readonly space: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  status: PreviewStatus;
  ref?: NativeWorkRef;
}

interface IdempotencyRecord {
  readonly key: string;
  readonly tenant: string;
  readonly digest: string;
  readonly previewId: string;
  status: "submitting" | "completed";
  ref?: NativeWorkRef;
}

function adapterNativeKind(adapter: OperatorModeAdapter): string | undefined {
  const kind = (adapter as { nativeKind?: unknown }).nativeKind;
  return typeof kind === "string" && kind.trim() !== "" ? kind : undefined;
}

/**
 * adapter 构造 preview 的唯一推荐入口：统一计算 canonical digest（digest 只含
 * mode/action/normalizedInput/nativeTarget/impact/expiresAt + tenant/space——
 * 显示标签与 CSRF/session token 永不进字节流），并深冻结归一化输入。
 * previewId 是占位符：work service 在登记时会用自有铸造器覆盖（previewId 不进 digest）。
 */
export function buildOperatorPreview(
  parts: {
    readonly mode: WorkMode;
    readonly action: string;
    readonly normalizedInput: Readonly<Record<string, unknown>>;
    readonly summary: readonly string[];
    readonly impact: { readonly scope: string; readonly reversible: boolean; readonly risk: "low" | "medium" | "high" };
    readonly nativeTarget: string;
    readonly expiresAt: string;
  },
  context: OperatorContext,
): OperatorCommandPreview {
  const previewDigest = canonicalPreviewDigest(
    {
      mode: parts.mode,
      action: parts.action,
      normalizedInput: parts.normalizedInput,
      nativeTarget: parts.nativeTarget,
      impact: parts.impact,
      expiresAt: parts.expiresAt,
    },
    context,
  );
  return {
    previewId: "",
    mode: parts.mode,
    action: parts.action,
    normalizedInput: deepFreezeJson(parts.normalizedInput),
    summary: deepFreezeJson([...parts.summary]),
    impact: deepFreezeJson({ ...parts.impact }),
    nativeTarget: parts.nativeTarget,
    previewDigest,
    expiresAt: parts.expiresAt,
    confirmation: "required",
  };
}

/** adapter 输入白名单校验：任何未列名字段（path/method/command/sql/manifest/...）一律拒绝。 */
export function assertAllowedInputFields(
  input: unknown,
  allowed: readonly string[],
  what: string,
): asserts input is Record<string, unknown> {
  if (!isPlainObject(input)) {
    throw new OperatorWorkError("UNKNOWN_ACTION", `${what} input must be a plain object`);
  }
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      throw new OperatorWorkError("UNKNOWN_ACTION", `unknown ${what} input field "${key}"`);
    }
  }
  assertCanonicalJsonValue(input, `${what}.input`);
}

export function createOperatorWorkService(deps: OperatorWorkServiceDeps): OperatorWorkService {
  const clock = deps.clock ?? (() => Date.now());
  const ttlMs = deps.previewTtlMs ?? OPERATOR_PREVIEW_TTL_MS;
  const maxPending = deps.maxPendingPreviews ?? OPERATOR_MAX_PENDING_PREVIEWS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error("preview ttl must be a positive number of milliseconds");
  }
  if (!Number.isSafeInteger(maxPending) || maxPending <= 0) {
    throw new Error("max pending previews must be a positive safe integer");
  }
  const mintPreviewId =
    deps.previewIdFactory ?? (() => `pv-${randomBytes(16).toString("hex")}`);

  const previews = new Map<string, PreviewRecord>();
  const idempotency = new Map<string, IdempotencyRecord>();
  // ref → adapter 绑定索引：submit 成功时登记。intake 两个 adapter 共享 nativeKind
  // "intake-run"（订阅与 run 是同一原生族），inspect/evaluate 必须按提交来源路由；
  // 进程重启后索引为空 → 回退为按序尝试候选 adapter（首个不抛 not-found 者胜）。
  const refIndex = new Map<string, OperatorModeAdapter>();

  function refKey(ref: NativeWorkRef): string {
    return `${ref.mode}:${ref.kind}:${ref.tenantId}:${ref.id}`;
  }

  // 进程内互斥锁：消费 + 幂等登记 + 状态迁移串行化（先于原生调用）。
  let mutex: Promise<void> = Promise.resolve();
  function underMutex<T>(fn: () => T): Promise<T> {
    const run = mutex.then(fn);
    mutex = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function audit(event: "preview" | "submit" | "submit-confirmed" | "submit-failed", parts: {
    mode: WorkMode;
    action: string;
    tenant: string;
    space: string;
    previewId?: string;
    previewDigest?: string;
    nativeKind?: string;
    nativeId?: string;
    errorCode?: OperatorAuditErrorCode;
  }): Promise<void> {
    await deps.audit.record({
      at: new Date(clock()).toISOString(),
      channel: "work",
      event,
      mode: parts.mode,
      action: parts.action,
      tenant: parts.tenant,
      space: parts.space,
      ...(parts.previewId !== undefined ? { previewId: parts.previewId } : {}),
      ...(parts.previewDigest !== undefined ? { previewDigest: parts.previewDigest } : {}),
      ...(parts.nativeKind !== undefined ? { nativeKind: parts.nativeKind } : {}),
      ...(parts.nativeId !== undefined ? { nativeId: parts.nativeId } : {}),
      ...(parts.errorCode !== undefined ? { errorCode: parts.errorCode } : {}),
    });
  }

  function purgeExpired(nowMs: number): void {
    for (const [id, record] of previews) {
      if (record.status === "pending" && nowMs > record.expiresAtMs) {
        previews.delete(id);
      }
    }
  }

  function idempotencyScope(context: OperatorContext, key: string): string {
    return `${context.tenant}${key}`;
  }

  function assertSubmitRequestShape(request: unknown): asserts request is OperatorSubmitRequest {
    if (!isPlainObject(request)) {
      throw new OperatorWorkError("PREVIEW_UNKNOWN", "submit request must be a plain object");
    }
    for (const key of Object.keys(request)) {
      if (!["previewId", "previewDigest", "idempotencyKey"].includes(key)) {
        throw new OperatorWorkError("PREVIEW_UNKNOWN", `unknown submit field "${key}"`);
      }
    }
    const r = request as Record<string, unknown>;
    if (typeof r.previewId !== "string" || r.previewId.trim() === "") {
      throw new OperatorWorkError("PREVIEW_UNKNOWN", "previewId must be a non-empty string");
    }
    if (typeof r.previewDigest !== "string" || !/^[0-9a-f]{64}$/.test(r.previewDigest)) {
      throw new OperatorWorkError("DIGEST_MISMATCH", "previewDigest must be a 64-char lowercase hex digest");
    }
    if (
      typeof r.idempotencyKey !== "string" ||
      r.idempotencyKey.trim() === "" ||
      r.idempotencyKey.length > OPERATOR_IDEMPOTENCY_KEY_MAX_LENGTH
    ) {
      throw new OperatorWorkError(
        "IDEMPOTENCY_CONFLICT",
        `idempotencyKey must be a non-empty string of at most ${OPERATOR_IDEMPOTENCY_KEY_MAX_LENGTH} characters`,
      );
    }
  }

  function assertFreshDigest(record: PreviewRecord, presentedDigest: string): void {
    if (record.preview.previewDigest !== presentedDigest) {
      throw new OperatorWorkError(
        "DIGEST_MISMATCH",
        "preview digest mismatch: the confirmed input does not match the stored preview",
      );
    }
  }

  function candidateAdaptersForRef(ref: NativeWorkRef): OperatorModeAdapter[] {
    const bound = refIndex.get(refKey(ref));
    if (bound) return [bound];
    const matches = deps.registry
      .list()
      .filter((a) => a.mode === ref.mode && adapterNativeKind(a) === ref.kind);
    if (matches.length === 0) {
      throw new OperatorWorkError(
        "UNKNOWN_ACTION",
        `unknown native work ref kind: ${ref.mode}/${ref.kind}`,
      );
    }
    return matches;
  }

  /** 回退路由（重启后 refIndex 为空）：按序尝试候选 adapter，首个不因 not-found 失败者胜。 */
  async function withRefAdapter<T>(
    ref: NativeWorkRef,
    invoke: (adapter: OperatorModeAdapter) => Promise<T>,
  ): Promise<T> {
    const candidates = candidateAdaptersForRef(ref);
    let lastError: unknown;
    for (const adapter of candidates) {
      try {
        return await invoke(adapter);
      } catch (err) {
        if (err instanceof OperatorWorkError && err.code === "PREVIEW_UNKNOWN") {
          lastError = err;
          continue;
        }
        throw err;
      }
    }
    throw lastError ?? new OperatorWorkError("UNKNOWN_ACTION", `no adapter could resolve ${refKey(ref)}`);
  }

  function assertRefTenant(ref: NativeWorkRef, context: OperatorContext): void {
    if (ref.tenantId !== context.tenant) {
      throw new OperatorWorkError(
        "CROSS_TENANT_REF",
        "cross-tenant native ref is rejected before any backing call",
      );
    }
  }

  async function callNativeSubmit(record: PreviewRecord, ledger: IdempotencyRecord, context: OperatorContext): Promise<NativeWorkRef> {
    try {
      const ref = await record.adapter.submit(record.preview, context, ledger.key);
      await underMutex(() => {
        record.status = "consumed";
        record.ref = ref;
        ledger.status = "completed";
        ledger.ref = ref;
        refIndex.set(refKey(ref), record.adapter);
      });
      await audit("submit-confirmed", {
        mode: record.preview.mode,
        action: record.preview.action,
        tenant: record.tenant,
        space: record.space,
        previewId: record.preview.previewId,
        previewDigest: record.preview.previewDigest,
        nativeKind: ref.kind,
        nativeId: ref.id,
      });
      return ref;
    } catch (err) {
      // 歧义结果：record 保持 submitting，由同 key 同 digest 的重试对账；
      // 审计只落归一化码，不落错误正文（可能含内部地址/路径）。
      await audit("submit-failed", {
        mode: record.preview.mode,
        action: record.preview.action,
        tenant: record.tenant,
        space: record.space,
        previewId: record.preview.previewId,
        previewDigest: record.preview.previewDigest,
        errorCode: err instanceof OperatorWorkError ? err.code : "NATIVE_SUBMIT_ERROR",
      });
      throw err;
    }
  }

  return {
    listActions() {
      return deps.registry.list().map((adapter) => ({
        mode: adapter.mode,
        action: adapter.action,
        nativeKind: adapterNativeKind(adapter) ?? "task",
        descriptor: adapter.describe(),
      }));
    },

    describe(mode, action) {
      return deps.registry.get(mode, action).describe();
    },

    async preview(mode, action, input, context) {
      assertOperatorContext(context);
      let adapter: OperatorModeAdapter;
      try {
        adapter = deps.registry.get(mode, action);
      } catch (err) {
        await audit("submit-failed", {
          mode,
          action,
          tenant: context.tenant,
          space: context.space,
          errorCode: "UNKNOWN_ACTION",
        });
        throw err;
      }
      const nowMs = clock();
      purgeExpired(nowMs);
      const pendingCount = [...previews.values()].filter((r) => r.status !== "consumed").length;
      if (pendingCount >= maxPending) {
        await audit("submit-failed", {
          mode,
          action,
          tenant: context.tenant,
          space: context.space,
          errorCode: "PENDING_LIMIT",
        });
        throw new OperatorWorkError(
          "PENDING_LIMIT",
          `too many pending previews (limit ${maxPending}); confirm or let previews expire first`,
        );
      }

      const candidate = await adapter.preview(input, context);
      // service 侧复检：mode/action 绑定、expiry 在 TTL 窗口内、digest 重算一致。
      // nowMs 在 adapter 返回后读取：adapter 与服务共享同一注入时钟，其 expiresAt
      // 必然落在 (checkedAtMs, checkedAtMs + ttlMs] 窗口内（毫秒漂移不误判）。
      const checkedAtMs = clock();
      if (candidate.mode !== mode || candidate.action !== action) {
        throw new OperatorWorkError(
          "UNKNOWN_ACTION",
          "adapter returned a preview whose mode/action does not match the requested action",
        );
      }
      const expiresAtMs = Date.parse(candidate.expiresAt);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= checkedAtMs || expiresAtMs > checkedAtMs + ttlMs) {
        throw new OperatorWorkError(
          "PREVIEW_EXPIRED",
          "adapter preview expiry must fall within the preview TTL window",
        );
      }
      const recomputed = canonicalPreviewDigest(
        {
          mode: candidate.mode,
          action: candidate.action,
          normalizedInput: candidate.normalizedInput,
          nativeTarget: candidate.nativeTarget,
          impact: candidate.impact,
          expiresAt: candidate.expiresAt,
        },
        context,
      );
      if (recomputed !== candidate.previewDigest) {
        throw new OperatorWorkError(
          "DIGEST_MISMATCH",
          "adapter preview digest does not match the canonical recomputation",
        );
      }
      assertCanonicalJsonValue(candidate.summary, "preview.summary");

      // previewId 由 service 铸造（不进 digest——覆盖 adapter 值是安全的）。
      const preview: OperatorCommandPreview = deepFreezeJson({
        ...candidate,
        previewId: mintPreviewId(),
      });
      const record: PreviewRecord = {
        preview,
        adapter,
        tenant: context.tenant,
        space: context.space,
        createdAtMs: nowMs,
        expiresAtMs,
        status: "pending",
      };
      previews.set(preview.previewId, record);
      await audit("preview", {
        mode,
        action,
        tenant: context.tenant,
        space: context.space,
        previewId: preview.previewId,
        previewDigest: preview.previewDigest,
      });
      return preview;
    },

    async submit(request, context) {
      assertOperatorContext(context);
      assertSubmitRequestShape(request);
      const nowMs = clock();
      // 注意：submit 不做全局过期清理——目标 record 的过期判定在下面给出专属错误，
      // 避免「过期」被误报为「unknown preview」。

      // ── 互斥临界区：幂等查询 → 消费登记（先于原生调用）──
      const prepared = await underMutex(() => {
        const scopedKey = idempotencyScope(context, request.idempotencyKey);
        const ledger = idempotency.get(scopedKey);
        if (ledger) {
          if (ledger.digest !== request.previewDigest || ledger.previewId !== request.previewId) {
            throw new OperatorWorkError(
              "IDEMPOTENCY_CONFLICT",
              "idempotency key conflict: the same key was used with a different preview digest",
            );
          }
          if (ledger.status === "completed" && ledger.ref) {
            return { kind: "replay" as const, ref: ledger.ref };
          }
          const record = previews.get(ledger.previewId);
          if (!record) {
            throw new OperatorWorkError("PREVIEW_UNKNOWN", "unknown preview for idempotency record");
          }
          return { kind: "retry" as const, record, ledger };
        }

        const record = previews.get(request.previewId);
        if (!record) {
          throw new OperatorWorkError("PREVIEW_UNKNOWN", `unknown preview: ${request.previewId}`);
        }
        if (record.tenant !== context.tenant || record.space !== context.space) {
          throw new OperatorWorkError(
            "CROSS_TENANT_REF",
            "cross-tenant submit rejected: preview belongs to a different tenant/space context",
          );
        }
        assertFreshDigest(record, request.previewDigest);
        if (record.status === "consumed") {
          throw new OperatorWorkError(
            "PREVIEW_CONSUMED",
            "preview already consumed: one-shot previews cannot be replayed",
          );
        }
        if (record.status === "submitting") {
          throw new OperatorWorkError(
            "PREVIEW_IN_FLIGHT",
            "preview submit is already in flight; retry with the original idempotency key",
          );
        }
        if (nowMs > record.expiresAtMs) {
          previews.delete(record.preview.previewId);
          throw new OperatorWorkError(
            "PREVIEW_EXPIRED",
            "preview expired: create a fresh preview and confirm again",
          );
        }
        record.status = "submitting";
        const fresh: IdempotencyRecord = {
          key: request.idempotencyKey,
          tenant: context.tenant,
          digest: request.previewDigest,
          previewId: record.preview.previewId,
          status: "submitting",
        };
        idempotency.set(scopedKey, fresh);
        return { kind: "fresh" as const, record, ledger: fresh };
      });

      if (prepared.kind === "replay") {
        return prepared.ref;
      }

      await audit("submit", {
        mode: prepared.record.preview.mode,
        action: prepared.record.preview.action,
        tenant: prepared.record.tenant,
        space: prepared.record.space,
        previewId: prepared.record.preview.previewId,
        previewDigest: prepared.record.preview.previewDigest,
      });
      return callNativeSubmit(prepared.record, prepared.ledger, context);
    },

    async inspect(ref, context) {
      assertOperatorContext(context);
      assertRefTenant(ref, context);
      return withRefAdapter(ref, (adapter) => adapter.inspect(ref, context));
    },

    async evaluate(ref, context) {
      assertOperatorContext(context);
      assertRefTenant(ref, context);
      return withRefAdapter(ref, (adapter) => adapter.evaluate(ref, context));
    },
  };
}
