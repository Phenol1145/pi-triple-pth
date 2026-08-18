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
-- 进程重启不丢；幂等 key 防重复入队；attempts≥max 置 dead-letter 留审计。
-- R4/P0-5（2026-08-18）：原子 claim——pending→processing 携带 processing_token/owner/lease；
-- complete/markFailed 必须匹配 token+processing（CAS）；available_at 控制重试回退。
CREATE TABLE IF NOT EXISTS side_effect_outbox (
  id BIGSERIAL PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  kind TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','done','failed','dead-letter')),
  attempts INTEGER NOT NULL DEFAULT 0,
  processing_token TEXT,
  locked_until TIMESTAMPTZ,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT,
  owner TEXT,
  dead_letter_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  done_at TIMESTAMPTZ
);
-- R4/P0-5：旧库增量迁移——补充 claim 列并放宽 status CHECK（processing/dead-letter）。
ALTER TABLE side_effect_outbox ADD COLUMN IF NOT EXISTS processing_token TEXT;
ALTER TABLE side_effect_outbox ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;
ALTER TABLE side_effect_outbox ADD COLUMN IF NOT EXISTS available_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE side_effect_outbox ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE side_effect_outbox ADD COLUMN IF NOT EXISTS owner TEXT;
ALTER TABLE side_effect_outbox ADD COLUMN IF NOT EXISTS dead_letter_at TIMESTAMPTZ;
ALTER TABLE side_effect_outbox DROP CONSTRAINT IF EXISTS side_effect_outbox_status_check;
ALTER TABLE side_effect_outbox ADD CONSTRAINT side_effect_outbox_status_check
  CHECK (status IN ('pending','processing','done','failed','dead-letter'));
CREATE INDEX IF NOT EXISTS idx_side_effect_outbox_claim ON side_effect_outbox(status, available_at, id);

-- R3/P1-2（2026-08-18）：持久 VerificationPlan + verdict rows（不 append entry.meta.verdicts）。
-- candidate_revision/candidate_hash 建计划时快照；verdict 行严格绑定 plan+check+revision+hash+principal+execution。
-- row_version 为 review-row 独立版本，与 memory_entries.version（candidate content revision）分离。
CREATE TABLE IF NOT EXISTS knowledge_verification_plans (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  candidate_id TEXT NOT NULL,
  candidate_revision INTEGER NOT NULL,
  candidate_hash TEXT NOT NULL,
  required_domains JSONB NOT NULL DEFAULT '[]',
  checks JSONB NOT NULL DEFAULT '[]',
  source_bindings_digest TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','satisfied','rejected','invalidated')),
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_verification_plans_tenant_candidate_rev
  ON knowledge_verification_plans(tenant_id, candidate_id, candidate_revision);
CREATE INDEX IF NOT EXISTS idx_verification_plans_candidate ON knowledge_verification_plans(tenant_id, candidate_id);

CREATE TABLE IF NOT EXISTS knowledge_verdict_rows (
  id BIGSERIAL PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES knowledge_verification_plans(id),
  tenant_id TEXT NOT NULL DEFAULT 'default',
  check_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  candidate_revision INTEGER NOT NULL,
  candidate_hash TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('domain','adversarial')),
  verdict TEXT NOT NULL CHECK (verdict IN ('pass','reject')),
  reviewer_role TEXT NOT NULL,
  note TEXT NOT NULL,
  domain_id TEXT,
  evidence JSONB DEFAULT '[]',
  at BIGINT NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_verdict_rows_plan_check_principal
  ON knowledge_verdict_rows(plan_id, check_id, principal_id);
CREATE INDEX IF NOT EXISTS idx_verdict_rows_plan ON knowledge_verdict_rows(plan_id, tenant_id);
`;

export async function applySchema(pool: pg.Pool): Promise<void> {
  await pool.query(SCHEMA_SQL);
  await pool.query(
    `INSERT INTO schema_migrations (version) VALUES ($1)
     ON CONFLICT (version) DO NOTHING`,
    [SCHEMA_VERSION],
  );
}
