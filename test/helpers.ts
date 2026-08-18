import { ORIGIN_ROLE, DEFAULT_ROLES, MID_ROLES, GOVERNANCE_ROLES } from "../src/pth/impls/roles/default-roles";
import { setDefaultRoles } from "../src/pth/kernel/execution/worker-cluster";
import { registerBuiltinSpaces } from "../src/pth/impls/spaces/builtin-spaces";
import { spaceRegistry } from "../src/pth/kernel/execution/space-registry";
import {
  PromotionConflictError,
  setSpaceLookup,
  type MemoryEntry,
  type PgMemoryStorePromotionMeta,
  type PgMemoryStorePromoteOfficialOptions,
} from "@away_from/pth-memory";

/** 测试装配：注入内置角色数据 + 标签注册（生产走 assembly——2026-08-13 审计 P2 核心/实现解耦）。
 *  2026-08-15 拆分：pth-memory 不 import core——测试同时注入内置空间查询。 */
export function installDefaultRoles(): void {
  setDefaultRoles(ORIGIN_ROLE, DEFAULT_ROLES, MID_ROLES, GOVERNANCE_ROLES);
  registerBuiltinSpaces(spaceRegistry);
  setSpaceLookup({ get: (id) => spaceRegistry.get(id) });
}

/**
 * 共享 fake store 的 promoteOfficial 内存版（语义对齐 PgMemoryStore.promoteOfficial）：
 * 单线程下直接校验 status=draft + version===expectedRevision → evaluate（锁内行语义）→
 * 置 official / version+1 / meta.promotion（verdicts 从旧 meta 取）→ 返回 { ok:true, id }；
 * 不匹配时抛 PromotionConflictError。供 kernel-routes、skill-staged-chain、knowledge-promotion
 * 三处 fake store 复用，避免重复实现。
 */
export function createInMemoryPromoteOfficial(rows: Map<string, any>) {
  return async function promoteOfficial(
    id: string,
    tenantId: string,
    expectedRevision: number,
    promotionMeta: PgMemoryStorePromotionMeta,
    opts: PgMemoryStorePromoteOfficialOptions = {},
  ): Promise<{ ok: true; id: string }> {
    const row = rows.get(id);
    if (!row) {
      throw new PromotionConflictError(`entry not found in tenant ${tenantId}`);
    }
    if (row.tenantId !== undefined && row.tenantId !== tenantId) {
      throw new PromotionConflictError(`entry not found in tenant ${tenantId}`);
    }

    const status = (row.status ?? "official") as string;
    const meta = (row.meta ?? {}) as Record<string, unknown>;

    // 幂等重放：已 official 且 meta.promotion.promotedBy === promoterRole → 直接 ok（不重复写）。
    if (status === "official") {
      const promotion = meta["promotion"] as { promotedBy?: unknown } | undefined;
      if (promotion && promotion.promotedBy === promotionMeta.promotedBy) {
        return { ok: true, id };
      }
      throw new PromotionConflictError(`entry is already official but not promoted by ${promotionMeta.promotedBy}`);
    }
    if (status !== "draft") {
      throw new PromotionConflictError("only draft knowledge can be promoted");
    }

    // CAS：调用方读到的 candidate revision 必须与当前 version 严格相等。
    const currentVersion = meta["version"];
    if (currentVersion !== expectedRevision) {
      throw new PromotionConflictError(`expectedRevision ${expectedRevision} does not match current version ${String(currentVersion)}`);
    }

    if (opts.evaluateAsync) {
      const decision = await opts.evaluateAsync(
        structuredClone({ ...row, status, meta }) as MemoryEntry,
        undefined as never,
      );
      if (!decision.ok) {
        throw new PromotionConflictError(decision.reason);
      }
    } else if (opts.evaluate) {
      const decision = opts.evaluate(structuredClone({ ...row, status, meta }) as MemoryEntry);
      if (!decision.ok) {
        throw new PromotionConflictError(decision.reason);
      }
    }

    const nextVersion = typeof currentVersion === "number" ? currentVersion + 1 : 2;
    row.status = "official";
    row.meta = {
      ...meta,
      version: nextVersion,
      promotion: {
        ...promotionMeta,
        verdicts: meta["verdicts"] ?? [],
      },
    };
    return { ok: true, id };
  };
}
