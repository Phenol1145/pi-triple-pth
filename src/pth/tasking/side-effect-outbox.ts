/**
 * tasking/side-effect-outbox.ts — durable side-effect outbox（F5 / 契约 6.1）。
 *
 * post-commit 副作用（refine 等）先以幂等 key 落库，再由 drainer 轮询消费；
 * 进程重启后 pending 行会被重放（attempts < 3 回 pending 重试；≥3 置 failed 留审计）。
 */

import type pg from "pg";

export interface SideEffectEnqueueInput {
  key: string;
  tenantId: string;
  kind: string;
  payload: unknown;
}

export interface SideEffectOutboxPort {
  enqueue(input: SideEffectEnqueueInput): Promise<void>;
  claimPending(limit: number): Promise<SideEffectRow[]>;
  complete(key: string): Promise<void>;
  markFailed(key: string, attempts: number): Promise<void>;
}

export interface SideEffectRow {
  id: string;
  key: string;
  tenantId: string;
  kind: string;
  payload: unknown;
  status: "pending" | "done" | "failed";
  attempts: number;
  createdAt: Date;
  doneAt: Date | null;
}

export interface SideEffectDrainerHandlers {
  [kind: string]: (payload: unknown, row: SideEffectRow) => void | Promise<void>;
}

export interface SideEffectDrainer {
  start(): void;
  stop(): void;
  /** 立即消费一轮 pending（供 task-loop claim 前 kick 与测试使用）。 */
  drainOnce(): Promise<void>;
}

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

  /** 领取 pending 行（按 id 顺序；FOR UPDATE SKIP LOCKED 防并发重复领取）。 */
  async claimPending(limit: number): Promise<SideEffectRow[]> {
    const res = await this.pool.query(
      `SELECT id, key, tenant_id, kind, payload, status, attempts, created_at, done_at
       FROM side_effect_outbox
       WHERE status = 'pending'
       ORDER BY id
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    return res.rows.map((r: any) => ({
      id: String(r.id),
      key: r.key,
      tenantId: r.tenant_id,
      kind: r.kind,
      payload: r.payload,
      status: r.status,
      attempts: Number(r.attempts),
      createdAt: r.created_at,
      doneAt: r.done_at ?? null,
    }));
  }

  async complete(key: string): Promise<void> {
    await this.pool.query(
      `UPDATE side_effect_outbox SET status = 'done', done_at = now() WHERE key = $1`,
      [key],
    );
  }

  /** 记录失败：attempts≥3 置 failed 留审计；否则回 pending 等待下一轮重试。 */
  async markFailed(key: string, attempts: number): Promise<void> {
    await this.pool.query(
      `UPDATE side_effect_outbox
       SET attempts = $2,
           status = CASE WHEN $2 >= 3 THEN 'failed' ELSE 'pending' END,
           done_at = CASE WHEN $2 >= 3 THEN now() ELSE NULL END
       WHERE key = $1`,
      [key, attempts],
    );
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
          await outbox.markFailed(row.key, row.attempts + 1);
          continue;
        }
        try {
          await handler(row.payload, row);
          await outbox.complete(row.key);
        } catch (e) {
          const attempts = row.attempts + 1;
          await outbox.markFailed(row.key, attempts);
          logger?.(`side-effect drainer: handler failed key=${row.key} kind=${row.kind} attempts=${attempts}: ${e instanceof Error ? e.message : String(e)}`);
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
