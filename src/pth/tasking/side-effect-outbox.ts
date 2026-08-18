/**
 * tasking/side-effect-outbox.ts — durable side-effect outbox（F5 / R4）。
 *
 * R4/P0-5：原子 claim——pending→processing 携带 processing_token/owner/lease；
 * complete/markFailed 必须匹配 token+processing（CAS）；lease 过期可回收；
 * available_at 控制 backoff；attempts≥maxAttempts 置 dead-letter 留审计。
 */

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
}

export interface SideEffectMarkFailedInput {
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

export interface SideEffectOutboxPort {
  enqueue(input: SideEffectEnqueueInput): Promise<void>;
  claimPending(limit: number, opts?: SideEffectClaimOptions): Promise<SideEffectRow[]>;
  complete(key: string, token: string): Promise<boolean>;
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

export class PgSideEffectOutbox implements SideEffectOutboxPort {
  constructor(private pool: pg.Pool) {}

  /** 幂等入队：key 冲突 DO NOTHING（首写生效）。 */
  async enqueue(input: SideEffectEnqueueInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO side_effect_outbox (key, tenant_id, kind, payload)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (key) DO NOTHING`,
      [input.key, input.tenantId, input.kind, JSON.stringify(input.payload ?? {})],
    );
  }

  /**
   * 原子领取：单条 CTE 完成 pending→processing（或过期 processing 回收），
   * 生成唯一 processing_token + owner + lease；行锁随语句事务释放后，状态已落库。
   */
  async claimPending(limit: number, opts: SideEffectClaimOptions = {}): Promise<SideEffectRow[]> {
    const owner = opts.owner ?? "default";
    const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
    const res = await this.pool.query(
      `WITH picked AS (
         SELECT id
         FROM side_effect_outbox
         WHERE (status = 'pending' AND available_at <= now())
            OR (status = 'processing' AND locked_until < now())
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
       RETURNING o.id, o.key, o.tenant_id, o.kind, o.payload, o.status, o.attempts,
                 o.processing_token, o.locked_until, o.available_at, o.last_error,
                 o.owner, o.dead_letter_at, o.created_at, o.done_at`,
      [limit, owner, leaseMs],
    );
    return res.rows.map(mapRow);
  }

  /** complete CAS：只允许当前 processing token 的持有者把行置为 done。 */
  async complete(key: string, token: string): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE side_effect_outbox
       SET status = 'done',
           done_at = now(),
           processing_token = NULL,
           locked_until = NULL
       WHERE key = $1 AND status = 'processing' AND processing_token = $2
       RETURNING id`,
      [key, token],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** markFailed CAS：token 不匹配或非 processing 一律无效；成功则回 pending（backoff）或 dead-letter。 */
  async markFailed(input: SideEffectMarkFailedInput): Promise<boolean> {
    const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const backoffMs = input.backoffMs ?? DEFAULT_BACKOFF_MS;
    const res = await this.pool.query(
      `UPDATE side_effect_outbox
       SET attempts = $3::int,
           last_error = $4::text,
           status = CASE WHEN $3::int >= $5::int THEN 'dead-letter' ELSE 'pending' END,
           dead_letter_at = CASE WHEN $3::int >= $5::int THEN now() ELSE NULL END,
           done_at = NULL,
           processing_token = NULL,
           locked_until = NULL,
           available_at = CASE WHEN $3::int >= $5::int THEN available_at ELSE now() + ($6::int * interval '1 millisecond') END
       WHERE key = $1 AND status = 'processing' AND processing_token = $2
       RETURNING id`,
      [input.key, input.token, input.attempts, input.lastError, maxAttempts, backoffMs],
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
          await outbox.markFailed({
            key: row.key,
            token: row.processingToken ?? "",
            attempts: row.attempts,
            lastError: `no handler for kind=${row.kind}`,
          });
          continue;
        }
        try {
          await handler(row.payload, row);
          await outbox.complete(row.key, row.processingToken ?? "");
        } catch (e) {
          const attempts = row.attempts;
          const lastError = e instanceof Error ? e.message : String(e);
          await outbox.markFailed({ key: row.key, token: row.processingToken ?? "", attempts, lastError });
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
