import { randomUUID } from "node:crypto";
import type pg from "pg";
import { withTx } from "./pg.js";
import type { DomainBinding } from "@away_from/pth-contracts";
import {
  attachEntryDelivery,
  canonicalEntrySpecDigest,
  encodeResultForPayload,
  TASK_MAX_CLAIMS,
} from "@away_from/pth-contracts";
import { isWorkMode, type WorkMode } from "@away_from/pth-contracts";
/** 路由策略注入（2026-08-13 审计 P2——存储层不再依赖执行层：
 *  校验/分配由装配层（assembly/batch-process）传入——task-store 只存不判） */
export interface TaskRouting {
  validate(input: { tags?: string[]; payload?: unknown }): { ok: boolean; error?: string };
  assign(input: { id: string; tags?: string[]; payload?: unknown }): string;
}

/** 学科识别端口（K2 Phase 2）：装配层注入 catalog resolver；存储层只调不判。 */
export interface DisciplineResolverPort {
  resolve(input: {
    title: string;
    text: string;
    tags: readonly string[];
    explicitDomains?: readonly string[];
  }): { ok: true; binding: DomainBinding } | { ok: false; error: string };
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
  /** M0：tasks.work_mode（服务端盖章；legacy 行缺省 'run'）。 */
  workMode: WorkMode;
}

export interface PublishInput {
  title: string;
  text: string;
  createdBy: string;
  tags?: string[];
  payload?: unknown;
  /** K2 Phase 2：顶层显式 domains（路由 body 透传；优先级高于 payload.domains） */
  domains?: string[];
  /** K2 Phase 2：服务器 resolver 盖章产物；调用方不可信，非 delegate 会被覆盖 */
  domainBinding?: DomainBinding;
  templateId?: string;
  /** 异步 job 委托（v0.8 循环①）：job 关联 id */
  jobId?: string;
  /** P0-3：外部路由从 auth token 派生写入；内部发布者缺省 default */
  tenantId?: string;
  /**
   * W8 P0/P1 服务器端投递盖章开关（仅 TaskControlService 可置）：
   *  - "entry"：外部入口——path=[assignedRole]、lineageId=自身 taskId、parent 不设置；
   *  - "delegate"：worker 父→子投递——assigned_role 由 delegateTarget 强制（服务端已过
   *    组织权矩阵），payload.delivery 已由 TaskControlService 按调用者身份盖章。
   *  内部静态链发布（resolver/trigger/debug-case/optimizer）不传——不改变既有 flow/trigger 语义。
   */
  deliveryMode?: "entry" | "delegate";
  /** 仅 deliveryMode="delegate" 有效：服务端强制路由目标（body 不可自报） */
  delegateTarget?: string;
  /** M0：仅 trusted code-owned 发布可显式指定；gateway/user 发布由 TaskControlService 强制 run。 */
  workMode?: WorkMode;
  /** N33 复验收 P0-4：tenant-scoped 原生发布幂等键；重复发布返回首次接受的行。 */
  idempotencyKey?: string;
  /** 生命周期 P0：入口任务根目标（可选；显式参数 > 模板默认——服务端盖进 delivery.goal）。 */
  goal?: string;
}

export interface TaskStore {
  candidates(agentId: string, opts?: { limit?: number }): Promise<Task[]>;
  claimTopN(agentId: string, ids: string[]): Promise<Task[]>;
  /** 返回受影响行数（0 = 认领已不属于该 agent——审计 H5：双执行/结果丢失信号） */
  reject(agentId: string, taskId: string, reason: string, opts?: { terminal?: boolean }): Promise<number>;
  /** 返回受影响行数（0 = 认领已不属于该 agent——审计 H5：任务可能已被回收重领） */
  submit(agentId: string, taskId: string, outputRef: unknown): Promise<number>;
  publish(input: PublishInput): Promise<Task>;
  /**
   * 持久化子任务委派 V1：在同一 PG 事务内发布任务（child creation + submission/dependency 原子）。
   * 可选方法；TaskControlService 需要它来保证 delegate 的写原子性。
   */
  publishInTx?(client: pg.PoolClient, input: PublishInput): Promise<Task>;
  /** 按 id 取任务（retask 重发布——重发布需原任务正文） */
  getById(id: string): Promise<Task | null>;
  // 跨 spec 扩展（plan Task 5 标注）：负载统计 collectStats 依赖 pending 队列长度。
  countPending(): Promise<number>;
  /** per-role 队列深度（descheduler——自动强化调度信号） */
  countPendingByRole(): Promise<Record<string, number>>;
  /** claim 超时回收：batch 崩溃/重启时僵尸认领（claimed_at 超时）回滚 pending——清 claimed_by/claimed_at */
  recoverStaleClaims(timeoutMs: number): Promise<number>;
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

/** 从 input.domains ?? payload.domains 取显式 domains；payload.domains 必须是字符串数组，否则按空处理。 */
function pickExplicitDomains(inputDomains: string[] | undefined, payload: unknown): string[] {
  if (Array.isArray(inputDomains)) return inputDomains;
  if (!isPlainRecord(payload)) return [];
  const raw = payload["domains"];
  if (!Array.isArray(raw) || !raw.every((x) => typeof x === "string")) return [];
  return raw as string[];
}

function domainsOfPayload(payload: unknown): readonly string[] | undefined {
  if (!isPlainRecord(payload)) return undefined;
  const raw = payload["domains"];
  return Array.isArray(raw) && raw.every((x): x is string => typeof x === "string") ? raw : undefined;
}

function goalOfPayload(payload: unknown): string | null {
  if (!isPlainRecord(payload)) return null;
  const delivery = payload["delivery"];
  if (!isPlainRecord(delivery)) return null;
  const goal = delivery["goal"];
  return typeof goal === "string" && goal.trim() !== "" ? goal : null;
}

/** 入口幂等正文 digest（用 resolver 之后的有效 payload.domains 参与比较）。 */
function incomingEntryDigest(input: PublishInput, payload: unknown): string {
  return canonicalEntrySpecDigest({
    title: input.title,
    text: input.text,
    tags: input.tags ?? [],
    goal: input.goal ?? null,
    domains: domainsOfPayload(payload),
  });
}

function existingEntryDigest(row: Record<string, unknown>): string {
  const payload = row["payload"];
  const tags = Array.isArray(row["tags"]) ? (row["tags"] as unknown[]).filter((x): x is string => typeof x === "string") : [];
  return canonicalEntrySpecDigest({
    title: typeof row["title"] === "string" ? row["title"] : "",
    text: typeof row["text"] === "string" ? row["text"] : "",
    tags,
    goal: goalOfPayload(payload),
    domains: domainsOfPayload(payload),
  });
}

/** 同 idempotencyKey 不同 canonical 正文 → 显式 conflict（不再静默返回旧任务）。 */
function assertIdempotencyMatch(row: Record<string, unknown>, incomingDigest: string): void {
  const existingDigest = existingEntryDigest(row);
  if (existingDigest !== incomingDigest) {
    const err = new Error("idempotencyKey conflict: 同 key 提交了不同正文（title/text/tags/goal/domains 不一致）") as Error & { statusCode?: number };
    err.statusCode = 409;
    throw err;
  }
}

export class PgTaskStore implements TaskStore {
  constructor(
    private pool: pg.Pool,
    private routing?: TaskRouting,
    private disciplineResolver?: DisciplineResolverPort,
  ) {}

  async publish(input: PublishInput): Promise<Task> {
    return this.publishWithClient(this.pool, input);
  }

  async publishInTx(client: pg.PoolClient, input: PublishInput): Promise<Task> {
    return this.publishWithClient(client, input);
  }

  private async publishWithClient(client: Pick<pg.Pool, "query">, input: PublishInput): Promise<Task> {
    // 任务池纯化（2026-08-10 D5）：publish 唯一入口严格校验——未知标签/歧义/无路由依据
    // 一律拒绝（statusCode 400——fastify 映射；内部发布者同样受约束）。
    // 2026-08-13 审计 P2：校验/分配策略由装配层注入（DIP）——本层只存不判。
    // W8 P1：delegate 通道由 TaskControlService 已过组织权矩阵 + 标签注册表校验，
    // 这里直接采用服务端 delegateTarget（MID 目标无已注册标签也能投递——用户裁决）。
    const isDelegate = input.deliveryMode === "delegate";
    if (isDelegate && typeof input.delegateTarget !== "string") {
      const err = new Error("deliveryMode=delegate 必须携带服务端 delegateTarget") as Error & { statusCode?: number };
      err.statusCode = 400;
      throw err;
    }
    if (this.routing && !isDelegate) {
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
    const assignedRole = isDelegate
      ? (input.delegateTarget as string)
      : (this.routing?.assign({ id, tags: input.tags, payload: input.payload }) ?? null);
    // W8 P0 入口盖章（用户裁决 Q2：仅外部入口）——无路由策略注入（测试/直连装配）时无法
    // 确定 assignedRole，不盖章降级（不阻断兼容性；生产 gateway 恒注入 routing）。
    const basePayload = input.deliveryMode === "entry" && assignedRole
      ? attachEntryDelivery(input.payload, id, assignedRole, input.goal)
      : input.payload ?? {};
    // K2 Phase 2：非 delegate 通道由 disciplineResolver 解析并机读盖章 domains/domainBinding；
    // delegate 通道不重跑 resolver——子任务继承父 payload 的 domains/domainBinding（父 capability 传入）。
    let payload = basePayload;
    if (!isDelegate && this.disciplineResolver) {
      const explicitDomains = pickExplicitDomains(input.domains, input.payload ?? {});
      const resolved = this.disciplineResolver.resolve({
        title: input.title,
        text: input.text,
        tags: input.tags ?? [],
        explicitDomains,
      });
      if (!resolved.ok) {
        const err = new Error(resolved.error) as Error & { statusCode?: number };
        err.statusCode = 400;
        throw err;
      }
      const binding = resolved.binding;
      payload = {
        ...(isPlainRecord(basePayload) ? basePayload : {}),
        domains: binding.matches.map((m) => m.domainId),
        domainBinding: binding,
      };
    }
    const tenantId = typeof input.tenantId === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(input.tenantId) ? input.tenantId : "default";
    const idempotencyKey = input.idempotencyKey;
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== "string" || idempotencyKey.trim() === "" || idempotencyKey.length > 128)) {
      const err = new Error("idempotencyKey 可选——若提供必须是 1..128 字符的非空字符串") as Error & { statusCode?: number };
      err.statusCode = 400;
      throw err;
    }
    if (idempotencyKey) {
      const incomingDigest = incomingEntryDigest(input, payload);
      const existing = await client.query(`SELECT * FROM tasks WHERE tenant_id = $1 AND idempotency_key = $2`, [tenantId, idempotencyKey]);
      if (existing.rows[0]) {
        assertIdempotencyMatch(existing.rows[0] as Record<string, unknown>, incomingDigest);
        return mapRow(existing.rows[0]);
      }
    }
    const workMode = input.workMode ?? "run";
    if (!isWorkMode(workMode)) {
      const err = new Error(`unknown work mode: ${String(workMode)}`) as Error & { statusCode?: number };
      err.statusCode = 400;
      throw err;
    }
    try {
      const res = await client.query(
        `INSERT INTO tasks (id, tenant_id, title, text, created_by, tags, payload, template_id, assigned_role, job_id, work_mode, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING *`,
        [id, tenantId, input.title, input.text, input.createdBy, input.tags ?? [], payload, input.templateId ?? null, assignedRole, input.jobId ?? null, workMode, idempotencyKey ?? null],
      );
      return mapRow(res.rows[0]);
    } catch (error) {
      // 并发同键：唯一索引兜底，返回已提交的首行（commit 成功但响应丢失时重试收敛到同一 task）。
      if (idempotencyKey && (error as { code?: string }).code === "23505") {
        const existing = await client.query(`SELECT * FROM tasks WHERE tenant_id = $1 AND idempotency_key = $2`, [tenantId, idempotencyKey]);
        if (existing.rows[0]) {
          assertIdempotencyMatch(existing.rows[0] as Record<string, unknown>, incomingEntryDigest(input, payload));
          return mapRow(existing.rows[0]);
        }
      }
      throw error;
    }
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
    // W8 P0 终态回写（legacy 兼容路径）：payload.result = JSON-safe 编码结果；
    // outputRef 保留（task-resolver loop 条件的既有读取面）。
    const encoded = encodeResultForPayload(outputRef).value;
    const res = await this.pool.query(
      `UPDATE tasks SET
         status = 'completed',
         submitted_at = now(),
         completed_at = now(),
         updated_at = now(),
         payload = jsonb_set(
           jsonb_set(COALESCE(payload, '{}'::jsonb), '{result}', $3::jsonb, true),
           '{outputRef}', $4::jsonb, true)
       WHERE id = $1 AND claimed_by = $2`,
      [taskId, agentId, JSON.stringify(encoded), JSON.stringify({ ref: encoded })],
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
    workMode: isWorkMode(row.work_mode) ? row.work_mode : "run",
  };
}
