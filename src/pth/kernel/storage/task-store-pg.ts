import { randomUUID } from "node:crypto";
import type pg from "pg";
import { withTx } from "./pg.js";
import { TASK_MAX_CLAIMS } from "../../contracts/tasking.js";
/** 路由策略注入（2026-08-13 审计 P2——存储层不再依赖执行层：
 *  校验/分配由装配层（assembly/batch-process）传入——task-store 只存不判） */
export interface TaskRouting {
  validate(input: { tags?: string[]; payload?: unknown }): { ok: boolean; error?: string };
  assign(input: { id: string; tags?: string[]; payload?: unknown }): string;
}

/** 单任务最大认领次数（防坏任务无限 claim→reject 空转的兜底）——策略常量来自 contracts */
export const MAX_CLAIMS = TASK_MAX_CLAIMS;

export interface Task {
  id: string;
  title: string;
  text: string;
  tags: string[];
  status: string;
  createdBy: string;
  claimed_by: string | null;
  claims_count: number;
  created_at: Date;
  payload: unknown;
  assigned_role?: string | null;
  job_id?: string | null;
  /** P0-3：租户隔离边界——来自 tasks.tenant_id（当前 publish 未显式写入时为 'default'） */
  tenantId?: string;
  /** P1-1：真实 task lease（tasking CAS）——旧行 leaseId NULL + leaseGeneration 0 */
  leaseId?: string | null;
  leaseGeneration?: number;
  leaseExpiresAt?: Date | null;
}

export interface PublishInput {
  title: string;
  text: string;
  createdBy: string;
  tags?: string[];
  payload?: unknown;
  templateId?: string;
  /** 异步 job 委托（v0.8 循环①）：job 关联 id */
  jobId?: string;
  /** P0-3：外部路由从 auth token 派生写入；内部发布者缺省 default */
  tenantId?: string;
}

export interface TaskStore {
  candidates(agentId: string, opts?: { limit?: number }): Promise<Task[]>;
  claimTopN(agentId: string, ids: string[]): Promise<Task[]>;
  /** 返回受影响行数（0 = 认领已不属于该 agent——审计 H5：双执行/结果丢失信号） */
  reject(agentId: string, taskId: string, reason: string, opts?: { terminal?: boolean }): Promise<number>;
  /** 返回受影响行数（0 = 认领已不属于该 agent——审计 H5：任务可能已被回收重领） */
  submit(agentId: string, taskId: string, outputRef: unknown): Promise<number>;
  publish(input: PublishInput): Promise<Task>;
  /** 按 id 取任务（Origin 升级链 retask——重发布需原任务正文） */
  getById(id: string): Promise<Task | null>;
  // 跨 spec 扩展（plan Task 5 标注）：负载统计 collectStats 依赖 pending 队列长度。
  countPending(): Promise<number>;
  /** per-role 队列深度（descheduler——自动强化调度信号） */
  countPendingByRole(): Promise<Record<string, number>>;
  /** claim 超时回收：batch 崩溃/重启时僵尸认领（claimed_at 超时）回滚 pending——清 claimed_by/claimed_at */
  recoverStaleClaims(timeoutMs: number): Promise<number>;
}

export class PgTaskStore implements TaskStore {
  constructor(private pool: pg.Pool, private routing?: TaskRouting) {}

  async publish(input: PublishInput): Promise<Task> {
    // 任务池纯化（2026-08-10 D5）：publish 唯一入口严格校验——未知标签/歧义/无路由依据
    // 一律拒绝（statusCode 400——fastify 映射；内部发布者同样受约束）。
    // 2026-08-13 审计 P2：校验/分配策略由装配层注入（DIP）——本层只存不判。
    if (this.routing) {
      const check = this.routing.validate({ tags: input.tags, payload: input.payload });
      if (!check.ok) {
        const err = new Error(check.error) as Error & { statusCode?: number };
        err.statusCode = 400;
        throw err;
      }
    }
    // 任务分配正交化：应用层生成 id（crypto.randomUUID）→ 路由策略确定性路由
    // （flow 显式 role / tags 精确匹配——校验期已保证有路由依据）——assigned_role 从出生即确定，零抢票。
    const id = randomUUID();
    const assignedRole = this.routing?.assign({ id, tags: input.tags, payload: input.payload }) ?? null;
    const tenantId = typeof input.tenantId === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(input.tenantId) ? input.tenantId : "default";
    const res = await this.pool.query(
      `INSERT INTO tasks (id, tenant_id, title, text, created_by, tags, payload, template_id, assigned_role, job_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [id, tenantId, input.title, input.text, input.createdBy, input.tags ?? [], input.payload ?? {}, input.templateId ?? null, assignedRole, input.jobId ?? null],
    );
    return mapRow(res.rows[0]);
  }

  async getById(id: string): Promise<Task | null> {
    const res = await this.pool.query(`SELECT * FROM tasks WHERE id = $1`, [id]);
    return res.rows.length > 0 ? mapRow(res.rows[0]) : null;
  }

  async candidates(agentId: string, opts?: { limit?: number }): Promise<Task[]> {
    // 任务分配正交化：只查自己队列（assigned_role = 自己）——零竞争零抢票。
    // claims_count < MAX_CLAIMS：坏任务（terminal reject 被绕过）不占队列。
    const res = await this.pool.query(
      `SELECT * FROM tasks
       WHERE status = 'pending'
         AND assigned_role = $1
         AND claims_count < $2
       ORDER BY created_at
       LIMIT $3`,
      [agentId, MAX_CLAIMS, opts?.limit ?? 10],
    );
    return res.rows.map(mapRow);
  }

  async claimTopN(agentId: string, ids: string[]): Promise<Task[]> {
    // 并发原子认领：事务内先 SELECT ... FOR UPDATE SKIP LOCKED 抢占（跳过已被其他事务锁定的行，
    // 不阻塞等待），再 UPDATE 回写。两个并发 claimTopN 抢同一任务时只有一个能锁到行 → 只认领成功一个。
    // 防御：claims_count >= MAX_CLAIMS 不再认领——即使 terminal reject 被绕过，坏任务最多空转 N 次。
    return withTx(this.pool, async (client) => {
      const sel = await client.query(
        `SELECT id FROM tasks
         WHERE id = ANY($1::text[])
           AND status = 'pending'
           AND (claimed_by IS NULL OR claimed_by = $2)
           AND claims_count < $3
         ORDER BY id
         FOR UPDATE SKIP LOCKED`,
        [ids, agentId, MAX_CLAIMS],
      );
      if (sel.rows.length === 0) return [];
      const lockedIds = (sel.rows as Array<{ id: string }>).map((r) => r.id);
      const upd = await client.query(
        `UPDATE tasks SET
           status = 'claimed',
           claimed_by = $1,
           claims_count = claims_count + 1,
           claimed_at = now(),
           updated_at = now()
         WHERE id = ANY($2::text[])
         RETURNING *`,
        [agentId, lockedIds],
      );
      return upd.rows.map(mapRow);
    });
  }

  /** per-role 队列深度（descheduler 信号——自动强化调度） */
  async countPendingByRole(): Promise<Record<string, number>> {
    const res = await this.pool.query(
      `SELECT assigned_role, count(*) AS n FROM tasks
       WHERE status = 'pending' AND claims_count < $1
       GROUP BY assigned_role`,
      [MAX_CLAIMS],
    );
    const out: Record<string, number> = {};
    for (const row of res.rows as Array<{ assigned_role: string | null; n: string }>) {
      if (row.assigned_role) out[row.assigned_role] = Number(row.n);
    }
    return out;
  }

  async countPending(): Promise<number> {
    // count(*) 返回 int8 → node-postgres 解析为字符串，必须 Number() 转换（见 Task 1 ledger minor）。
    // 排除冻结坏任务（claims_count >= MAX_CLAIMS——永远不会被执行，不应阻塞自动缩容）。
    const res = await this.pool.query(
      `SELECT count(*) FROM tasks WHERE status = 'pending' AND claims_count < $1`,
      [MAX_CLAIMS],
    );
    // count(*) 返回 int8 → node-postgres 解析为字符串，必须 Number() 转换（见 Task 1 ledger minor）。
    return Number((res.rows[0] as { count: string }).count);
  }

  async recoverStaleClaims(timeoutMs: number): Promise<number> {
    // 僵尸认领回收：status='claimed' 且 claimed_at 超时（batch 崩溃/重启时 TaskLoop 被杀，
    // 无善后路径——认领即承诺但进程死无人履行）。回滚 pending + 清 claimed_by/claimed_at；
    // claims_count 不重置（坏任务防循环保留——候选查询排除 claims_count >= MAX_CLAIMS）。
    const res = await this.pool.query(
      `UPDATE tasks
       SET status = 'pending', claimed_by = NULL, claimed_at = NULL, updated_at = now()
       WHERE status = 'claimed'
         AND claimed_at IS NOT NULL
         AND claimed_at < now() - make_interval(secs => $1::float8)
       RETURNING id`,
      [timeoutMs / 1000],
    );
    return res.rowCount ?? 0;
  }

  async reject(agentId: string, taskId: string, reason: string, opts: { terminal?: boolean } = {}): Promise<number> {
    // 允许拒绝：未认领（claimed_by IS NULL）或本人已认领的任务；记录原因并释放认领。
    // terminal=true：坏任务终态化（status='rejected' 不回池）——执行失败（语法/崩溃）的任务
    // 永远无法成功，回池会导致无限 claim→reject 空转（摸底实测 claims_count=252）。
    // 默认（assessed-as-unfit 等软失败）：回到 pending（保持既有语义）。
    const res = await this.pool.query(
      `UPDATE tasks SET
         status = ${opts.terminal ? "'rejected'" : "'pending'"},
         claimed_by = NULL,
         rejects = rejects || $3::jsonb,
         updated_at = now()
       WHERE id = $1 AND (claimed_by IS NULL OR claimed_by = $2)`,
      [taskId, agentId, JSON.stringify([{ agentId, reason, at: Date.now() }])],
    );
    return res.rowCount ?? 0;
  }

  async submit(agentId: string, taskId: string, outputRef: unknown): Promise<number> {
    const res = await this.pool.query(
      `UPDATE tasks SET
         status = 'completed',
         submitted_at = now(),
         completed_at = now(),
         updated_at = now(),
         payload = payload || jsonb_build_object('outputRef', $3::jsonb)
       WHERE id = $1 AND claimed_by = $2`,
      [taskId, agentId, JSON.stringify(outputRef)],
    );
    return res.rowCount ?? 0;
  }
}

function mapRow(row: any): Task {
  return {
    id: row.id,
    title: row.title,
    text: row.text,
    tags: row.tags ?? [],
    status: row.status,
    createdBy: row.created_by,
    claimed_by: row.claimed_by,
    claims_count: row.claims_count,
    created_at: row.created_at,
    payload: row.payload,
    assigned_role: row.assigned_role ?? null,
    tenantId: typeof row.tenant_id === "string" ? row.tenant_id : "default",
    leaseId: row.lease_id ?? null,
    leaseGeneration: Number(row.lease_generation ?? 0),
    leaseExpiresAt: row.lease_expires_at != null ? new Date(row.lease_expires_at) : null,
  };
}
