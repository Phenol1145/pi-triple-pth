import type pg from "pg";

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
  (ARRAY['analyst','planner','developer','scout','memory-keeper','acceptor','human-interface'])
    [abs(hashtext(id)) % 7 + 1]
WHERE assigned_role IS NULL AND status = 'pending';
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_tags ON tasks USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_payload_flow ON tasks USING GIN(payload);  -- resolver 查询（payload ? 'flow'）
CREATE INDEX IF NOT EXISTS idx_tasks_claimed_by ON tasks(claimed_by, status);
CREATE INDEX IF NOT EXISTS idx_tasks_claimed_at ON tasks(claimed_at) WHERE status='claimed';

CREATE TABLE IF NOT EXISTS memory_entries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  kind TEXT NOT NULL,
  anchors JSONB NOT NULL DEFAULT '[]'
    CHECK (jsonb_array_length(anchors) > 0),
  content TEXT NOT NULL,
  rule_ref TEXT,
  idempotency_key TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'official'
    CHECK (status IN ('draft','official','archived')),
  version INTEGER NOT NULL DEFAULT 1,
  hit_count INTEGER DEFAULT 0,
  not_write_back BOOLEAN DEFAULT FALSE,
  ttl_expires_at TIMESTAMPTZ,
  promoted_from TEXT,
  meta JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_memory_anchors ON memory_entries USING GIN(anchors);
CREATE INDEX IF NOT EXISTS idx_memory_status ON memory_entries(status);

CREATE TABLE IF NOT EXISTS memory_buffer (
  id BIGSERIAL PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  content TEXT NOT NULL,
  anchors JSONB DEFAULT '[]',
  kind TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memory_idem (
  key TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL,
  watermark INTEGER
);

CREATE TABLE IF NOT EXISTS memory_retry (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS memory_index (
  anchor TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  PRIMARY KEY (anchor, entry_id)
);

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
  id TEXT PRIMARY KEY,   -- 视图层：kind='skill' 的 memory_entries 简化投影（v1 独立表占位）
  tenant_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  description TEXT,
  content TEXT NOT NULL,
  meta JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
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
