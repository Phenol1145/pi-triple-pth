import type pg from "pg";

/**
 * MemoryEntry —— 对齐 memory v1 entry.ts 结构（extensions/agent-lab/src/memory/entry.ts）。
 * 列映射：ruleRef→rule_ref、idempotencyKey→idempotency_key、promotedFrom→promoted_from、
 * ttlExpiresAt→ttl_expires_at（epoch ms）、meta 内嵌 version/hitCount/notWriteBack（从独立列并入）。
 */
export interface MemoryEntry {
  id: string;
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
  constructor(private pool: pg.Pool) {}

  /** upsert：id 冲突则版本递增（CAS 语义，对齐 FS 实现）。anchors 必须显式传非空数组（schema CHECK 约束）。 */
  async write(entry: MemoryEntry): Promise<void> {
    // ON CONFLICT 分支（对齐 FS write 路径②③）：
    // - 幂等判定：content 与调用方声明版本均相同 → 重落库不递增版本（FS 路径②：entry.meta.version ===
    //   existing.meta.version && entry.content === existing.content → persist 不递增）；
    // - meta 合并：memory_entries.meta || EXCLUDED.meta（调用方 meta 整条写回，FS 路径②③ persist(entry) 语义），
    //   最后强制 version/updatedAt 与列联动（FS：meta={...existing.meta, ...entry.meta, version: next, updatedAt: now}）；
    // - version 列与 meta.version 引用同一 CASE 表达式（SET 中均引用旧行值）→ 二者保持一致。
    await this.pool.query(
      `INSERT INTO memory_entries (id, kind, anchors, content, rule_ref, idempotency_key, status, promoted_from, meta)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9::jsonb)
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
      ],
    );
  }

  async get(id: string): Promise<MemoryEntry | undefined> {
    const res = await this.pool.query(
      `SELECT * FROM memory_entries WHERE id = $1`, [id],
    );
    if (res.rows.length === 0) return undefined;
    return mapEntry(res.rows[0]);
  }

  /** 版本递增 CAS：id 不存在 → throw（编程错误，不静默，对齐 FS update 语义）。 */
  async update(id: string, patch: Partial<MemoryEntry>): Promise<void> {
    const res = await this.pool.query(
      `UPDATE memory_entries SET
         content = COALESCE($2, content),
         status = COALESCE($3, status),
         version = version + 1,
         updated_at = now(),
         meta = meta || jsonb_build_object('version', version + 1, 'updatedAt', extract(epoch from now()) * 1000)
       WHERE id = $1
       RETURNING id`,
      [id, patch.content ?? null, patch.status ?? null],
    );
    if (res.rows.length === 0) throw new Error(`entry not found: ${id}`);
  }

  /**
   * 检索。锚点 = GIN 索引 + `?|`（jsonb 任一包含，多锚点并集，对齐 FS 索引语义）；
   * kinds/status 过滤（ANY(text[])）；excludeDrafts 排除 status='draft'。
   * 返回按 id 字典序稳定排序。
   */
  async retrieve(opts: { anchors?: string[]; kinds?: string[]; status?: string[]; excludeDrafts?: boolean } = {}): Promise<MemoryEntry[]> {
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
    const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
    const res = await this.pool.query(`SELECT * FROM memory_entries ${where} ORDER BY id`, params);
    return res.rows.map(mapEntry);
  }

  /** 旁路计数器（独立列 UPDATE）：不触发版本化、不参与 CAS（对齐 FS 独立计数器文件语义）。 */
  async bumpHitCount(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE memory_entries SET hit_count = hit_count + 1 WHERE id = $1`, [id],
    );
  }

  async listIds(): Promise<string[]> {
    const res = await this.pool.query(`SELECT id FROM memory_entries`);
    return (res.rows as Array<{ id: string }>).map((r) => r.id);
  }
}

/** 列 → MemoryEntry：hit_count/version/not_write_back 从独立列并入 meta（保持接口兼容）。 */
function mapEntry(row: any): MemoryEntry {
  return {
    id: row.id,
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
