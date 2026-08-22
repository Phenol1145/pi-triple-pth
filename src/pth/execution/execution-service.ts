/**
 * execution/execution-service.ts — 执行门面（模块化 v2 P2-1）。
 *
 * 唯一执行缝：request + grant 先经 grant service 校验（签名/过期/generation/replay/绑定），
 * 通过后才允许进入 ExecutionPort；无 grant 不得执行。
 */

import type { ExecutionGrant, ExecutionPort, ExecutionRequest, ExecutionResult } from "@away_from/pth-contracts";
import type { ExecutionGrantService } from "./authorization/execution-grant-service.js";

export interface ExecutionServiceDeps {
  grantService: ExecutionGrantService;
  port: ExecutionPort;
}

export interface ExecutionService {
  execute(request: ExecutionRequest, grant: ExecutionGrant, opts?: { leaseGeneration?: number; signal?: AbortSignal }): Promise<ExecutionResult>;
}

export function createExecutionService(deps: ExecutionServiceDeps): ExecutionService {
  return {
    async execute(request, grant, opts = {}) {
      const verified = deps.grantService.verify(grant, {
        request,
        leaseGeneration: opts.leaseGeneration ?? grant.lease.generation,
      });
      if (!verified.ok) {
        return { ok: false, stdout: "", stderr: "", durationMs: 0, error: { code: "grant-rejected", message: verified.error } };
      }
      return deps.port.execute(request, verified.grant, opts.signal);
    },
  };
}
