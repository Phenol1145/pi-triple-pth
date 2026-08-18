/**
 * tasking/side-effect-outbox.ts — durable side-effect outbox（F5 / R4 / N29 L1）。
 *
 * R4/P0-5：原子 claim——pending→processing 携带 processing_token/owner/lease；
 * complete/markFailed 必须匹配 token+processing（CAS）；lease 过期可回收；
 * available_at 控制 backoff；attempts≥maxAttempts 置 dead-letter 留审计。
 *
 * N29/P0-3（§1.5）：幂等身份是 `(tenant_id, key)`，不是全局 `UNIQUE(key)`。
 *  - 同 tenant/key 且 kind + payload + payload_hash 完全一致 = 幂等重放（不新增行）；
 *  - 同 tenant/key 但 kind/payload/hash 不同 = 显式 conflict 抛错，绝不 DO NOTHING 静默丢弃；
 *  - claim/complete/markFailed 一律携带 tenantId，SQL 同时匹配 tenant + key + processing token；
 *  - `enqueueSideEffectInTx(client, input)` 复用调用方事务（task commit / run transition 与
 *    下一阶段 outbox 同一 client），禁止在事务中再调用 pool-backed `enqueue()`。
 */

import { createHash } from "node:crypto";
import type pg from "pg";

export interface SideEffectEnqueueInput {
  key: string;
  tenantId: string;
  kind: string;
  payload: unknown;
}

export interface SideEffectClaimOptions {
  owner?: string;
  leaseMs?: number;
  /** 只领取该 tenant 的行（缺省 = 全 tenant drainer）。 */
  tenantId?: string;
}

/** N29 P0-3：complete 的 CAS 输入——tenant + key + claim 时返回的 processing_token。 */
export interface SideEffectCompleteInput {
  tenantId: string;
  key: string;
  token: string;
}

export interface SideEffectMarkFailedInput {
  /** N29 P0-3：identity 为 (tenant_id, key)——tenant 必填。 */
  tenantId: string;
  key: string;
  /** claim 时返回的 processing_token；空/错 token 一律 CAS 失败。 */
  token: string;
  attempts: number;
  lastError: string;
  maxAttempts?: number;
  backoffMs?: number;
}

export type SideEffectRowStatus = "pending" | "processing" | "done" | "failed" | "dead-letter";

export interface SideEffectRow {
  id: string;
  key: string;
  tenantId: string;
  kind: string;
  payload: unknown;
  /** 稳定 payload hash（sha256(canonical JSON)）；旧行迁移前可能为空串。 */
  payloadHash: string;
  status: SideEffectRowStatus;
  attempts: number;
  processingToken: string | null;
  lockedUntil: Date | null;
  availableAt: Date;
  lastError: string | null;
  owner: string | null;
  deadLetterAt: Date | null;
  createdAt: Date;
  doneAt: Date | null;
}

/** enqueue 结果：inserted=首写落库；replayed=同 tenant/key 的 exact 幂等重放。 */
export interface SideEffectEnqueueResult {
  disposition: "inserted" | "replayed";
  tenantId: string;
  key: string;
  payloadHash: string;
}

/** N29 P0-3：同 tenant/key 不同 kind/payload/hash——显式 conflict（调用方事务应整体回滚）。 */
export class SideEffectOutboxConflictError extends Error {
  readonly code = "SIDE_EFFECT_OUTBOX_CONFLICT";
  constructor(readonly tenantId: string, readonly key: string) {
    super(
      `side-effect outbox conflict: tenant=${tenantId} key=${key} 已存在不同 kind/payload/payload_hash 的行`
      + `（同 tenant/key 只有 exact payload 才算幂等重放）`,
    );
    this.name = "SideEffectOutboxConflictError";
  }
}

export interface SideEffectOutboxPort {
  /**
   * 幂等入队（identity=(tenantId,key)）。exact 重放不新增行；不同 kind/payload/hash 抛
   * `SideEffectOutboxConflictError`。端口层只约定"成功/抛错"；需要 inserted/replayed 语义的
   * 调用方用 `PgSideEffectOutbox.enqueue` 或 `enqueueSideEffectInTx` 的返回值。
   */
  enqueue(input: SideEffectEnqueueInput): Promise<void>;
  claimPending(limit: number, opts?: SideEffectClaimOptions): Promise<SideEffectRow[]>;
  complete(input: SideEffectCompleteInput): Promise<boolean>;
  markFailed(input: SideEffectMarkFailedInput): Promise<boolean>;
}

export interface SideEffectDrainerHandlers {
  [kind: string]: (payload: unknown, row: SideEffectRow) => void | Promise<void>;
}

export interface SideEffectDrainer {
  start(): void;
  stop(): void;
  /** 立即消费一轮（供 task-loop claim 前 kick 与测试使用）。 */
  drainOnce(): Promise<void>;
}

function mapRow(r: any): SideEffectRow {
  return {
    id: String(r.id),
    key: r.key,
    tenantId: r.tenant_id,
    kind: r.kind,
    payload: r.payload,
    payloadHash: r.payload_hash ?? "",
    status: r.status,
    attempts: Number(r.attempts),
    processingToken: r.processing_token ?? null,
    lockedUntil: r.locked_until ?? null,
    availableAt: r.available_at,
    lastError: r.last_error ?? null,
    owner: r.owner ?? null,
    deadLetterAt: r.dead_letter_at ?? null,
    createdAt: r.created_at,
    doneAt: r.done_at ?? null,
  };
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 1000;
const DEFAULT_LEASE_MS = 2 * 60_000;

/** 稳定 JSON 序列化（递归键排序）——与 jsonb 等值语义对齐（jsonb 比较忽略键序）。 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** 稳定 payload hash（N29 P0-3）：sha256(canonical JSON)——键序无关，跨进程一致。 */
export function computeSideEffectPayloadHash(kind: string, payload: unknown): string {
  return createHash("sha256").update(stableStringify({ kind, payload: payload ?? {} })).digest("hex");
}

/** 最小 SQL 执行面（pg.Pool 与 pg.PoolClient 通用）——同一 enqueue 语义可绑定任意事务。 */
interface SqlExecutor {
  query(sql: string, params?: unknown[]): Promise<{ rowCount: number | null; rows: any[] }>;
}

/**
 * N29 P0-3 的唯一 enqueue 实现（pool 与事务共用）。
 *
 * `ON CONFLICT (tenant_id, key) DO UPDATE ... WHERE <exact 匹配>`：
 *  - 首写 → 插入（xmax=0）；
 *  - exact 重放（kind/payload 一致，hash 一致或旧行 hash 为空待回填）→ 命中 DO UPDATE 只回填
 *    payload_hash，status/attempts/token 全部不动 → 返回 replayed；
 *  - 其他（kind/payload/hash 不同）→ DO UPDATE 的 WHERE 不成立 → 零行返回 → 抛 conflict。
 */
async function enqueueSideEffect(
  db: SqlExecutor,
  input: SideEffectEnqueueInput,
): Promise<SideEffectEnqueueResult> {
  const payloadHash = computeSideEffectPayloadHash(input.kind, input.payload);
  const res = await db.query(
    `INSERT INTO side_effect_outbox (key, tenant_id, kind, payload, payload_hash)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     ON CONFLICT (tenant_id, key) DO UPDATE
       SET payload_hash = EXCLUDED.payload_hash
       WHERE side_effect_outbox.kind = EXCLUDED.kind
         AND side_effect_outbox.payload = EXCLUDED.payload
         AND (side_effect_outbox.payload_hash IS NULL
              OR side_effect_outbox.payload_hash = ''
              OR side_effect_outbox.payload_hash = EXCLUDED.payload_hash)
     RETURNING (xmax = 0) AS inserted`,
    [input.key, input.tenantId, input.kind, JSON.stringify(input.payload ?? {}), payloadHash],
  );
  if ((res.rowCount ?? 0) === 0) {
    throw new SideEffectOutboxConflictError(input.tenantId, input.key);
  }
  return {
    disposition: res.rows[0]?.inserted === true ? "inserted" : "replayed",
    tenantId: input.tenantId,
    key: input.key,
    payloadHash,
  };
}

/**
 * 事务绑定 enqueue（N29 P0-3）：接收调用方 `PoolClient`，与 task CAS commit /
 * intake run transition 共用同一事务。CAS 回滚时 outbox 行一并回滚；conflict 抛错让调用方回滚。
 */
export function enqueueSideEffectInTx(
  client: pg.PoolClient,
  input: SideEffectEnqueueInput,
): Promise<SideEffectEnqueueResult> {
  return enqueueSideEffect(client as unknown as SqlExecutor, input);
}

export class PgSideEffectOutbox implements SideEffectOutboxPort {
  constructor(private pool: pg.Pool) {}

  /**
   * 幂等入队：identity=(tenant_id,key)；exact 重放幂等，不同 kind/payload/hash 抛 conflict。
   *
   * 注意（N29 P0-3）：这是 **pool-backed** 入口，只能在事务外使用（如 observer-failure 记录）。
   * task commit / run transition 等必须与状态迁移同事务的场景请用 `enqueueSideEffectInTx(client, …)`，
   * 它同时返回 inserted/replayed disposition。
   */
  async enqueue(input: SideEffectEnqueueInput): Promise<void> {
    await enqueueSideEffect(this.pool as unknown as SqlExecutor, input);
  }

  /**
   * 原子领取：单条 CTE 完成 pending→processing（或过期 processing 回收），
   * 生成唯一 processing_token + owner + lease；行锁随语句事务释放后，状态已落库。
   * opts.tenantId 可把领取收窄到单一 tenant（跨 tenant 行不可见）。
   */
  async claimPending(limit: number, opts: SideEffectClaimOptions = {}): Promise<SideEffectRow[]> {
    const owner = opts.owner ?? "default";
    const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
    const res = await this.pool.query(
      `WITH picked AS (
         SELECT id
         FROM side_effect_outbox
         WHERE ((status = 'pending' AND available_at <= now())
             OR (status = 'processing' AND locked_until < now()))
           AND ($4::text IS NULL OR tenant_id = $4::text)
         ORDER BY id
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE side_effect_outbox o
       SET status = 'processing',
           processing_token = 'tok:' || md5(random()::text || o.id::text || clock_timestamp()::text),
           owner = $2,
           locked_until = now() + ($3::int * interval '1 millisecond'),
           attempts = o.attempts + 1
       FROM picked p
       WHERE o.id = p.id
       RETURNING o.id, o.key, o.tenant_id, o.kind, o.payload, o.payload_hash, o.status, o.attempts,
                 o.processing_token, o.locked_until, o.available_at, o.last_error,
                 o.owner, o.dead_letter_at, o.created_at, o.done_at`,
      [limit, owner, leaseMs, opts.tenantId ?? null],
    );
    return res.rows.map(mapRow);
  }

  /** complete CAS：tenant + key + 当前 processing token 三者同时匹配才可置 done。 */
  async complete(input: SideEffectCompleteInput): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE side_effect_outbox
       SET status = 'done',
           done_at = now(),
           processing_token = NULL,
           locked_until = NULL
       WHERE tenant_id = $1 AND key = $2 AND status = 'processing' AND processing_token = $3
       RETURNING id`,
      [input.tenantId, input.key, input.token],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** markFailed CAS：tenant+key+token 不匹配或非 processing 一律无效；成功则回 pending（backoff）或 dead-letter。 */
  async markFailed(input: SideEffectMarkFailedInput): Promise<boolean> {
    const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const backoffMs = input.backoffMs ?? DEFAULT_BACKOFF_MS;
    const res = await this.pool.query(
      `UPDATE side_effect_outbox
       SET attempts = $4::int,
           last_error = $5::text,
           status = CASE WHEN $4::int >= $6::int THEN 'dead-letter' ELSE 'pending' END,
           dead_letter_at = CASE WHEN $4::int >= $6::int THEN now() ELSE NULL END,
           done_at = NULL,
           processing_token = NULL,
           locked_until = NULL,
           available_at = CASE WHEN $4::int >= $6::int THEN available_at ELSE now() + ($7::int * interval '1 millisecond') END
       WHERE tenant_id = $1 AND key = $2 AND status = 'processing' AND processing_token = $3
       RETURNING id`,
      [input.tenantId, input.key, input.token, input.attempts, input.lastError, maxAttempts, backoffMs],
    );
    return (res.rowCount ?? 0) > 0;
  }
}

/** 每次领取行数（drainer 内部固定批大小）。 */
const DRAIN_BATCH_SIZE = 10;

export function createSideEffectDrainer(opts: {
  outbox: SideEffectOutboxPort;
  handlers: SideEffectDrainerHandlers;
  logger?: (msg: string) => void;
  tickMs?: number;
}): SideEffectDrainer {
  const { outbox, handlers, logger } = opts;
  const tickMs = opts.tickMs ?? 2000;
  let timer: ReturnType<typeof setInterval> | null = null;
  let draining: Promise<void> | null = null;

  async function drainOnce(): Promise<void> {
    // 并发 kick（task-loop 每轮 + timer）共用同一 in-flight drain，防重复领取。
    if (draining) return draining;
    draining = (async () => {
      const rows = await outbox.claimPending(DRAIN_BATCH_SIZE);
      for (const row of rows) {
        const handler = handlers[row.kind];
        if (!handler) {
          logger?.(`side-effect drainer: no handler for kind=${row.kind} key=${row.key}`);
          // N29 P0-3：CAS 输入必须携带行自带的 tenant（不是全局 key）。
          await outbox.markFailed({
            tenantId: row.tenantId,
            key: row.key,
            token: row.processingToken ?? "",
            attempts: row.attempts,
            lastError: `no handler for kind=${row.kind}`,
          });
          continue;
        }
        try {
          await handler(row.payload, row);
          await outbox.complete({ tenantId: row.tenantId, key: row.key, token: row.processingToken ?? "" });
        } catch (e) {
          const attempts = row.attempts;
          const lastError = e instanceof Error ? e.message : String(e);
          await outbox.markFailed({
            tenantId: row.tenantId,
            key: row.key,
            token: row.processingToken ?? "",
            attempts,
            lastError,
          });
          logger?.(`side-effect drainer: handler failed key=${row.key} kind=${row.kind} attempts=${attempts}: ${lastError}`);
        }
      }
    })().finally(() => {
      draining = null;
    });
    return draining;
  }

  function start(): void {
    if (timer) return;
    timer = setInterval(() => {
      void drainOnce().catch((e) => {
        logger?.(`side-effect drainer: poll failed: ${e instanceof Error ? e.message : String(e)}`);
      });
    }, tickMs);
    // unref：drainer 不持有进程生命周期（与 batch keep-alive 语义一致）。
    timer.unref?.();
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { start, stop, drainOnce };
}
