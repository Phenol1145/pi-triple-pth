/**
 * operator-console/actions/optimize-actions.ts — optimize/suggestion.apply 原生动作 adapter
 *
 * 只接受「当前可见的 draft 优化建议 ID」：preview 时从 PTH 拉取可见建议列表校验，
 * 非 draft / 不可见 ID 在 preview 阶段即拒绝；canary/deopt 护栏由 PTH 侧
 * applyOptimizerSuggestion 既有实现保留（本 adapter 只传 id，永不传 target/pattern
 * 等可篡改应用语义的字段）。
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

const INPUT_FIELDS = ["suggestionId"] as const;

export interface OptimizeAdapterDeps {
  readonly client: PthOperatorClient;
  readonly clock?: () => number;
}

function normalizeInput(raw: unknown): { suggestionId: string } {
  assertAllowedInputFields(raw, INPUT_FIELDS, "optimize/suggestion.apply");
  const input = raw as Record<string, unknown>;
  const suggestionId =
    typeof input.suggestionId === "string" ? input.suggestionId.trim() : "";
  if (!suggestionId) {
    throw new OperatorWorkError("UNKNOWN_ACTION", "suggestion.apply requires a non-empty suggestionId");
  }
  return { suggestionId };
}

export function createOptimizeSuggestionApplyAdapter(
  deps: OptimizeAdapterDeps,
): OperatorModeAdapter & { readonly nativeKind: "optimizer-work" } {
  const clock = deps.clock ?? (() => Date.now());

  async function findVisibleDraft(suggestionId: string) {
    const suggestions = await deps.client.listOptimizerSuggestions();
    const found = suggestions.find((s) => s.id === suggestionId);
    if (!found) {
      throw new OperatorWorkError(
        "UNKNOWN_ACTION",
        `suggestion ${suggestionId} not found or not visible to this tenant`,
      );
    }
    if (found.status !== "draft") {
      throw new OperatorWorkError(
        "UNKNOWN_ACTION",
        `suggestion ${suggestionId} is ${found.status}——仅可见 draft 建议可被批准应用`,
      );
    }
    return found;
  }

  return {
    mode: "optimize",
    action: "suggestion.apply",
    nativeKind: "optimizer-work",

    describe(): OperatorFormDescriptor {
      return {
        title: "批准应用优化建议（optimize）",
        description:
          "批准一条可见 draft 优化建议（prompt 资产规则追加 / 护栏 JIT 热调）；不可逆大类仍由 PTH 人工闸门拒绝。",
        fields: [
          { name: "suggestionId", type: "string", required: true, description: "可见 draft 建议 ID" },
        ],
      };
    },

    async preview(input, context: OperatorContext) {
      const normalized = normalizeInput(input);
      const suggestion = await findVisibleDraft(normalized.suggestionId);
      return buildOperatorPreview(
        {
          mode: "optimize",
          action: "suggestion.apply",
          normalizedInput: normalized,
          summary: [
            `批准应用优化建议 ${suggestion.id}`,
            `建议摘要：${suggestion.preview ?? "（无预览）"}`,
            `canary/deopt 护栏由 PTH 侧既有实现保留`,
          ],
          impact: { scope: "优化建议应用（护栏热调/prompt 资产）", reversible: true, risk: "medium" },
          nativeTarget: "pth:/api/v1/kernel/optimizer/apply",
          expiresAt: new Date(clock() + OPERATOR_PREVIEW_TTL_MS).toISOString(),
        },
        context,
      );
    },

    async submit(preview, context: OperatorContext) {
      const input = preview.normalizedInput as { suggestionId: string };
      const result = await deps.client.applyOptimizerSuggestion({ id: input.suggestionId });
      if (!result.ok) {
        throw new OperatorWorkError(
          "NATIVE_SUBMIT_ERROR",
          `optimizer apply rejected by PTH: ${result.error ?? "unknown"}`,
        );
      }
      return {
        mode: "optimize",
        kind: "optimizer-work",
        id: input.suggestionId,
        tenantId: context.tenant,
        submittedAt: new Date(clock()).toISOString(),
      } satisfies NativeWorkRef;
    },

    async inspect(ref, _context: OperatorContext): Promise<NativeWorkProjection> {
      const suggestions = await deps.client.listOptimizerSuggestions();
      const found = suggestions.find((s) => s.id === ref.id);
      if (!found) {
        throw new OperatorWorkError("PREVIEW_UNKNOWN", `suggestion not found: ${ref.id}`);
      }
      return { ref, status: found.status, observedAt: new Date(clock()).toISOString() };
    },

    async evaluate(ref, _context: OperatorContext): Promise<OperatorAcceptanceProjection> {
      const suggestions = await deps.client.listOptimizerSuggestions();
      const found = suggestions.find((s) => s.id === ref.id);
      if (!found) {
        throw new OperatorWorkError("PREVIEW_UNKNOWN", `suggestion not found: ${ref.id}`);
      }
      return {
        ref,
        accepted: found.status === "official",
        evidence: { status: found.status, suggestionId: found.id },
      };
    },
  };
}
