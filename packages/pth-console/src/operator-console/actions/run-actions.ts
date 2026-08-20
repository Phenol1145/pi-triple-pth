/**
 * operator-console/actions/run-actions.ts — run/task.publish 原生动作 adapter（N33 Task 5 Step 4）
 *
 * 唯一登记的 run 模式动作：向 PTH kernel 发布任务。
 *  - 输入白名单：title/text/tags；任何额外字段（path/method/command/sql/url/...）
 *    在 preview 阶段即拒绝，不触达 client；
 *  - submit 由服务端（PTL server 进程，非浏览器）盖章 M0 WorkEnvelope：
 *    workId 新铸、mode=run、causationId=previewId；Mode 不可原地改变。
 */

import { randomUUID } from "node:crypto";
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

const INPUT_FIELDS = ["title", "text", "tags"] as const;
const TITLE_MAX = 200;
const TEXT_MAX = 64 * 1024;

export interface RunTaskPublishAdapterDeps {
  readonly client: PthOperatorClient;
  readonly clock?: () => number;
  /** WorkEnvelope 权威/预算策略引用（服务端配置，缺省 console 本地默认）。 */
  readonly authorityPolicyRef?: string;
  readonly budgetPolicyRef?: string;
}

function normalizeInput(raw: unknown): { title: string; text: string; tags?: string[] } {
  assertAllowedInputFields(raw, INPUT_FIELDS, "run/task.publish");
  const input = raw as Record<string, unknown>;
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!title) throw new OperatorWorkError("UNKNOWN_ACTION", "run/task.publish requires a non-empty title");
  if (!text) throw new OperatorWorkError("UNKNOWN_ACTION", "run/task.publish requires a non-empty text");
  if (title.length > TITLE_MAX || text.length > TEXT_MAX) {
    throw new OperatorWorkError(
      "UNKNOWN_ACTION",
      `task too large: title ≤${TITLE_MAX} chars, text ≤${TEXT_MAX} chars`,
    );
  }
  let tags: string[] | undefined;
  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags) || input.tags.some((t) => typeof t !== "string" || t.trim() === "")) {
      throw new OperatorWorkError("UNKNOWN_ACTION", "run/task.publish tags must be non-empty strings");
    }
    tags = input.tags.map((t) => (t as string).trim());
  }
  return tags !== undefined ? { title, text, tags } : { title, text };
}

export function createRunTaskPublishAdapter(
  deps: RunTaskPublishAdapterDeps,
): OperatorModeAdapter & { readonly nativeKind: "task" } {
  const clock = deps.clock ?? (() => Date.now());
  const authorityPolicyRef = deps.authorityPolicyRef ?? "ptl-operator:authority:default";
  const budgetPolicyRef = deps.budgetPolicyRef ?? "ptl-operator:budget:default";

  return {
    mode: "run",
    action: "task.publish",
    nativeKind: "task",

    describe(): OperatorFormDescriptor {
      return {
        title: "发布任务（run）",
        description: "向 PTH kernel 任务队列发布一个任务（服务端盖章 WorkEnvelope mode=run）。",
        fields: [
          { name: "title", type: "string", required: true, description: `任务标题（≤${TITLE_MAX} 字符）` },
          { name: "text", type: "string", required: true, description: `任务正文（≤${TEXT_MAX} 字符）` },
          { name: "tags", type: "array", required: false, description: "标签（字符串数组，可选）" },
        ],
      };
    },

    async preview(input, context: OperatorContext) {
      const normalized = normalizeInput(input);
      return buildOperatorPreview(
        {
          mode: "run",
          action: "task.publish",
          normalizedInput: normalized,
          summary: [
            `发布任务到 PTH kernel 队列`,
            `标题：${normalized.title}`,
            `正文长度：${normalized.text.length} 字符`,
            `标签：${normalized.tags?.join(", ") ?? "（无）"}`,
          ],
          impact: { scope: "PTH kernel 任务队列", reversible: true, risk: "low" },
          nativeTarget: "pth:/api/v1/kernel/tasks",
          expiresAt: new Date(clock() + OPERATOR_PREVIEW_TTL_MS).toISOString(),
        },
        context,
      );
    },

    async submit(preview, context: OperatorContext, idempotencyKey?: string) {
      const input = preview.normalizedInput as { title: string; text: string; tags?: string[] };
      // M0 WorkEnvelope：服务端盖章，mode=run 不可原地改变；causation 绑定本次预览。
      const work = {
        workId: `work-${randomUUID()}`,
        mode: "run" as const,
        objective: input.title,
        authorityPolicyRef,
        budgetPolicyRef,
        causationId: preview.previewId,
      };
      const task = await deps.client.publishTask({
        title: input.title,
        text: input.text,
        ...(input.tags ? { tags: input.tags } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
        payload: {
          work,
          operatorPreviewId: preview.previewId,
          operatorPreviewDigest: preview.previewDigest,
        },
      });
      return {
        mode: "run",
        kind: "task",
        id: task.id,
        tenantId: context.tenant,
        submittedAt: new Date(clock()).toISOString(),
      } satisfies NativeWorkRef;
    },

    async inspect(ref, context: OperatorContext): Promise<NativeWorkProjection> {
      const row = await deps.client.getTask(ref.id);
      if (!row) {
        throw new OperatorWorkError("PREVIEW_UNKNOWN", `task not found: ${ref.id}`);
      }
      if (row.tenantId !== undefined && row.tenantId !== context.tenant) {
        throw new OperatorWorkError(
          "CROSS_TENANT_REF",
          "cross-tenant native task row rejected: tenant mismatch",
        );
      }
      return { ref, status: row.status, observedAt: new Date(clock()).toISOString() };
    },

    async evaluate(ref, context: OperatorContext): Promise<OperatorAcceptanceProjection> {
      const projection = await this.inspect(ref, context);
      return {
        ref,
        accepted: projection.status === "completed",
        evidence: { status: projection.status, observedAt: projection.observedAt },
      };
    },
  };
}
