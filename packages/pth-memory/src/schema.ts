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
`;
