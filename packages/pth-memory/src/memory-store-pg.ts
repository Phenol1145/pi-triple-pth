import { randomUUID } from "node:crypto";
import type pg from "pg";
import { PROVENANCE_REQUIRED_KINDS, validateKnowledgeProvenance } from "./knowledge-provenance.js";

/** 缺省租户 id（tenant_id 列 DDL 已 default 'default'；本批不迁移存量行）。 */
export const DEFAULT_TENANT_ID = "default";

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
}

/** update opts：force=skill 维护通道；createdBy/reason=update revision 历史记录（F1 6.3）。 */
export interface PgMemoryStoreUpdateOptions {
  force?: boolean;
  tenantId?: string;
  createdBy?: string;
  reason?: string;
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
export class PgMemoryStore {
  private readonly defaultTenantId: string;

  constructor(private pool: pg.Pool, opts?: { defaultTenantId?: string }) {
    this.defaultTenantId = opts?.defaultTenantId ?? DEFAULT_TENANT_ID;
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
    if (status === "official" && PROVENANCE_REQUIRED_KINDS.has(entry.kind)) {
      const checked = validateKnowledgeProvenance(entry.meta?.provenance, entry.content);
      if (!checked.ok) {
        throw new Error(`memory.write: provenance invalid for official ${entry.kind}: ${checked.error}`);
      }
    }

    const tenantId = entry.tenantId ?? this.defaultTenantId;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // 行锁（PK=id；现有语义不因 tenant 改变）——旧行用于记录 append-only 历史。
      const oldRows = await client.query(
        `SELECT id, tenant_id, content, status, anchors, meta, version FROM memory_entries WHERE id = $1 FOR UPDATE`,
        [entry.id],
      );
      const old = oldRows.rows[0] as
        | { id: string; tenant_id: string; content: string; status: string; anchors: string[]; meta: Record<string, unknown>; version: number }
        | undefined;
      if (old) {
        // 幂等判定与 SQL 的 version 不递增分支保持一致，但补 status/meta 对比：
        // content+声明版本相同而 status/meta 变化（如 K4 晋升）也必须记 revision——否则
        // 晋升/回滚只有当前态、无历史。真实试点（K5）发现此处缺口后修正。
        // SQL 会在 meta 里补 updatedAt——比较时剥离该生成字段（否则永远不幂等）。
        const oldDeclaredVersion = old.meta?.version !== undefined ? String(old.meta.version) : undefined;
        const newDeclaredVersion = entry.meta?.version !== undefined ? String(entry.meta.version) : undefined;
        const stripUpdatedAt = (m: Record<string, unknown> | undefined): string => {
          const copy: Record<string, unknown> = { ...(m ?? {}) };
          delete copy["updatedAt"];
          return JSON.stringify(copy);
        };
        const isIdempotent = old.content === entry.content
          && old.status === (entry.status ?? "official")
          && stripUpdatedAt(old.meta) === stripUpdatedAt(entry.meta)
          && oldDeclaredVersion !== undefined
          && newDeclaredVersion !== undefined
          && oldDeclaredVersion === newDeclaredVersion;
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

      // ON CONFLICT 分支（对齐 FS write 路径②③）：
      // - 幂等判定：content 与调用方声明版本均相同 → 重落库不递增版本（FS 路径②：entry.meta.version ===
      //   existing.meta.version && entry.content === existing.content → persist 不递增）；
      // - meta 合并：memory_entries.meta || EXCLUDED.meta（调用方 meta 整条写回，FS 路径②③ persist(entry) 语义），
      //   最后强制 version/updatedAt 与列联动（FS：meta={...existing.meta, ...entry.meta, version: next, updatedAt: now}）；
      // - version 列与 meta.version 引用同一 CASE 表达式（SET 中均引用旧行值）→ 二者保持一致。
      await client.query(
        `INSERT INTO memory_entries (id, tenant_id, kind, anchors, content, rule_ref, idempotency_key, status, promoted_from, meta)
         VALUES ($1, $10, $2, $3::jsonb, $4, $5, $6, $7, $8, $9::jsonb)
         ON CONFLICT (id) DO UPDATE SET
           content = EXCLUDED.content,
           anchors = EXCLUDED.anchors,
           status = EXCLUDED.status,
           version = CASE
             WHEN memory_entries.content = EXCLUDED.content AND memory_entries.meta->>'version' = EXCLUDED.meta->>'version' THEN memory_entries.version
             ELSE memory_entries.version + 1
           END,
           updated_at = now(),
           meta = memory_entries.meta || EXCLUDED.meta || jsonb_build_object(
             'version', CASE
               WHEN memory_entries.content = EXCLUDED.content AND memory_entries.meta->>'version' = EXCLUDED.meta->>'version' THEN memory_entries.version
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

  async get(id: string, opts?: { tenantId?: string }): Promise<MemoryEntry | undefined> {
    const tenantId = opts?.tenantId ?? this.defaultTenantId;
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
    const tenantId = opts.tenantId ?? this.defaultTenantId;
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
        `SELECT id, tenant_id, content, status, anchors, meta, version
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

      const stripSystemMeta = (m: Record<string, unknown> | undefined): string => {
        const copy: Record<string, unknown> = { ...(m ?? {}) };
        for (const key of ["spaceScope", "visibility", "version", "updatedAt", "hitCount", "notWriteBack"]) {
          delete copy[key];
        }
        return JSON.stringify(copy, Object.keys(copy).sort());
      };
      const hasAnyPatch = patch.content !== undefined || patch.status !== undefined || metaPatch !== undefined;
      const contentChanged = patch.content !== undefined && patch.content !== old.content;
      const statusChanged = patch.status !== undefined && patch.status !== old.status;
      const metaChanged = metaPatch !== undefined && stripSystemMeta(old.meta) !== stripSystemMeta(metaPatch);
      const isNoOp = hasAnyPatch && !contentChanged && !statusChanged && !metaChanged;

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
    params.push(opts.tenantId ?? this.defaultTenantId);
    conds.push(`tenant_id = $${params.length}`);
    const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
    const res = await this.pool.query(`SELECT * FROM memory_entries ${where} ORDER BY id`, params);
    return res.rows.map(mapEntry);
  }

  /** 旁路计数器（独立列 UPDATE）：不触发版本化、不参与 CAS（对齐 FS 独立计数器文件语义）。 */
  async bumpHitCount(id: string, opts?: { tenantId?: string }): Promise<void> {
    const tenantId = opts?.tenantId ?? this.defaultTenantId;
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
    opts?: { tenantId?: string },
  ): Promise<void> {
    const keys = Object.keys(deltas);
    if (keys.length === 0) return;
    // 键名校验（2026-08-12 审计 CRITICAL-1 修复）：键直接拼入 SQL（jsonb_build_object 键位）——
    // 非法键（引号/分号/括号）可注入——白名单 [a-zA-Z0-9_]
    for (const k of keys) {
      if (!/^[a-zA-Z0-9_]{1,64}$/.test(k)) throw new Error(`incrementAggregate: 非法增量键 "${k}"（仅字母数字下划线 ≤64）`);
    }
    const tenantId = opts?.tenantId ?? this.defaultTenantId;
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
       ON CONFLICT (id) DO UPDATE SET
         content = (memory_entries.content::jsonb || jsonb_build_object(${updateParts.join(", ")}))::text,
         updated_at = now()
       WHERE memory_entries.tenant_id = EXCLUDED.tenant_id`,
      [id, kind, JSON.stringify(anchors ?? []), JSON.stringify(meta ?? {}), ...keys.map((k) => deltas[k]), tenantId],
    );
  }

  /** append-only 历史（旧→新按 revision 升序）。tenant 缺省 default。 */
  async revisionHistory(entryId: string, opts?: { tenantId?: string }): Promise<MemoryRevision[]> {
    const tenantId = opts?.tenantId ?? this.defaultTenantId;
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
  async restoreRevision(entryId: string, revision: number, opts?: { tenantId?: string; createdBy?: string }): Promise<void> {
    const tenantId = opts?.tenantId ?? this.defaultTenantId;
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
    });
  }

  async listIds(opts?: { tenantId?: string }): Promise<string[]> {
    const tenantId = opts?.tenantId ?? this.defaultTenantId;
    const res = await this.pool.query(`SELECT id FROM memory_entries WHERE tenant_id = $1`, [tenantId]);
    return (res.rows as Array<{ id: string }>).map((r) => r.id);
  }
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
