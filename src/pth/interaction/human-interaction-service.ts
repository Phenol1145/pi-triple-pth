/**
 * interaction/human-interaction-service.ts — 人工交互应用服务（N25 基础）。
 *
 * 只依赖 HumanInteractionRepository 与 contracts 类型；不依赖 AgentEngine。
 * 负责请求创建/列表/查询/响应/取消的输入校验与租户传递。
 */

import { randomUUID } from "node:crypto";
import type {
  ApprovalDecision,
  HumanRequest,
  HumanResponseResult,
} from "@away_from/pth-contracts";
import { isApprovalDecision } from "@away_from/pth-contracts";
import type {
  CreateHumanRequestInput,
  HumanInteractionRepository,
  ListHumanRequestsFilter,
} from "./human-interaction-repository.js";

export interface CreateHumanRequestServiceInput {
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
}

export interface RespondHumanRequestServiceInput {
  requestId: string;
  decision: ApprovalDecision;
  reason?: string;
  principalId: string;
  idempotencyKey?: string;
}

export interface HumanInteractionService {
  createRequest(input: CreateHumanRequestServiceInput): Promise<HumanRequest>;
  listRequests(filter: ListHumanRequestsFilter): Promise<HumanRequest[]>;
  getRequest(id: string, tenantId: string): Promise<HumanRequest | null>;
  respond(input: RespondHumanRequestServiceInput, tenantId: string): Promise<HumanResponseResult>;
  cancelRequest(id: string, tenantId: string, principalId: string): Promise<HumanRequest | null>;
}

export class PgHumanInteractionService implements HumanInteractionService {
  constructor(private repo: HumanInteractionRepository) {}

  async createRequest(input: CreateHumanRequestServiceInput): Promise<HumanRequest> {
    if (!input.taskId || !input.kind || !input.title || !input.body || !input.createdBy || !input.tenantId) {
      const err = new Error("taskId/kind/title/body/createdBy/tenantId required") as Error & { statusCode?: number };
      err.statusCode = 400;
      throw err;
    }
    if (input.assignedTo !== undefined && (!Array.isArray(input.assignedTo) || input.assignedTo.some((x) => typeof x !== "string" || x.trim() === ""))) {
      const err = new Error("assignedTo 可选——若提供必须是字符串数组") as Error & { statusCode?: number };
      err.statusCode = 400;
      throw err;
    }
    return this.repo.createRequest({
      id: `human-${randomUUID()}`,
      tenantId: input.tenantId,
      taskId: input.taskId,
      kind: input.kind,
      title: input.title,
      body: input.body,
      assignedTo: input.assignedTo ?? [],
      ...(input.policySelector ? { policySelector: input.policySelector } : {}),
      createdBy: input.createdBy,
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    });
  }

  listRequests(filter: ListHumanRequestsFilter): Promise<HumanRequest[]> {
    return this.repo.listRequests(filter);
  }

  getRequest(id: string, tenantId: string): Promise<HumanRequest | null> {
    return this.repo.getRequest(id, tenantId);
  }

  respond(input: RespondHumanRequestServiceInput, tenantId: string): Promise<HumanResponseResult> {
    if (!input.requestId || !isApprovalDecision(input.decision) || !input.principalId) {
      const err = new Error("requestId/decision(approved|rejected)/principalId required") as Error & { statusCode?: number };
      err.statusCode = 400;
      throw err;
    }
    return this.repo.respond({
      requestId: input.requestId,
      decision: input.decision,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      principalId: input.principalId,
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
    }, tenantId);
  }

  cancelRequest(id: string, tenantId: string, principalId: string): Promise<HumanRequest | null> {
    if (!id || !principalId) {
      const err = new Error("id/principalId required") as Error & { statusCode?: number };
      err.statusCode = 400;
      throw err;
    }
    return this.repo.cancelRequest(id, tenantId, principalId);
  }
}
