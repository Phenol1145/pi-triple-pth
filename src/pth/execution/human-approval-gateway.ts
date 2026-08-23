/**
 * execution/human-approval-gateway.ts —— HumanApprovalGateway 进程内适配（TCE Phase 3）。
 *
 * 复用既有 human_requests 存储/API，不新建审批存储。v1 把指纹写入 request.body
 * （后续若 human_requests 增加 payload 列可无损迁移）；verify 校验 responded+approved+指纹。
 */
import type { HumanApprovalGateway } from "@away_from/pth-kernel-execution";

export interface HumanApprovalServicePort {
  createRequest(input: {
    tenantId: string;
    taskId: string;
    kind: string;
    title: string;
    body: string;
    assignedTo?: string[];
    policySelector?: string;
    createdBy: string;
    expiresAt?: string;
    idempotencyKey?: string;
  }): Promise<{ id: string }>;
  getRequest(id: string, tenantId: string): Promise<{
    status: string;
    body?: string | null;
    response?: { decision?: string } | null;
  } | null>;
}

export function createHumanApprovalGateway(service: HumanApprovalServicePort): HumanApprovalGateway {
  return {
    async requestApproval({ command, ctx, fingerprint }) {
      const body = JSON.stringify({
        fingerprint,
        command: {
          tool: command.tool,
          kind: command.kind,
          target: command.target ?? null,
        },
      });
      const req = await service.createRequest({
        tenantId: ctx.tenantId,
        taskId: ctx.taskId ?? "",
        kind: "command-approval",
        title: `批准执行 ${command.tool}`,
        body,
        createdBy: ctx.principalId,
      });
      return { requestId: req.id };
    },

    async verifyApproval({ ctx, fingerprint }) {
      const ref = ctx.approval?.ref;
      if (!ref) return { ok: false, reason: "approval ref missing" };
      const req = await service.getRequest(ref, ctx.tenantId);
      if (!req) return { ok: false, reason: "approval request not found" };
      if (req.status !== "responded" || req.response?.decision !== "approved") {
        return { ok: false, reason: `approval not approved (status=${req.status})` };
      }
      if (!req.body?.includes(fingerprint)) {
        return { ok: false, reason: "approval fingerprint mismatch" };
      }
      return { ok: true };
    },
  };
}
