/**
 * fallback/requests.ts — fallback_requests 回退请求通道（F/WP4 Task 20）
 *
 * 骨架 v1.0：根回退节点把"图无法自处理的构件缺口"透传给人类（PTL 补全）。
 * 生产者：**手动建单先行**（自动触发判定[watchdog/T 参数/dispatch routing.failed]留 E 阶段）。
 *
 * Redis 结构：hash `fallback_requests`（field=requestId, value=JSON）
 *   {requestId, slotHint?, description, urgency(low|medium|high), createdAt,
 *    status(open|closed), closedBy?, closedAt?, component?{type,name,version}}
 * 选 hash（非 list）：单请求 O(1) 读取 + 单 HGETALL 出全量列表 + 无 list/index 同步成本
 * （单实例规模——spec §7 演进为多副本时再迁队列）。
 *
 * 闭合路径：
 *   1. respond 自动闭合——构件上传 API（POST /api/v1/components）携带 requestId，
 *      pth 保存成功后自动 close（route 层接线，见 routes-programs.ts）
 *   2. 手动闭合——POST /api/v1/fallback-requests/:id/close
 */

import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import type { AuditWriter } from "../observability/audit.js";
import type { Result } from "../programs/types.js";

export const URGENCIES = ["low", "medium", "high"] as const;
export type Urgency = (typeof URGENCIES)[number];

export interface FallbackRequest {
  requestId: string;
  slotHint?: string;
  description: string;
  urgency: Urgency;
  createdAt: string; // ISO
  status: "open" | "closed";
  closedBy?: string;
  closedAt?: string;
  /** respond 上传闭合时记录填充构件（审计追溯） */
  component?: { type: string; name: string; version: number };
}

export interface FallbackCreateInput {
  slotHint?: string;
  description: string;
  urgency?: string;
}

export class FallbackRequestStore {
  constructor(
    private redis: Redis,
    private audit?: AuditWriter,
  ) {}

  private key(): string {
    return "fallback_requests";
  }

  async create(input: FallbackCreateInput, ctx: { tenantId: string }): Promise<Result<FallbackRequest>> {
    // 浅校验（O(1)）：字段良构即可
    if (typeof input.description !== "string" || input.description.trim().length === 0) {
      return { ok: false, error: "description is required (non-empty string)" };
    }
    if (input.description.length > 2000) {
      return { ok: false, error: "description too long (max 2000 chars)" };
    }
    if (input.slotHint !== undefined && (typeof input.slotHint !== "string" || input.slotHint.trim().length === 0)) {
      return { ok: false, error: "slotHint must be a non-empty string" };
    }
    let urgency: Urgency = "medium";
    if (input.urgency !== undefined) {
      if (typeof input.urgency !== "string" || !(URGENCIES as readonly string[]).includes(input.urgency)) {
        return { ok: false, error: `urgency must be one of ${URGENCIES.join(" | ")}` };
      }
      urgency = input.urgency as Urgency;
    }

    const req: FallbackRequest = {
      requestId: randomUUID(),
      slotHint: input.slotHint,
      description: input.description,
      urgency,
      createdAt: new Date().toISOString(),
      status: "open",
    };
    await this.redis.hset(this.key(), req.requestId, JSON.stringify(req));
    await this.audit?.write({
      tenantId: ctx.tenantId,
      actor: "user",
      action: "fallback_request_created",
      details: { requestId: req.requestId, slotHint: req.slotHint, description: req.description, urgency: req.urgency },
    });
    return { ok: true, value: req };
  }

  async get(requestId: string): Promise<Result<FallbackRequest>> {
    const raw = await this.redis.hget(this.key(), requestId);
    if (!raw) return { ok: false, error: `fallback request "${requestId}" not found` };
    return { ok: true, value: JSON.parse(raw) as FallbackRequest };
  }

  /** 列表：open 优先，同状态按 createdAt 倒序（最新在前）。 */
  async list(): Promise<FallbackRequest[]> {
    const all = await this.redis.hgetall(this.key());
    const reqs = Object.values(all).map((raw) => JSON.parse(raw) as FallbackRequest);
    reqs.sort((a, b) => {
      if (a.status !== b.status) return a.status === "open" ? -1 : 1;
      return b.createdAt.localeCompare(a.createdAt);
    });
    return reqs;
  }

  /**
   * 闭合请求。**幂等**：已是 closed 直接返回现有记录且不重复审计（网络重试安全）；
   * 首次 open→closed 写 closedBy/closedAt/component + 审计。
   */
  async close(
    requestId: string,
    opts: { tenantId: string; closedBy: string; component?: { type: string; name: string; version: number } },
  ): Promise<Result<FallbackRequest>> {
    const existing = await this.get(requestId);
    if (!existing.ok) return existing;
    if (existing.value.status === "closed") {
      return { ok: true, value: existing.value };
    }

    const updated: FallbackRequest = {
      ...existing.value,
      status: "closed",
      closedBy: opts.closedBy,
      closedAt: new Date().toISOString(),
      ...(opts.component !== undefined ? { component: opts.component } : {}),
    };
    await this.redis.hset(this.key(), requestId, JSON.stringify(updated));
    await this.audit?.write({
      tenantId: opts.tenantId,
      actor: opts.closedBy,
      action: "fallback_request_closed",
      details: {
        requestId,
        slotHint: updated.slotHint,
        component: opts.component,
      },
    });
    return { ok: true, value: updated };
  }
}
