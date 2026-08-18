import { randomUUID } from "node:crypto";
import type pg from "pg";
import { PROVENANCE_REQUIRED_KINDS, validateKnowledgeProvenance } from "./knowledge-provenance.js";

/** 缺省租户 id（tenant_id 列 DDL 已 default 'default'；本批不迁移存量行）。 */
export const DEFAULT_TENANT_ID = "default";

/** 稳定 JSON 序列化（递归按键排序）——对齐 jsonb 等值语义（jsonb 比较忽略键序）。 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** write 变更判据：剥离系统生成键 updatedAt 后的 effective meta（version 参与比较，由本方法重写）。 */
function effectiveMetaForCompare(meta: Record<string, unknown> | undefined): string {
  const copy = { ...(meta ?? {}) };
  delete copy.updatedAt;
  return stableStringify(copy);
}

/**
 * write 的统一物化变更判据：content 不同 OR status 不同（缺省 official 归一）OR effective meta
 * 不同。write 内「是否写 history」与 UPSERT 的「是否 version+1」必须使用同一判据。
 */
function isSameMaterializedState(
  old: { content: string; status: string; meta: Record<string, unknown> },
  entry: MemoryEntry,
): boolean {
  return old.content === entry.content
    && old.status === (entry.status ?? "official")
    && effectiveMetaForCompare(old.meta) === effectiveMetaForCompare(entry.meta);
}

/**
 * MemoryEntry —— 对齐 memory v1 entry.ts 结构（extensions/agent-lab/src/memory/entry.ts）。
 * 列映射：ruleRef→rule_ref、idempotencyKey→idempotency_key、promotedFrom→promoted_from、
 * ttlExpiresAt→ttl_expires_at（epoch ms）、meta 内嵌 version/hitCount/notWriteBack（从独立列并入）。
 */
export interface MemoryEntry {
  id: string;
  /** 租户 id（不强制——存量调用缺省 DEFAULT_TENANT_ID）。 */
  tenantId?: string;
  kind: string;
  anchors: string[];
  content: string;
  ruleRef?: string;
  idempotencyKey?: string;
  status: "draft" | "official" | "archived";
  ttlExpiresAt?: number;
  promotedFrom?: string;
  meta: Record<string, unknown>;
}

/** append-only revision 行（memory_revisions 映射——N19 Phase 1b 设计 2.2）。 */
export interface MemoryRevision {
  entryId: string;
  tenantId: string;
  revision: number;
  content: string;
  status: MemoryEntry["status"];
  anchors: string[];
  meta: Record<string, unknown>;
  createdAt: string;
  createdBy?: string;
  reason?: string;
}

/** write opts：force=系统通道；createdBy/reason=revision 历史记录（N19 Phase 1b 设计 2.3）。 */
export interface PgMemoryStoreWriteOptions {
  force?: boolean;
  createdBy?: string;
  reason?: string;
  /**
   * N29/P0-4：official 领域知识（PROVENANCE_REQUIRED_KINDS）直写授权。
   * 与 worker capability 完全分离——只有 seed/migration 与 promotion 内部路径可以出示；
   * 缺省（含 `force: true` 的系统文档通道）一律 fail closed。
   */
  knowledgeOfficialAuthority?: KnowledgeOfficialAuthority;
}

/** update opts：force=skill 维护通道；createdBy/reason=update revision 历史记录（F1 6.3）。 */
export interface PgMemoryStoreUpdateOptions {
  force?: boolean;
  tenantId?: string;
  createdBy?: string;
  reason?: string;
  /** N29/P0-4：official 领域知识状态流转授权（同 write；缺省 fail closed）。 */
  knowledgeOfficialAuthority?: KnowledgeOfficialAuthority;
}

/**
 * N29/P0-4（§1.6 / §2.4 G0）：official 领域知识的内部写授权。
 *
 * 只有两类持有者：
 *  - `"promotion-service"`：Promotion Service 的窄 CAS 路径（`promoteOfficial()`）；
 *  - `"seed-migration"`：bootstrap seed / 数据迁移脚本（与 worker capability 分离的内部通道）。
 *
 * 普通 `memory.write` / store write（含 service 与 platform-admin service 调用）不出示 authority
 * → 一律拒绝写 official 领域知识；`force: true`（系统文档通道）不是 authority，不构成旁路。
 */
export type KnowledgeOfficialAuthority = "promotion-service" | "seed-migration";

/** official 领域知识直写被拒的统一错误前缀（测试与调用方据此断言）。 */
export const KNOWLEDGE_OFFICIAL_WRITE_DENIED = "memory: knowledge official 直写被拒绝";

/** N29/P0-4：判定"是否受 official 知识写授权约束"的唯一事实源。 */
function requiresKnowledgeOfficialAuthority(kind: string, status: string | undefined): boolean {
  return (status ?? "official") === "official" && PROVENANCE_REQUIRED_KINDS.has(kind);
}

function denyKnowledgeOfficialWrite(kind: string, op: "write" | "update" | "incrementAggregate"): never {
  throw new Error(
    `${KNOWLEDGE_OFFICIAL_WRITE_DENIED}（${op} kind="${kind}"）——`
    + `外部内容与普通写侧只能产出 private draft candidate；official 只能由 Promotion Service `
    + `的 promoteOfficial() 在 VerificationPlan + 双 verdict + exact hash 满足后晋升`
    + `（seed/migration 请出示 knowledgeOfficialAuthority）`,
  );
}

/** promotion CAS 冲突——结构化错误（不静默返回 ok）。 */
export class PromotionConflictError extends Error {
  readonly code = "PROMOTION_CONFLICT";
  constructor(message: string) {
    super(message);
    this.name = "PromotionConflictError";
  }
}

/** promotion CAS 写进 meta.promotion 的内容（verdicts 由 store 在锁内从旧行补全）。 */
export interface PgMemoryStorePromotionMeta {
  promotedBy: string;
  principalId?: string;
  note?: string;
  promotedAt: number;
  verdicts?: unknown;
}

/** promoteOfficial 选项：evaluate 在锁内基于旧行重算晋升门禁；enqueueOutbox 在同一事务执行。
 *  R3/P0-3：evaluateAsync 接收同一事务 client，供 service 在锁内重读持久 plan/verdict rows 后再判定。 */
export interface PgMemoryStorePromoteOfficialOptions {
  createdBy?: string;
  reason?: string;
  evaluate?: (entry: MemoryEntry) => { ok: true } | { ok: false; reason: string };
  evaluateAsync?: (entry: MemoryEntry, client: pg.PoolClient) => Promise<{ ok: true } | { ok: false; reason: string }>;
  enqueueOutbox?: (client: pg.PoolClient) => Promise<void>;
}

/**
 * PgMemoryStore —— memory v1 MemoryStore 接口的 pg 实现（接口保留、实现替换）。
 *
 * 与 FS 实现（tmp+rename 原子写 / 文件索引）的语义对齐点：
 * - write：upsert；同 id 已存在（新状态）→ version+1（CAS 语义）；
 * - retrieve：锚点检索用 GIN 索引 + `?|`（jsonb 任一包含，pg 16 已验证），多锚点 = 并集（对齐 FS 索引语义）；
 * - bumpHitCount：独立列 hit_count 旁路 UPDATE，不触发 version 递增（对齐 FS 独立计数器文件）；
 * - 返回按 id 字典序稳定排序（DSP 快照确定性，对齐 FS retrieve 的 sort）。
 *
 * 适配说明（brief 骨架的两处修正，均已在 pg16 实测）：
 * - `anchors ?| $n::jsonb` 不存在该操作符（jsonb ?| 右操作数为 text[]）→ 改为 `?| $n::text[]` 传原始数组；
 * - write 的 status 参数必须显式 `?? "official"`（测试条目多不传 status；node-pg 把 undefined 序列化为
 *   NULL，而 memory_entries.status 为 NOT NULL → 不默认会直接违反约束）。
 * 幂等与 meta 合并（对齐 FS write 路径②③，见 task-4-report fix 段）：
 * - 路径②「同 version+同 content」幂等重落库不递增版本（watermark 旁路）；判断取调用方声明的版本：
 *   `meta->>'version' = EXCLUDED.meta->>'version'`（FS 等价：entry.meta.version === existing.meta.version）；
 * - 路径②③冲突时合并调用方 meta：`memory_entries.meta || EXCLUDED.meta || {version, updatedAt}`
 *   （FS 等价：{...existing.meta, ...(entry.meta ?? {}), version, updatedAt, hitCount} 整条写回）。
 * 遗留差异（见 task-4-report 疑虑）：update 仅更新 content/status（brief 骨架），anchors/kind 变更请走 write。
 */
export const REQUIRE_TENANT_ERROR = "memory: tenantId required（TenantScope fail-closed）";

export class PgMemoryStore {
  private readonly defaultTenantId: string;
  private readonly requireTenant: boolean;

  constructor(private pool: pg.Pool, opts?: { defaultTenantId?: string; requireTenant?: boolean }) {
    this.defaultTenantId = opts?.defaultTenantId ?? DEFAULT_TENANT_ID;
    this.requireTenant = opts?.requireTenant ?? false;
  }

  /** write 侧 fail-closed：requireTenant=true 时 entry.tenantId 必填。 */
  private resolveEntryTenant(entry: MemoryEntry): string {
    if (this.requireTenant && !entry.tenantId) {
      throw new Error(REQUIRE_TENANT_ERROR);
    }
    return entry.tenantId ?? this.defaultTenantId;
  }

  /** opts 侧 fail-closed：requireTenant=true 时 opts.tenantId 必填。 */
  private resolveTenantOpts(opts?: { tenantId?: string }): string {
    if (this.requireTenant && !opts?.tenantId) {
      throw new Error(REQUIRE_TENANT_ERROR);
    }
    return opts?.tenantId ?? this.defaultTenantId;
  }

  /**
   * upsert：id 冲突则版本递增（CAS 语义，对齐 FS 实现）。anchors 必须显式传非空数组（schema CHECK 约束）。
   * N19 Phase 1b：
   * - official + PROVENANCE_REQUIRED_KINDS 先 validateKnowledgeProvenance，失败 throw 不落库；
   * - 事务化 append-only：单 client BEGIN → SELECT … FOR UPDATE（by id）→ 旧行写 memory_revisions
   *   → INSERT…ON CONFLICT DO UPDATE → COMMIT；异常 ROLLBACK 重抛；finally release。
   */
  async write(entry: MemoryEntry, opts?: PgMemoryStoreWriteOptions): Promise<void> {
    // 缺省 id 生成（memory 封装签名 id?——调用方可不传——防 pg not-null 违反）
    if (!entry.id) entry.id = randomUUID();
    // 系统文档保护（Prompt 框架化 2026-08-09）：静态上下文（角色文档/能力索引/自修改指南）
    // 不可被 worker 覆盖——只有系统注入（force）可写——防误覆盖污染所有后续任务的 system 注入/指针
    if (!opts?.force && isSystemDocId(entry.id)) {
      throw new Error(`memory.write: 系统文档 ${entry.id} 受保护（静态上下文——worker 不可覆盖）`);
    }
    // provenance 门禁（N19 Phase 1b 设计 1.2 / AB-02 canonical）：official 领域知识必须带有效
    // meta.provenance（唯一 canonical 位置）；顶层平铺六字段不再接受；draft/archived 不强制。
    const status = entry.status ?? "official";
    // N29/P0-4：official 领域知识直写门禁（先于 provenance 判定——无授权者连门都进不来）。
    // 注意：这里不看调用者角色，只看是否出示内部 authority → platform-admin service 同样被拒。
    if (requiresKnowledgeOfficialAuthority(entry.kind, status) && !opts?.knowledgeOfficialAuthority) {
      denyKnowledgeOfficialWrite(entry.kind, "write");
    }
    if (status === "official" && PROVENANCE_REQUIRED_KINDS.has(entry.kind)) {
      const checked = validateKnowledgeProvenance(entry.meta?.provenance, entry.content);
      if (!checked.ok) {
        throw new Error(`memory.write: provenance invalid for official ${entry.kind}: ${checked.error}`);
      }
    }

    const tenantId = this.resolveEntryTenant(entry);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // 行锁（复合 PK=(tenant_id, id)——同 id 跨 tenant 可并存）——旧行用于记录 append-only 历史。
      const oldRows = await client.query(
        `SELECT id, tenant_id, content, status, anchors, meta, version FROM memory_entries WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [entry.id, tenantId],
      );
      const old = oldRows.rows[0] as
        | { id: string; tenant_id: string; content: string; status: string; anchors: string[]; meta: Record<string, unknown>; version: number }
        | undefined;
      if (old) {
        // 统一变更判据（P0-1）：content 不同 OR status 不同 OR effective meta 不同（剥离 updatedAt）。
        // 这里「是否写 history」与下方 UPSERT 的「是否 version+1」使用完全相同的物化判据——
        // 写了 history 就必然 version+1 且 meta.version = old.version + 1。
        const isIdempotent = isSameMaterializedState(old, entry);
        if (!isIdempotent) {
          await client.query(
            `INSERT INTO memory_revisions
               (entry_id, tenant_id, revision, content, status, anchors, meta, created_by, reason)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)`,
            [
              old.id,
              old.tenant_id,
              old.version,
              old.content,
              old.status,
              JSON.stringify(old.anchors ?? []),
              JSON.stringify(old.meta ?? {}),
              opts?.createdBy ?? null,
              opts?.reason ?? null,
            ],
          );
        }
      }

      // ON CONFLICT 分支（P0-1 修复）：
      // - 幂等判定与上方写历史判据完全一致：content 同 AND status 同 AND effective meta 同
      //   （剥离 updatedAt 后 jsonb 等值比较，version 参与比较但由本方法重写）；
      // - meta 合并：memory_entries.meta || EXCLUDED.meta（调用方 meta 整条写回），
      //   最后强制 version/updatedAt 与列联动（FS：meta={...existing.meta, ...entry.meta, version: next, updatedAt: now}）；
      // - version 列与 meta.version 引用同一 CASE 表达式（SET 中均引用旧行值）→ 二者保持一致。
      await client.query(
        `INSERT INTO memory_entries (id, tenant_id, kind, anchors, content, rule_ref, idempotency_key, status, promoted_from, meta)
         VALUES ($1, $10, $2, $3::jsonb, $4, $5, $6, $7, $8, $9::jsonb)
         ON CONFLICT (tenant_id, id) DO UPDATE SET
           content = EXCLUDED.content,
           anchors = EXCLUDED.anchors,
           status = EXCLUDED.status,
           version = CASE
             WHEN memory_entries.content = EXCLUDED.content
              AND memory_entries.status = EXCLUDED.status
              AND (memory_entries.meta - 'updatedAt') = (EXCLUDED.meta - 'updatedAt') THEN memory_entries.version
             ELSE memory_entries.version + 1
           END,
           updated_at = now(),
           meta = memory_entries.meta || EXCLUDED.meta || jsonb_build_object(
             'version', CASE
               WHEN memory_entries.content = EXCLUDED.content
                AND memory_entries.status = EXCLUDED.status
                AND (memory_entries.meta - 'updatedAt') = (EXCLUDED.meta - 'updatedAt') THEN memory_entries.version
               ELSE memory_entries.version + 1
             END,
             'updatedAt', extract(epoch from now()) * 1000
           )
         RETURNING id`,
        [
          entry.id,
          entry.kind,
          JSON.stringify(entry.anchors),
          entry.content,
          entry.ruleRef ?? null,
          entry.idempotencyKey ?? null,
          entry.status ?? "official",
          entry.promotedFrom ?? null,
          JSON.stringify(entry.meta ?? {}),
          tenantId,
        ],
      );
      await client.query("COMMIT");
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // 保留原始异常——rollback 失败不掩盖主错误
      }
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * promotion CAS 原语（P0-1）：单事务完成
   * BEGIN → SELECT … FOR UPDATE → 校验 status='draft' 且 version === expectedRevision →
   * evaluate（锁内行）→ 写 memory_revisions（旧 revision）→ UPDATE memory_entries 为 official、
   * version+1、meta 合并 meta.promotion → enqueueOutbox hook（可选）→ COMMIT。
   * 不满足 CAS 时抛 PromotionConflictError（不静默返回）。
   *
   * N29/P0-4：本方法是 official 知识的**唯一**晋升入口（promotion-only 窄 PG 方法）——
   * 只接受 draft→official 且必须通过 evaluate/evaluateAsync 门禁；普通 write/update
   * （含 platform-admin service）无法产出 official 领域知识。
   */
  async promoteOfficial(
    id: string,
    tenantId: string,
    expectedRevision: number,
    promotionMeta: PgMemoryStorePromotionMeta,
    opts: PgMemoryStorePromoteOfficialOptions = {},
  ): Promise<{ ok: true; id: string }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const oldRows = await client.query(
        `SELECT * FROM memory_entries WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [id, tenantId],
      );
      const oldRow = oldRows.rows[0] as any;
      if (!oldRow) {
        throw new PromotionConflictError(`entry not found in tenant ${tenantId}`);
      }

      const currentVersion = Number(oldRow.version);

      // 幂等重放：已 official 且 meta.promotion.promotedBy === promoterRole → 直接 ok（不重复写）。
      if (oldRow.status === "official") {
        const promotion = (oldRow.meta ?? {})["promotion"] as { promotedBy?: unknown } | undefined;
        if (promotion && promotion.promotedBy === promotionMeta.promotedBy) {
          await client.query("COMMIT");
          return { ok: true, id };
        }
        throw new PromotionConflictError(`entry is already official but not promoted by ${promotionMeta.promotedBy}`);
      }
      if (oldRow.status !== "draft") {
        throw new PromotionConflictError("only draft knowledge can be promoted");
      }

      // CAS：调用方读到的 candidate revision 必须与锁内当前 version 严格相等。
      if (currentVersion !== expectedRevision) {
        throw new PromotionConflictError(`expectedRevision ${expectedRevision} does not match current version ${currentVersion}`);
      }

      if (opts.evaluateAsync) {
        const decision = await opts.evaluateAsync(mapEntry(oldRow), client);
        if (!decision.ok) {
          throw new PromotionConflictError(decision.reason);
        }
      } else if (opts.evaluate) {
        const decision = opts.evaluate(mapEntry(oldRow));
        if (!decision.ok) {
          throw new PromotionConflictError(decision.reason);
        }
      }

      // 写不可变决定（旧 revision = 晋升前 draft 状态）。
      await client.query(
        `INSERT INTO memory_revisions
           (entry_id, tenant_id, revision, content, status, anchors, meta, created_by, reason)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)`,
        [
          id,
          tenantId,
          currentVersion,
          oldRow.content,
          oldRow.status,
          JSON.stringify(oldRow.anchors ?? []),
          JSON.stringify(oldRow.meta ?? {}),
          opts.createdBy ?? null,
          opts.reason ?? null,
        ],
      );

      const nextVersion = currentVersion + 1;
      const metaWithPromotion = {
        promotion: {
          ...promotionMeta,
          verdicts: (oldRow.meta ?? {})["verdicts"] ?? [],
        },
      };
      await client.query(
        `UPDATE memory_entries SET
           status = 'official',
           version = $3::integer,
           updated_at = now(),
           meta = memory_entries.meta || $4::jsonb || jsonb_build_object(
             'version', $3::integer,
             'updatedAt', extract(epoch from now()) * 1000
           )
         WHERE id = $1 AND tenant_id = $2
         RETURNING id`,
        [id, tenantId, nextVersion, JSON.stringify(metaWithPromotion)],
      );

      if (opts.enqueueOutbox) {
        await opts.enqueueOutbox(client);
      }

      await client.query("COMMIT");
      return { ok: true, id };
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // 保留原始异常——rollback 失败不掩盖主错误
      }
      throw e;
    } finally {
      client.release();
    }
  }

  async get(id: string, opts?: { tenantId?: string }): Promise<MemoryEntry | undefined> {
    const tenantId = this.resolveTenantOpts(opts);
    const res = await this.pool.query(
      `SELECT * FROM memory_entries WHERE id = $1 AND tenant_id = $2`, [id, tenantId],
    );
    if (res.rows.length === 0) return undefined;
    return mapEntry(res.rows[0]);
  }

  /** 版本递增 CAS：id 不存在 → throw（编程错误，不静默，对齐 FS update 语义）。
   *  B4 Phase 3：skill:* 条目写后冻结——update 必须显式 force（仅 memory-keeper 维护面/系统通道）。 */
  /**
   * H6：update meta 合并的 store 层纵深——受保护字段不可经 patch 覆盖。
   * spaceScope/visibility（空间可见性）与 version/updatedAt/hitCount/notWriteBack（系统账本）
   * 只能由 write 盖章或系统路径演化；调用方想携带现有 meta 整包重传时，这些键会被剥掉，
   * 从而始终保留数据库中的权威值。
   */
  static sanitizeMetaPatch(meta: Record<string, unknown>): Record<string, unknown> {
    const out = { ...meta };
    for (const key of ["spaceScope", "visibility", "version", "updatedAt", "hitCount", "notWriteBack"]) {
      delete out[key];
    }
    return out;
  }

  async update(id: string, patch: Partial<MemoryEntry> & { meta?: Record<string, unknown> }, opts: PgMemoryStoreUpdateOptions = {}): Promise<void> {
    if (id.startsWith("skill:") && !opts.force) {
      throw new Error(`memory.update: skill 条目不可变（${id}）——修订请走 skills.maintain.archive + 新条目`);
    }
    const tenantId = this.resolveTenantOpts(opts);
    // meta 合并更新（2026-08-13 deopt 回滚需要——原实现 meta 只建初始 version）；
    // H6：受保护字段先剥除（spaceScope/visibility/系统账本键不可经 update 覆盖）
    const metaPatch = patch.meta ? PgMemoryStore.sanitizeMetaPatch(patch.meta) : undefined;

    // F1 6.3：update 也记 append-only revision。单 client 事务：
    // SELECT … WHERE id AND tenant_id FOR UPDATE → 旧行写 memory_revisions → UPDATE → COMMIT；
    // 幂等 no-op（patch 与旧值全同）不写历史。tenant fail-closed 语义不变。
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const oldRows = await client.query(
        `SELECT id, tenant_id, kind, content, status, anchors, meta, version
         FROM memory_entries
         WHERE id = $1 AND tenant_id = $2
         FOR UPDATE`,
        [id, tenantId],
      );
      const old = oldRows.rows[0] as
        | { id: string; tenant_id: string; content: string; status: string; anchors: string[]; meta: Record<string, unknown>; version: number }
        | undefined;
      if (!old) {
        throw new Error(`entry not found in tenant ${tenantId}`);
      }
      // N29/P0-4：draft → official 的状态流转不能经普通 update 完成（否则 write 门禁形同虚设）；
      // 目标 kind 从锁内旧行读取（调用方不能靠不传 kind 绕过）。
      // 注意：update 的 `status === undefined` 表示"不改状态"——只有显式 official 才受门禁约束。
      const existingKind = (oldRows.rows[0] as { kind?: string }).kind ?? patch.kind ?? "";
      if (patch.status === "official" && PROVENANCE_REQUIRED_KINDS.has(existingKind) && !opts.knowledgeOfficialAuthority) {
        denyKnowledgeOfficialWrite(existingKind, "update");
      }

      const stripSystemMeta = (m: Record<string, unknown> | undefined): string => {
        const copy: Record<string, unknown> = { ...(m ?? {}) };
        for (const key of ["spaceScope", "visibility", "version", "updatedAt", "hitCount", "notWriteBack"]) {
          delete copy[key];
        }
        return JSON.stringify(copy, Object.keys(copy).sort());
      };
      const contentChanged = patch.content !== undefined && patch.content !== old.content;
      const statusChanged = patch.status !== undefined && patch.status !== old.status;
      const metaChanged = metaPatch !== undefined && stripSystemMeta(old.meta) !== stripSystemMeta(metaPatch);
      // 统一判据：没有任何物化变化（含空 patch）→ no-op，不写历史也不递增 version。
      const isNoOp = !contentChanged && !statusChanged && !metaChanged;

      if (!isNoOp) {
        await client.query(
          `INSERT INTO memory_revisions
             (entry_id, tenant_id, revision, content, status, anchors, meta, created_by, reason)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)`,
          [
            old.id,
            old.tenant_id,
            old.version,
            old.content,
            old.status,
            JSON.stringify(old.anchors ?? []),
            JSON.stringify(old.meta ?? {}),
            opts.createdBy ?? null,
            opts.reason ?? "update",
          ],
        );

        const metaExpr = metaPatch
          ? `meta || $4::jsonb || jsonb_build_object('version', version + 1, 'updatedAt', extract(epoch from now()) * 1000)`
          : `meta || jsonb_build_object('version', version + 1, 'updatedAt', extract(epoch from now()) * 1000)`;
        const params: unknown[] = [id, patch.content ?? null, patch.status ?? null];
        if (metaPatch) params.push(JSON.stringify(metaPatch));
        const tenantParam = params.length + 1;
        params.push(tenantId);
        const res = await client.query(
          `UPDATE memory_entries SET
             content = COALESCE($2, content),
             status = COALESCE($3, status),
             version = version + 1,
             updated_at = now(),
             meta = ${metaExpr}
           WHERE id = $1 AND tenant_id = $${tenantParam}
           RETURNING id`,
          params,
        );
        if (res.rows.length === 0) throw new Error(`entry not found in tenant ${tenantId}`);
      }

      await client.query("COMMIT");
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // 保留原始异常——rollback 失败不掩盖主错误
      }
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * 检索。锚点 = GIN 索引 + `?|`（jsonb 任一包含，多锚点并集，对齐 FS 索引语义）；
   * kinds/status 过滤（ANY(text[])）；excludeDrafts 排除 status='draft'。
   * 返回按 id 字典序稳定排序。
   */
  async retrieve(opts: { anchors?: string[]; kinds?: string[]; status?: string[]; excludeDrafts?: boolean; tenantId?: string } = {}): Promise<MemoryEntry[]> {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (opts.anchors && opts.anchors.length > 0) {
      params.push(opts.anchors);
      conds.push(`anchors ?| $${params.length}::text[]`); // JSONB 数组任一包含（pg16 已验证）
    }
    if (opts.kinds && opts.kinds.length > 0) {
      params.push(opts.kinds);
      conds.push(`kind = ANY($${params.length}::text[])`);
    }
    if (opts.status && opts.status.length > 0) {
      params.push(opts.status);
      conds.push(`status = ANY($${params.length}::text[])`);
    }
    if (opts.excludeDrafts) conds.push(`status != 'draft'`);
    // K1a tenant 隔离：缺省 default tenant；status 默认语义保持不变（official-only 由 broker 表达）
    params.push(this.resolveTenantOpts(opts));
    conds.push(`tenant_id = $${params.length}`);
    const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
    const res = await this.pool.query(`SELECT * FROM memory_entries ${where} ORDER BY id`, params);
    return res.rows.map(mapEntry);
  }

  /** 旁路计数器（独立列 UPDATE）：不触发版本化、不参与 CAS（对齐 FS 独立计数器文件语义）。 */
  async bumpHitCount(id: string, opts?: { tenantId?: string }): Promise<void> {
    const tenantId = this.resolveTenantOpts(opts);
    await this.pool.query(
      `UPDATE memory_entries SET hit_count = hit_count + 1 WHERE id = $1 AND tenant_id = $2`, [id, tenantId],
    );
  }

  /** 原子增量聚合（2026-08-12 审批面 B：scorecard 聚合快照——单条 SQL upsert——
   *  jsonb 数值增量避免读-改-写竞态（同角色并发任务 lost update）。 */
  async incrementAggregate(
    id: string,
    kind: string,
    anchors: unknown[],
    deltas: Record<string, number>,
    meta: Record<string, unknown>,
    opts?: { tenantId?: string; knowledgeOfficialAuthority?: KnowledgeOfficialAuthority },
  ): Promise<void> {
    const keys = Object.keys(deltas);
    if (keys.length === 0) return;
    // N29/P0-4：聚合 upsert 硬编码 status='official'——不得成为 official 领域知识的伪造入口。
    if (requiresKnowledgeOfficialAuthority(kind, "official") && !opts?.knowledgeOfficialAuthority) {
      denyKnowledgeOfficialWrite(kind, "incrementAggregate");
    }
    // 键名校验（2026-08-12 审计 CRITICAL-1 修复）：键直接拼入 SQL（jsonb_build_object 键位）——
    // 非法键（引号/分号/括号）可注入——白名单 [a-zA-Z0-9_]
    for (const k of keys) {
      if (!/^[a-zA-Z0-9_]{1,64}$/.test(k)) throw new Error(`incrementAggregate: 非法增量键 "${k}"（仅字母数字下划线 ≤64）`);
    }
    const tenantId = this.resolveTenantOpts(opts);
    // 两套表达式：INSERT（新行——纯增量值）；UPDATE（现值 + 增量——jsonb || 合并）。
    // ⚠ VALUES 分支不能引用 content 列（新行无列值——2026-08-12 实机修复：INSERT 用纯参数）
    // ⚠ 显式 ::numeric——jsonb_build_object 的 value 参数是 any——pg 无法推断参数类型
    // （2026-08-12 实机复现："could not determine data type of parameter $3"——psql 字面量验证掩盖）
    // ⚠ 占位符从 $5 起（$1=id/$2=kind/$3=anchors/$4=meta——deltas 参数在数组尾部）——
    // 2026-08-12 实机复现 "inconsistent types deduced for parameter $1"（$1 同时是 id 和增量——类型冲突）
    // K1a：tenant_id 参数化后置于 deltas 尾部（$5+keys.length），DO UPDATE 加 tenant 条件防串写。
    const insertParts = keys.map((k, i) => `'${k}', $${i + 5}::numeric`);
    // ⚠ 表名限定（memory_entries.content）——SET 目标列与 RHS 同名列歧义（2026-08-12 实机修复）
    const updateParts = keys.map((k, i) => `'${k}', COALESCE((memory_entries.content::jsonb->>'${k}')::numeric, 0) + $${i + 5}::numeric`);
    const tenantParam = keys.length + 5;
    await this.pool.query(
      `INSERT INTO memory_entries (id, tenant_id, kind, status, content, anchors, meta, created_at, updated_at)
       VALUES ($1, $${tenantParam}, $2, 'official', jsonb_build_object(${insertParts.join(", ")})::text, $3::jsonb, $4::jsonb, now(), now())
       ON CONFLICT (tenant_id, id) DO UPDATE SET
         content = (memory_entries.content::jsonb || jsonb_build_object(${updateParts.join(", ")}))::text,
         updated_at = now()
       WHERE memory_entries.tenant_id = EXCLUDED.tenant_id`,
      [id, kind, JSON.stringify(anchors ?? []), JSON.stringify(meta ?? {}), ...keys.map((k) => deltas[k]), tenantId],
    );
  }

  /** append-only 历史（旧→新按 revision 升序）。tenant 缺省 default。 */
  async revisionHistory(entryId: string, opts?: { tenantId?: string }): Promise<MemoryRevision[]> {
    const tenantId = this.resolveTenantOpts(opts);
    const res = await this.pool.query(
      `SELECT entry_id, tenant_id, revision, content, status, anchors, meta, created_at, created_by, reason
       FROM memory_revisions
       WHERE entry_id = $1 AND tenant_id = $2
       ORDER BY revision ASC`,
      [entryId, tenantId],
    );
    return res.rows.map(mapRevision);
  }

  /** 恢复历史 revision：用目标历史内容构造 MemoryEntry → write(force)（恢复前自动记当前版本历史）。 */
  async restoreRevision(
    entryId: string,
    revision: number,
    opts?: { tenantId?: string; createdBy?: string; knowledgeOfficialAuthority?: KnowledgeOfficialAuthority },
  ): Promise<void> {
    const tenantId = this.resolveTenantOpts(opts);
    const history = await this.revisionHistory(entryId, { tenantId });
    const target = history.find((r) => r.revision === revision);
    if (!target) {
      throw new Error(`revision ${revision} not found for entry ${entryId} in tenant ${tenantId}`);
    }
    const current = await this.get(entryId, { tenantId });
    if (!current) {
      throw new Error(`entry not found in tenant ${tenantId}`);
    }
    await this.write({
      id: entryId,
      tenantId,
      kind: current.kind,
      anchors: target.anchors,
      content: target.content,
      ruleRef: current.ruleRef,
      idempotencyKey: current.idempotencyKey,
      status: target.status,
      ttlExpiresAt: current.ttlExpiresAt,
      promotedFrom: current.promotedFrom,
      meta: {
        ...(target.meta ?? {}),
        restoredFromRevision: revision,
        restoredAt: Date.now(),
      },
    }, {
      force: true,
      createdBy: opts?.createdBy,
      reason: "restore",
      // N29/P0-4：恢复一条历史 official 领域知识同样需要内部 authority（缺省 fail closed）。
      ...(opts?.knowledgeOfficialAuthority ? { knowledgeOfficialAuthority: opts.knowledgeOfficialAuthority } : {}),
    });
  }

  async listIds(opts?: { tenantId?: string }): Promise<string[]> {
    const tenantId = this.resolveTenantOpts(opts);
    const res = await this.pool.query(`SELECT id FROM memory_entries WHERE tenant_id = $1`, [tenantId]);
    return (res.rows as Array<{ id: string }>).map((r) => r.id);
  }
}

/**
 * F2（AB-01）：把 requireTenant=true 的 PgMemoryStore 绑定到显式 tenant 的窄包装。
 * 供 governance 函数（skills/tool-reg/wiki/memory-admin）等只接收 store 形参的调用点复用——
 * 这些函数内部调 store.get/listIds/write/update 时不带 tenant opts，包装器统一补齐
 * （write 补 entry.tenantId，其余补 opts.tenantId）。
 *
 * N29/P0-4：本包装器是 worker/service 面的 capability facade——**剥离**
 * `knowledgeOfficialAuthority`。official 领域知识只能由内部路径（promoteOfficial 的窄 CAS，
 * 或 seed/migration 直接持有 raw store）写入，经 capability facade 一律拿不到该 authority。
 */
export function withMemoryTenant(store: PgMemoryStore, tenantId: string): PgMemoryStore {
  /** 去掉内部 authority（capability 面不得携带）。 */
  const stripAuthority = <T extends object>(opts?: T): T | undefined => {
    if (!opts) return opts;
    const rest = { ...(opts as Record<string, unknown>) };
    delete rest.knowledgeOfficialAuthority;
    return rest as T;
  };
  const wrapped = {
    write: (entry: MemoryEntry, opts?: PgMemoryStoreWriteOptions) =>
      store.write({ ...entry, tenantId }, stripAuthority(opts)),
    get: (id: string, opts?: { tenantId?: string }) => store.get(id, { ...opts, tenantId }),
    update: (id: string, patch: Partial<MemoryEntry> & { meta?: Record<string, unknown> }, opts: PgMemoryStoreUpdateOptions = {}) =>
      store.update(id, patch, { ...(stripAuthority(opts) ?? {}), tenantId }),
    retrieve: (opts: { anchors?: string[]; kinds?: string[]; status?: string[]; excludeDrafts?: boolean; tenantId?: string } = {}) =>
      store.retrieve({ ...opts, tenantId }),
    listIds: (opts?: { tenantId?: string }) => store.listIds({ ...opts, tenantId }),
    bumpHitCount: (id: string, opts?: { tenantId?: string }) => store.bumpHitCount(id, { ...opts, tenantId }),
    incrementAggregate: (
      id: string,
      kind: string,
      anchors: unknown[],
      deltas: Record<string, number>,
      meta: Record<string, unknown>,
      opts?: { tenantId?: string },
    ) => store.incrementAggregate(id, kind, anchors, deltas, meta, { ...stripAuthority(opts), tenantId }),
    revisionHistory: (entryId: string, opts?: { tenantId?: string }) => store.revisionHistory(entryId, { ...opts, tenantId }),
    restoreRevision: (entryId: string, revision: number, opts?: { tenantId?: string; createdBy?: string }) =>
      store.restoreRevision(entryId, revision, { ...stripAuthority(opts), tenantId }),
    promoteOfficial: (
      id: string,
      _tenantId: string,
      expectedRevision: number,
      promotionMeta: PgMemoryStorePromotionMeta,
      opts?: PgMemoryStorePromoteOfficialOptions,
    ) => store.promoteOfficial(id, tenantId, expectedRevision, promotionMeta, opts),
  };
  return wrapped as unknown as PgMemoryStore;
}

/** 列 → MemoryRevision。 */
function mapRevision(row: any): MemoryRevision {
  return {
    entryId: row.entry_id,
    tenantId: row.tenant_id ?? DEFAULT_TENANT_ID,
    revision: row.revision,
    content: row.content,
    status: row.status,
    anchors: row.anchors ?? [],
    meta: row.meta ?? {},
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at ?? ""),
    createdBy: row.created_by ?? undefined,
    reason: row.reason ?? undefined,
  };
}

/** 列 → MemoryEntry：hit_count/version/not_write_back 从独立列并入 meta（保持接口兼容）。 */
function mapEntry(row: any): MemoryEntry {
  return {
    id: row.id,
    tenantId: row.tenant_id ?? undefined,
    kind: row.kind,
    anchors: row.anchors,
    content: row.content,
    ruleRef: row.rule_ref ?? undefined,
    idempotencyKey: row.idempotency_key ?? undefined,
    status: row.status,
    ttlExpiresAt: row.ttl_expires_at !== null && row.ttl_expires_at !== undefined ? new Date(row.ttl_expires_at).getTime() : undefined,
    promotedFrom: row.promoted_from ?? undefined,
    meta: { ...(row.meta ?? {}), version: row.version, hitCount: row.hit_count, notWriteBack: row.not_write_back },
  };
}

/** 系统文档保护名单（静态上下文——Prompt 框架化：角色文档/能力索引/自修改指南） */
export function isSystemDocId(id: string): boolean {
  return id === "capability-index" || id === "self-modify-guide" || id.startsWith("role-doc:")
    || id === "skill:api-investigation" || id === "pth-worker-system" || id === "project-map"
    || id === "extension-index" || id.startsWith("skill:")   // 2026-08-12 审计：补齐 PROMPT_KINDS 对齐（extension-index 缺失 + skill: 前缀）
    || id.startsWith("refine-task:");   // refine 任务清单（解硬编码——worker 不可改 refine 行为——管理面 force 演化）
}
