/**
 * schema.ts —— 记忆域表 DDL（2026-08-15 拆分：从 core schema.ts 迁入 pth-memory 包）。
 * core applySchema 引用 MEMORY_SCHEMA_SQL 拼入总 SCHEMA_SQL——应用顺序不变、SQL 不变。
 */
export const MEMORY_SCHEMA_SQL = `
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

CREATE TABLE IF NOT EXISTS memory_revisions (
  id BIGSERIAL PRIMARY KEY,
  entry_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  revision INTEGER NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL,
  anchors JSONB NOT NULL,
  meta JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  created_by TEXT,
  reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_revisions_entry_rev
  ON memory_revisions(entry_id, tenant_id, revision);
CREATE INDEX IF NOT EXISTS idx_memory_revisions_entry ON memory_revisions(entry_id);

-- F2（AB-01）复合租户身份：memory_entries 主键从 id 升级为 (tenant_id, id)。
-- 幂等顺序：先建唯一索引 → 删旧 pkey → 加复合 pkey（每次启动重复执行安全）。
CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_entries_tenant_id_id ON memory_entries(tenant_id, id);
ALTER TABLE memory_entries DROP CONSTRAINT IF EXISTS memory_entries_pkey;
ALTER TABLE memory_entries ADD PRIMARY KEY (tenant_id, id);

-- N29 Task 6（plan §2.4 G7）：知识条目新增 'stale' 状态。
-- 语义：某条 official 绑定的 Source Revision 发生**实质变化**，或其 policy/subscription 被撤销时，
-- Intake/Promotion 的内部路径把旧条目从 authoritative 面撤出（status='stale'）。
--  - 默认 authoritative 检索（Broker/Context 固定 status=['official']）立即命中 0；
--  - memory_revisions 的 append-only 历史与 asOf 读取仍可读到它 official 时期的正文。
-- 幂等：先 DROP IF EXISTS 再 ADD（重复执行安全；旧库自动升级约束）。
ALTER TABLE memory_entries DROP CONSTRAINT IF EXISTS memory_entries_status_check;
ALTER TABLE memory_entries ADD CONSTRAINT memory_entries_status_check
  CHECK (status IN ('draft','official','archived','stale'));

-- asOf 读取的支撑索引：按 (entry, tenant, 归档时刻) 找"在某一时刻仍然生效"的历史 revision。
CREATE INDEX IF NOT EXISTS idx_memory_revisions_entry_created
  ON memory_revisions(entry_id, tenant_id, created_at);
`;
