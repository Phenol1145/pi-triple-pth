import type pg from "pg";
import { MEMORY_SCHEMA_SQL } from "@away_from/pth-memory";

export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS task_templates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  label_patterns JSONB DEFAULT '[]',
  execution_protocol JSONB DEFAULT '{}',
  input_schema JSONB DEFAULT '{}',
  acceptance_criteria JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  template_id TEXT REFERENCES task_templates(id),
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  description TEXT,
  created_by TEXT NOT NULL,
  payload JSONB DEFAULT '{}',
  tags TEXT[] DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','claimed','submitted','completed','rejected','escalated')),
  claimed_by TEXT,
  claims_count INTEGER DEFAULT 0,
  rejects JSONB DEFAULT '[]',
  sorter_selector TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  claimed_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  escalated_at TIMESTAMPTZ,
  stale_ms INTEGER DEFAULT 600000,
  artifact_path TEXT,
  transcript_id TEXT
);
-- 任务分配正交化（2026-08-08）：assigned_role 发布时确定性路由（flow 显式/tags 语义/hash 分片）
-- candidates 只查自己的队列——角色间零竞速抢票
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assigned_role TEXT;
CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_role, status);
-- 异步 job 委托（v0.8 循环①）：job 关联——一次提交多任务（job_id），交互层脱手后续收取
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS job_id TEXT;
CREATE INDEX IF NOT EXISTS idx_tasks_job ON tasks(job_id, status);
-- 存量 pending 任务回填：确定性分片（hashtext 内置 hash；与 JS djb2 不同但均匀+确定）
UPDATE tasks SET assigned_role =
  (ARRAY['analyst','planner','developer','scout','memory-keeper','acceptor','tester'])
    [abs(hashtext(id)) % 7 + 1]
WHERE assigned_role IS NULL AND status = 'pending';
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_tags ON tasks USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_payload_flow ON tasks USING GIN(payload);  -- resolver 查询（payload ? 'flow'）
CREATE INDEX IF NOT EXISTS idx_tasks_claimed_by ON tasks(claimed_by, status);
CREATE INDEX IF NOT EXISTS idx_tasks_claimed_at ON tasks(claimed_at) WHERE status='claimed';
-- 模块化 v2 P1-1：真实 task lease 列（tasking CAS 地基——lease_id/generation/expires_at）。
-- 幂等增量迁移：旧行 lease_id NULL + lease_generation 0（尚未被新 tasking 协议认领）；
-- claimed_by/claims_count 保留为诊断字段，新 lease 协议不依赖它们授权。
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS lease_id UUID;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS lease_generation BIGINT NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_tasks_active_lease ON tasks(tenant_id, lease_id, lease_generation) WHERE status='claimed';

${MEMORY_SCHEMA_SQL}

-- 死表标注（2026-08-14 A2 探查 0.5）：lab_events/credit_tx 为 archive/agent-lab 遗留——
-- 迁档后生产零消费；保留表（历史数据不做 DROP 迁移面），如 agent-lab 生态复活则复用。
CREATE TABLE IF NOT EXISTS lab_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  event_type TEXT NOT NULL,
  trace_id TEXT,
  transition_seq INTEGER,
  payload JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS credit_tx (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount INTEGER NOT NULL,
  payload JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS transcripts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  task_id TEXT REFERENCES tasks(id),
  session_id TEXT,
  agent_id TEXT,
  body JSONB NOT NULL DEFAULT '[]',
  summary TEXT,
  artifact_path TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  event_type TEXT NOT NULL,
  actor TEXT,
  task_id TEXT,
  worker_id TEXT,
  session_id TEXT,
  payload JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_type_time ON audit_log(event_type, created_at);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,   -- 视图层：kind='skill' 的 memory_entries 简化投影（B4 Phase 1：memory_entries 为事实源，本表投影语义不变）
  tenant_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  description TEXT,
  content TEXT NOT NULL,
  meta JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- F5（2026-08-18）：durable side-effect outbox——post-commit 副作用（refine 等）先落库再异步消费，
-- 进程重启不丢；幂等 key 防重复入队；attempts≥3 置 failed 留审计。
CREATE TABLE IF NOT EXISTS side_effect_outbox (
  id BIGSERIAL PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  kind TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  done_at TIMESTAMPTZ
);
`;

export async function applySchema(pool: pg.Pool): Promise<void> {
  await pool.query(SCHEMA_SQL);
  await pool.query(
    `INSERT INTO schema_migrations (version) VALUES ($1)
     ON CONFLICT (version) DO NOTHING`,
    [SCHEMA_VERSION],
  );
}
