/**
 * operator-console/actions/intake-actions.ts — intake 原生动作 adapter（N33 Task 5 Step 4）
 *
 * 登记两个 intake 动作：
 *  - intake/subscription.create：走 PTH 既有正式订阅入口（N29 门禁不被削弱——
 *    TrustPolicy authorizeFetch/authorizeUse 与 stage CAS 全在 PTH 侧执行；本 adapter
 *    只发送 canonicalUri/domainId/declared/期望 policy 钉定值，永不发送 manifest/私钥）；
 *  - intake/run.trigger：触发既有订阅的一次原生 run；只接受 subscriptionId，
 *    不接受任意 URL；原生幂等键 = previewId（PTH 侧重复键返回原 run）。
 */

import type {
  NativeWorkProjection,
  NativeWorkRef,
  OperatorAcceptanceProjection,
  OperatorContext,
  OperatorFormDescriptor,
  OperatorModeAdapter,
} from "../contracts.js";
import {
  assertAllowedInputFields,
  buildOperatorPreview,
  OPERATOR_PREVIEW_TTL_MS,
  OperatorWorkError,
} from "../preview-store.js";
import type { PthOperatorClient } from "../pth-operator-client.js";

const SUBSCRIBE_FIELDS = [
  "canonicalUri",
  "domainId",
  "recrawlIntervalMs",
  "declared",
  "expectedPolicyId",
  "expectedPolicyVersion",
  "expectedPolicyDigest",
] as const;

const TRIGGER_FIELDS = ["subscriptionId"] as const;

const RECRAWL_MAX_MS = 30 * 24 * 60 * 60 * 1000;

export interface IntakeAdapterDeps {
  readonly client: PthOperatorClient;
  readonly clock?: () => number;
}

interface NormalizedSubscribeInput {
  readonly canonicalUri: string;
  readonly domainId: string;
  readonly recrawlIntervalMs: number;
  readonly declared: { sourceType: string; contentType: string; license: string };
  readonly expectedPolicyId?: string;
  readonly expectedPolicyVersion?: string;
  readonly expectedPolicyDigest?: string;
}

function assertHttpsCanonicalUri(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new OperatorWorkError("UNKNOWN_ACTION", "subscription.create requires a canonicalUri");
  }
  const uri = value.trim();
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new OperatorWorkError("UNKNOWN_ACTION", "canonicalUri must be a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new OperatorWorkError(
      "UNKNOWN_ACTION",
      `canonicalUri must be an https origin (got ${url.protocol}//——新 source origin 需走 TrustPolicy 签发流程)`,
    );
  }
  return uri;
}

function normalizeSubscribeInput(raw: unknown): NormalizedSubscribeInput {
  assertAllowedInputFields(raw, SUBSCRIBE_FIELDS, "intake/subscription.create");
  const input = raw as Record<string, unknown>;
  const canonicalUri = assertHttpsCanonicalUri(input.canonicalUri);
  const domainId = typeof input.domainId === "string" ? input.domainId.trim() : "";
  if (!domainId) {
    throw new OperatorWorkError("UNKNOWN_ACTION", "subscription.create requires a non-empty domainId");
  }
  const interval = input.recrawlIntervalMs;
  if (
    typeof interval !== "number" ||
    !Number.isFinite(interval) ||
    interval <= 0 ||
    interval > RECRAWL_MAX_MS
  ) {
    throw new OperatorWorkError(
      "UNKNOWN_ACTION",
      `recrawlIntervalMs must be a positive finite number ≤ ${RECRAWL_MAX_MS}`,
    );
  }
  const declared = input.declared;
  if (typeof declared !== "object" || declared === null || Array.isArray(declared)) {
    throw new OperatorWorkError("UNKNOWN_ACTION", "declared must be an object");
  }
  const d = declared as Record<string, unknown>;
  for (const key of ["sourceType", "contentType", "license"] as const) {
    if (typeof d[key] !== "string" || (d[key] as string).trim() === "") {
      throw new OperatorWorkError("UNKNOWN_ACTION", `declared.${key} must be a non-empty string`);
    }
  }
  const out: Record<string, unknown> = {
    canonicalUri,
    domainId,
    recrawlIntervalMs: interval,
    declared: {
      sourceType: (d.sourceType as string).trim(),
      contentType: (d.contentType as string).trim(),
      license: (d.license as string).trim(),
    },
  };
  for (const key of ["expectedPolicyId", "expectedPolicyVersion", "expectedPolicyDigest"] as const) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== "string" || (input[key] as string).trim() === "") {
        throw new OperatorWorkError("UNKNOWN_ACTION", `${key} must be a non-empty string when present`);
      }
      out[key] = (input[key] as string).trim();
    }
  }
  return out as unknown as NormalizedSubscribeInput;
}

function normalizeTriggerInput(raw: unknown): { subscriptionId: string } {
  assertAllowedInputFields(raw, TRIGGER_FIELDS, "intake/run.trigger");
  const input = raw as Record<string, unknown>;
  const subscriptionId =
    typeof input.subscriptionId === "string" ? input.subscriptionId.trim() : "";
  if (!subscriptionId) {
    throw new OperatorWorkError("UNKNOWN_ACTION", "run.trigger requires a non-empty subscriptionId");
  }
  return { subscriptionId };
}

export function createIntakeSubscriptionCreateAdapter(
  deps: IntakeAdapterDeps,
): OperatorModeAdapter & { readonly nativeKind: "intake-run" } {
  const clock = deps.clock ?? (() => Date.now());

  return {
    mode: "intake",
    action: "subscription.create",
    nativeKind: "intake-run",

    describe(): OperatorFormDescriptor {
      return {
        title: "创建摄入订阅（intake）",
        description:
          "经 PTH 既有订阅入口创建 probing 订阅；请求 URI 必须通过当前已验签 TrustPolicy 的 authorizeFetch/authorizeUse。",
        fields: [
          { name: "canonicalUri", type: "string", required: true, description: "规范抓取 URI（必须 https 且被策略 allow）" },
          { name: "domainId", type: "string", required: true, description: "知识域 ID" },
          { name: "recrawlIntervalMs", type: "number", required: true, description: "重爬间隔（毫秒）" },
          { name: "declared", type: "object", required: true, description: "{sourceType, contentType, license}" },
          { name: "expectedPolicyId", type: "string", required: false, description: "钉定期望 policy id（可选）" },
          { name: "expectedPolicyVersion", type: "string", required: false, description: "钉定期望 policy version（可选）" },
          { name: "expectedPolicyDigest", type: "string", required: false, description: "钉定期望 policy digest（可选）" },
        ],
      };
    },

    async preview(input, context: OperatorContext) {
      const normalized = normalizeSubscribeInput(input);
      return buildOperatorPreview(
        {
          mode: "intake",
          action: "subscription.create",
          normalizedInput: normalized as unknown as Record<string, unknown>,
          summary: [
            `创建知识摄入订阅（probing）`,
            `来源：${normalized.canonicalUri}`,
            `知识域：${normalized.domainId}；重爬间隔：${normalized.recrawlIntervalMs}ms`,
            `声明属性：${normalized.declared.sourceType} / ${normalized.declared.contentType} / ${normalized.declared.license}`,
            normalized.expectedPolicyDigest
              ? `钉定期望 policy digest：${normalized.expectedPolicyDigest.slice(0, 16)}…`
              : `未钉定期望 policy（以 PTH 当前已验签策略为准）`,
          ],
          // 外部内容进入知识库——高风险确认（输入动作标签）；可经撤销订阅回滚。
          impact: { scope: "知识摄入订阅（TrustPolicy 门禁）", reversible: true, risk: "high" },
          nativeTarget: "pth:/api/v1/intake/subscriptions",
          expiresAt: new Date(clock() + OPERATOR_PREVIEW_TTL_MS).toISOString(),
        },
        context,
      );
    },

    async submit(preview, context: OperatorContext) {
      const input = preview.normalizedInput as unknown as NormalizedSubscribeInput;
      const subscription = await deps.client.createIntakeSubscription({
        canonicalUri: input.canonicalUri,
        domainId: input.domainId,
        recrawlIntervalMs: input.recrawlIntervalMs,
        declared: input.declared,
        // 原生幂等键 = previewId：歧义重试由 PTH 侧去重返回原订阅。
        idempotencyKey: preview.previewId,
        ...(input.expectedPolicyId !== undefined ? { expectedPolicyId: input.expectedPolicyId } : {}),
        ...(input.expectedPolicyVersion !== undefined
          ? { expectedPolicyVersion: input.expectedPolicyVersion }
          : {}),
        ...(input.expectedPolicyDigest !== undefined
          ? { expectedPolicyDigest: input.expectedPolicyDigest }
          : {}),
      });
      return {
        mode: "intake",
        kind: "intake-run",
        id: subscription.id,
        tenantId: context.tenant,
        submittedAt: new Date(clock()).toISOString(),
      } satisfies NativeWorkRef;
    },

    async inspect(ref, _context: OperatorContext): Promise<NativeWorkProjection> {
      const subscription = await deps.client.getIntakeSubscription(ref.id);
      if (!subscription) {
        throw new OperatorWorkError("PREVIEW_UNKNOWN", `subscription not found: ${ref.id}`);
      }
      return { ref, status: subscription.status, observedAt: new Date(clock()).toISOString() };
    },

    async evaluate(ref, context: OperatorContext): Promise<OperatorAcceptanceProjection> {
      const subscription = await deps.client.getIntakeSubscription(ref.id);
      if (!subscription) {
        throw new OperatorWorkError("PREVIEW_UNKNOWN", `subscription not found: ${ref.id}`);
      }
      void context;
      return {
        ref,
        accepted: subscription.status === "probing" || subscription.status === "active",
        evidence: {
          status: subscription.status,
          ...(subscription.policyId !== undefined ? { policyId: subscription.policyId } : {}),
          ...(subscription.policyVersion !== undefined ? { policyVersion: subscription.policyVersion } : {}),
          ...(subscription.policyDigest !== undefined ? { policyDigest: subscription.policyDigest } : {}),
        },
      };
    },
  };
}

export function createIntakeRunTriggerAdapter(
  deps: IntakeAdapterDeps,
): OperatorModeAdapter & { readonly nativeKind: "intake-run" } {
  const clock = deps.clock ?? (() => Date.now());

  return {
    mode: "intake",
    action: "run.trigger",
    nativeKind: "intake-run",

    describe(): OperatorFormDescriptor {
      return {
        title: "触发摄入 run（intake）",
        description: "对既有订阅手动唤醒一次原生摄入 run（不接受任意 URL；走 N29 正式内环）。",
        fields: [
          { name: "subscriptionId", type: "string", required: true, description: "既有订阅 ID" },
        ],
      };
    },

    async preview(input, context: OperatorContext) {
      const normalized = normalizeTriggerInput(input);
      return buildOperatorPreview(
        {
          mode: "intake",
          action: "run.trigger",
          normalizedInput: normalized,
          summary: [
            `手动触发一次摄入 run`,
            `订阅：${normalized.subscriptionId}`,
            `run 将走完整内环（fetch → admit → extract → verify），不绕过任何门禁`,
          ],
          impact: { scope: "摄入 run 调度", reversible: false, risk: "medium" },
          nativeTarget: "pth:/api/v1/intake/runs",
          expiresAt: new Date(clock() + OPERATOR_PREVIEW_TTL_MS).toISOString(),
        },
        context,
      );
    },

    async submit(preview, context: OperatorContext) {
      const input = preview.normalizedInput as { subscriptionId: string };
      const run = await deps.client.triggerIntakeRun({
        subscriptionId: input.subscriptionId,
        // 原生幂等键 = previewId：歧义网络超时后的重试由 PTH 返回原 run。
        idempotencyKey: preview.previewId,
      });
      return {
        mode: "intake",
        kind: "intake-run",
        id: run.id,
        tenantId: context.tenant,
        submittedAt: new Date(clock()).toISOString(),
      } satisfies NativeWorkRef;
    },

    async inspect(ref, _context: OperatorContext): Promise<NativeWorkProjection> {
      const run = await deps.client.getIntakeRun(ref.id);
      if (!run) {
        throw new OperatorWorkError("PREVIEW_UNKNOWN", `intake run not found: ${ref.id}`);
      }
      return {
        ref,
        status: run.stage !== undefined ? `${run.status}@${run.stage}` : run.status,
        observedAt: new Date(clock()).toISOString(),
      };
    },

    async evaluate(ref, _context: OperatorContext): Promise<OperatorAcceptanceProjection> {
      const run = await deps.client.getIntakeRun(ref.id);
      if (!run) {
        throw new OperatorWorkError("PREVIEW_UNKNOWN", `intake run not found: ${ref.id}`);
      }
      return {
        ref,
        accepted: run.status === "completed",
        evidence: {
          status: run.status,
          ...(run.stage !== undefined ? { stage: run.stage } : {}),
          ...(run.attempt !== undefined ? { attempt: run.attempt } : {}),
        },
      };
    },
  };
}
