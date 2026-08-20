import type pg from "pg";
import { MEMORY_SCHEMA_SQL } from "@away_from/pth-memory";

export const SCHEMA_VERSION = 1;

/**
 * N29 Task 3（2026-08-19）：知识摄入内环 PG 真相源——Subscription / Run / Attempt /
 * Artifact / Revision / Dependency，以及已验签 Trust Policy 的**不可变审计镜像**。
 *
 * 不变量（plan §3.2 / §5 Task 3 Step 3）：
 *  - 所有主查询键以 `tenant_id` 起头（复合 PK `(tenant_id, id)`；surrogate BIGSERIAL 表由
 *    tenant-first 唯一/普通索引承担查询键），跨 tenant 一律零可见；
 *  - 可变聚合（subscription / run / dependency）带 `row_version`，状态迁移必须 CAS；
 *  - `knowledge_trust_policies` 只是已验签 manifest 的审计镜像：manifest 正文与 digest/签名
 *    append-only，DB 行不能创建、扩大或替换 policy（授权事实仍是签名 manifest + PTL human proof）；
 *  - artifact / revision / attempt 正文 append-only：raw-quarantine → admitted 必须**新插一行**
 *    并用 `derived_from_revision_id` 关联，不得把 quarantined 行原地 UPDATE 成 admitted；
 *    正文列由 BEFORE UPDATE 触发器守卫（改正文 → `restrict_violation`）；
 *  - `raw_hash` 在 tenant 内唯一：同 tenant 重复字节复用既有 artifact，跨 tenant 各存一份；
 *  - N29 再验收 P0-4：`admitted` revision 的三条不变量在 DB 层再守一次（CHECK + BEFORE INSERT
 *    触发器）：必须有 `derived_from_revision_id`、use decision 必须 `allow`、父行必须是同
 *    tenant + 同 subscription 的 `raw-quarantine` 行；hash 可重算性由仓库写口负责（见
 *    `knowledge-intake-pg.ts` 的 `storeAcquisition()`）；
 *  - 外键全部 tenant-qualified（复合 FK）；可空自引用列按 MATCH SIMPLE 语义在 NULL 时不约束；
 *  - 迁移风格与本文件既有约定一致：`CREATE TABLE/INDEX IF NOT EXISTS` +
 *    `DROP TRIGGER IF EXISTS` → `CREATE TRIGGER`，可重复执行。
 */
export const KNOWLEDGE_INTAKE_SCHEMA_SQL = `
-- append-only 守卫：TG_ARGV 列出的列一旦被 UPDATE 修改即抛 restrict_violation。
-- 只守卫"正文"列——后续任务新增的状态列（如 stale/withdrawn 标记）默认可变。
CREATE OR REPLACE FUNCTION knowledge_intake_guard_immutable() RETURNS trigger AS $guard$
DECLARE
  col text;
BEGIN
  FOREACH col IN ARRAY TG_ARGV LOOP
    IF (to_jsonb(OLD) -> col) IS DISTINCT FROM (to_jsonb(NEW) -> col) THEN
      RAISE EXCEPTION 'append-only violation: %.% is immutable', TG_TABLE_NAME, col
        USING ERRCODE = 'restrict_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$guard$ LANGUAGE plpgsql;

-- 1/7 已验签 Trust Policy 的不可变审计镜像（identity=(tenant_id, policy_id, policy_version)）。
CREATE TABLE IF NOT EXISTS knowledge_trust_policies (
  tenant_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  policy_digest TEXT NOT NULL,
  spaces JSONB NOT NULL DEFAULT '[]',
  valid_from TIMESTAMPTZ NOT NULL,
  valid_until TIMESTAMPTZ NOT NULL,
  approved_by_principal_id TEXT NOT NULL,
  approved_by_issuer TEXT NOT NULL,
  approval_method TEXT NOT NULL,
  approval_key_id TEXT NOT NULL,
  approval_signature TEXT NOT NULL,
  manifest JSONB NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  installed_by TEXT NOT NULL DEFAULT '',
  last_verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, policy_id, policy_version)
);
CREATE INDEX IF NOT EXISTS idx_knowledge_trust_policies_digest
  ON knowledge_trust_policies(tenant_id, policy_digest);
DROP TRIGGER IF EXISTS trg_knowledge_trust_policies_append_only ON knowledge_trust_policies;
CREATE TRIGGER trg_knowledge_trust_policies_append_only
  BEFORE UPDATE ON knowledge_trust_policies FOR EACH ROW
  EXECUTE FUNCTION knowledge_intake_guard_immutable(
    'tenant_id','policy_id','policy_version','policy_digest','manifest','spaces',
    'valid_from','valid_until','approved_by_principal_id','approved_by_issuer',
    'approval_method','approval_key_id','approval_signature','verified_at','created_at');

-- 2/7 Source Subscription（可变聚合：status / next_crawl_at / row_version）。
-- policy 绑定是 tenant-qualified FK → 未安装（或版本不符）的 policy 无法产生 subscription。
CREATE TABLE IF NOT EXISTS knowledge_source_subscriptions (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  space TEXT NOT NULL,
  canonical_uri TEXT NOT NULL,
  domain_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'probing'
    CHECK (status IN ('probing','active','paused','revoked','retired')),
  policy_id TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  policy_digest TEXT NOT NULL,
  policy_rule_id TEXT NOT NULL,
  recrawl_interval_ms BIGINT NOT NULL CHECK (recrawl_interval_ms > 0),
  next_crawl_at TIMESTAMPTZ NOT NULL,
  last_successful_revision_id TEXT,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, policy_id, policy_version)
    REFERENCES knowledge_trust_policies(tenant_id, policy_id, policy_version)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_knowledge_source_subscriptions_uri
  ON knowledge_source_subscriptions(tenant_id, space, canonical_uri);
CREATE INDEX IF NOT EXISTS idx_knowledge_source_subscriptions_due
  ON knowledge_source_subscriptions(tenant_id, status, next_crawl_at);
-- 系统级 due scanner（跨 tenant 单次扫描）的扫描路径；tenant-first 索引仍是主查询键。
CREATE INDEX IF NOT EXISTS idx_knowledge_source_subscriptions_scan
  ON knowledge_source_subscriptions(status, next_crawl_at, tenant_id);

-- 3/7 Intake Run（可变聚合：stage/status/lease/row_version）。
-- 同一 subscription 同时最多一个未终结 run —— due scanner 双跑不产生重复 run。
CREATE TABLE IF NOT EXISTS knowledge_intake_runs (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('initial','scheduled','manual-retry')),
  stage TEXT NOT NULL DEFAULT 'fetch'
    CHECK (stage IN ('fetch','admit','extract','verify','promote','complete')),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','leased','waiting','completed','failed','dead-letter')),
  attempt INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_generation BIGINT NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  source_revision_id TEXT,
  candidate_id TEXT,
  verification_plan_id TEXT,
  last_error TEXT,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, subscription_id)
    REFERENCES knowledge_source_subscriptions(tenant_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_knowledge_intake_runs_open_subscription
  ON knowledge_intake_runs(tenant_id, subscription_id)
  WHERE status IN ('queued','leased','waiting');
CREATE INDEX IF NOT EXISTS idx_knowledge_intake_runs_status
  ON knowledge_intake_runs(tenant_id, status, stage);
CREATE INDEX IF NOT EXISTS idx_knowledge_intake_runs_lease
  ON knowledge_intake_runs(tenant_id, locked_until) WHERE status = 'leased';

-- 4/7 Intake Attempt（append-only 审计：每次 lease / 每次结果各一行，旧 attempt 永不覆盖）。
CREATE TABLE IF NOT EXISTS knowledge_intake_attempts (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  stage TEXT NOT NULL
    CHECK (stage IN ('fetch','admit','extract','verify','promote','complete')),
  attempt INTEGER NOT NULL,
  lease_generation BIGINT NOT NULL,
  lease_token_hash TEXT NOT NULL,
  input_hash TEXT NOT NULL DEFAULT '',
  output_hash TEXT,
  disposition TEXT NOT NULL
    CHECK (disposition IN ('leased','succeeded','retryable-failed','terminal-failed','expired')),
  principal_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, run_id) REFERENCES knowledge_intake_runs(tenant_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_knowledge_intake_attempts_identity
  ON knowledge_intake_attempts(tenant_id, run_id, stage, attempt, lease_generation, disposition);
CREATE INDEX IF NOT EXISTS idx_knowledge_intake_attempts_run
  ON knowledge_intake_attempts(tenant_id, run_id, id);
DROP TRIGGER IF EXISTS trg_knowledge_intake_attempts_append_only ON knowledge_intake_attempts;
CREATE TRIGGER trg_knowledge_intake_attempts_append_only
  BEFORE UPDATE ON knowledge_intake_attempts FOR EACH ROW
  EXECUTE FUNCTION knowledge_intake_guard_immutable(
    'id','tenant_id','run_id','stage','attempt','lease_generation','lease_token_hash',
    'input_hash','output_hash','disposition','principal_id','execution_id','created_at');

-- 5/7 Source Artifact（不可变原始字节；raw_hash 在 tenant 内去重）。
CREATE TABLE IF NOT EXISTS knowledge_source_artifacts (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  raw_hash TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  content_type TEXT NOT NULL DEFAULT '',
  raw_bytes BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_knowledge_source_artifacts_raw_hash
  ON knowledge_source_artifacts(tenant_id, raw_hash);
DROP TRIGGER IF EXISTS trg_knowledge_source_artifacts_append_only ON knowledge_source_artifacts;
CREATE TRIGGER trg_knowledge_source_artifacts_append_only
  BEFORE UPDATE ON knowledge_source_artifacts FOR EACH ROW
  EXECUTE FUNCTION knowledge_intake_guard_immutable(
    'tenant_id','id','raw_hash','byte_length','content_type','raw_bytes','created_at');

-- 6/7 Source Revision（append-only；raw-quarantine / admitted / unchanged 各自独立成行）。
-- admitted 必须携带 use policy decision（DB 级 fail closed）。
CREATE TABLE IF NOT EXISTS knowledge_source_revisions (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  run_id TEXT,
  previous_revision_id TEXT,
  derived_from_revision_id TEXT,
  requested_uri TEXT NOT NULL,
  final_uri TEXT NOT NULL,
  redirect_chain JSONB NOT NULL DEFAULT '[]',
  acquired_at TIMESTAMPTZ NOT NULL,
  response_status INTEGER NOT NULL,
  content_type TEXT NOT NULL DEFAULT '',
  etag TEXT,
  last_modified TEXT,
  artifact_id TEXT NOT NULL,
  raw_hash TEXT NOT NULL,
  normalized_text_hash TEXT NOT NULL,
  normalized_text TEXT NOT NULL,
  disposition TEXT NOT NULL
    CHECK (disposition IN ('raw-quarantine','admitted','unchanged','rejected')),
  fetch_policy_decision JSONB NOT NULL,
  use_policy_decision JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT knowledge_source_revisions_admitted_needs_use_decision
    CHECK (disposition <> 'admitted' OR use_policy_decision IS NOT NULL),
  FOREIGN KEY (tenant_id, subscription_id)
    REFERENCES knowledge_source_subscriptions(tenant_id, id),
  FOREIGN KEY (tenant_id, artifact_id)
    REFERENCES knowledge_source_artifacts(tenant_id, id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES knowledge_intake_runs(tenant_id, id),
  FOREIGN KEY (tenant_id, previous_revision_id) REFERENCES knowledge_source_revisions(tenant_id, id),
  FOREIGN KEY (tenant_id, derived_from_revision_id) REFERENCES knowledge_source_revisions(tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_knowledge_source_revisions_subscription
  ON knowledge_source_revisions(tenant_id, subscription_id, acquired_at DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_source_revisions_raw_hash
  ON knowledge_source_revisions(tenant_id, raw_hash);
DROP TRIGGER IF EXISTS trg_knowledge_source_revisions_append_only ON knowledge_source_revisions;
CREATE TRIGGER trg_knowledge_source_revisions_append_only
  BEFORE UPDATE ON knowledge_source_revisions FOR EACH ROW
  EXECUTE FUNCTION knowledge_intake_guard_immutable(
    'tenant_id','id','subscription_id','run_id','previous_revision_id','derived_from_revision_id',
    'requested_uri','final_uri','redirect_chain','acquired_at','response_status','content_type',
    'etag','last_modified','artifact_id','raw_hash','normalized_text_hash','normalized_text',
    'disposition','fetch_policy_decision','use_policy_decision','created_at');

-- N29 再验收 P0-4（feedback §3 P0-4 / §8 条件 4）：admitted 不变量的**同事务数据库约束层**
-- 第二道防线。仓库写口（storeAcquisition）已逐项对账并服务端重算 hash；这里再用声明式约束 +
-- BEFORE INSERT 触发器兜住"绕过仓库直接 INSERT"的路径：
--   ① admitted 必须携带 derived_from_revision_id（raw→admitted 关联不可缺）；
--   ② admitted 的 use decision 必须是 allow（deny 不得成为 admitted）；
--   ③ admitted 的父行必须是同 tenant + 同 subscription 的 raw-quarantine 行（跨行判据 → 触发器）。
ALTER TABLE knowledge_source_revisions
  DROP CONSTRAINT IF EXISTS knowledge_source_revisions_admitted_needs_parent;
ALTER TABLE knowledge_source_revisions
  ADD CONSTRAINT knowledge_source_revisions_admitted_needs_parent
  CHECK (disposition <> 'admitted' OR derived_from_revision_id IS NOT NULL);
ALTER TABLE knowledge_source_revisions
  DROP CONSTRAINT IF EXISTS knowledge_source_revisions_admitted_needs_allow;
ALTER TABLE knowledge_source_revisions
  ADD CONSTRAINT knowledge_source_revisions_admitted_needs_allow
  CHECK (disposition <> 'admitted' OR (use_policy_decision ->> 'decision') = 'allow');

CREATE OR REPLACE FUNCTION knowledge_source_revisions_guard_admitted() RETURNS trigger AS $admitted$
DECLARE
  parent_disposition TEXT;
  parent_subscription TEXT;
BEGIN
  IF NEW.disposition <> 'admitted' THEN
    RETURN NEW;
  END IF;
  SELECT r.disposition, r.subscription_id INTO parent_disposition, parent_subscription
    FROM knowledge_source_revisions r
   WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.derived_from_revision_id;
  IF parent_disposition IS NULL THEN
    RAISE EXCEPTION 'admitted revision % has no raw-quarantine parent in tenant %', NEW.id, NEW.tenant_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF parent_disposition <> 'raw-quarantine' THEN
    RAISE EXCEPTION 'admitted revision % must derive from raw-quarantine (parent disposition=%)',
      NEW.id, parent_disposition USING ERRCODE = 'restrict_violation';
  END IF;
  IF parent_subscription <> NEW.subscription_id THEN
    RAISE EXCEPTION 'admitted revision % parent belongs to subscription % (expected %)',
      NEW.id, parent_subscription, NEW.subscription_id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$admitted$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_knowledge_source_revisions_admitted_parent ON knowledge_source_revisions;
CREATE TRIGGER trg_knowledge_source_revisions_admitted_parent
  BEFORE INSERT ON knowledge_source_revisions FOR EACH ROW
  EXECUTE FUNCTION knowledge_source_revisions_guard_admitted();

-- 7/7 Source Dependency（边 append-only；只有 stale 状态可迁移，带 row_version）。
CREATE TABLE IF NOT EXISTS knowledge_source_dependencies (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  source_revision_id TEXT NOT NULL,
  dependent_kind TEXT NOT NULL DEFAULT 'knowledge-entry'
    CHECK (dependent_kind IN ('knowledge-entry','candidate')),
  dependent_id TEXT NOT NULL,
  dependent_revision INTEGER,
  space TEXT NOT NULL DEFAULT '',
  evidence_digest TEXT NOT NULL DEFAULT '',
  stale BOOLEAN NOT NULL DEFAULT false,
  stale_at TIMESTAMPTZ,
  stale_reason TEXT,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, subscription_id)
    REFERENCES knowledge_source_subscriptions(tenant_id, id),
  FOREIGN KEY (tenant_id, source_revision_id)
    REFERENCES knowledge_source_revisions(tenant_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_knowledge_source_dependencies_edge
  ON knowledge_source_dependencies(tenant_id, dependent_kind, dependent_id, source_revision_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_source_dependencies_subscription
  ON knowledge_source_dependencies(tenant_id, subscription_id, stale);
DROP TRIGGER IF EXISTS trg_knowledge_source_dependencies_append_only ON knowledge_source_dependencies;
CREATE TRIGGER trg_knowledge_source_dependencies_append_only
  BEFORE UPDATE ON knowledge_source_dependencies FOR EACH ROW
  EXECUTE FUNCTION knowledge_intake_guard_immutable(
    'id','tenant_id','subscription_id','source_revision_id','dependent_kind','dependent_id',
    'dependent_revision','space','evidence_digest','created_at');
`;

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

-- M0（2026-08-19）：Work Mode 服务端盖章。gateway/user 发布恒 run；trusted 系统模板发布
-- 可显式写 optimize/intake；DB 默认 run 并约束三值，旧行自动回填 run。
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS work_mode TEXT NOT NULL DEFAULT 'run';
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_work_mode_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_work_mode_check
  CHECK (work_mode IN ('intake','optimize','run'));

-- N33 复验收 P0-4（2026-08-20）：tenant-scoped 原生发布幂等键。
-- 同 tenant 同 key 只允许一行任务；重复发布返回首次接受的行（含 commit 后响应丢失场景）。
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_tenant_idempotency
  ON tasks(tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

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
-- N29/P0-3（2026-08-19）：幂等身份改为 (tenant_id, key)——不再是全局 UNIQUE(key)；
-- payload_hash 为稳定 sha256(canonical JSON)，同 tenant/key 只有 kind+payload+hash 全同才算重放。
CREATE TABLE IF NOT EXISTS side_effect_outbox (
  id BIGSERIAL PRIMARY KEY,
  key TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  kind TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  payload_hash TEXT NOT NULL DEFAULT '',
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
-- N29/P0-3 增量迁移：全局 UNIQUE(key) → UNIQUE(tenant_id, key)，并补 payload_hash。
-- 存量行安全性：payload_hash 默认 '' 视为"未回填"，enqueue 的 exact 重放判据在 hash 为空时退回
-- kind + payload jsonb 等值比较并顺带回填 hash；不同 payload 仍显式 conflict（不静默覆盖）。
-- 若存量数据存在跨 tenant 同 key 行，DROP 全局唯一约束不会失败；新唯一索引按 (tenant_id,key) 建立。
ALTER TABLE side_effect_outbox ADD COLUMN IF NOT EXISTS payload_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE side_effect_outbox DROP CONSTRAINT IF EXISTS side_effect_outbox_key_key;
DROP INDEX IF EXISTS side_effect_outbox_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_side_effect_outbox_tenant_key
  ON side_effect_outbox(tenant_id, key);

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

${KNOWLEDGE_INTAKE_SCHEMA_SQL}
`;

export async function applySchema(pool: pg.Pool): Promise<void> {
  await pool.query(SCHEMA_SQL);
  await pool.query(
    `INSERT INTO schema_migrations (version) VALUES ($1)
     ON CONFLICT (version) DO NOTHING`,
    [SCHEMA_VERSION],
  );
}
