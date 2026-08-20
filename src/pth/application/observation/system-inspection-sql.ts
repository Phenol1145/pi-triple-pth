/**
 * application/observation/system-inspection-sql.ts —— N33 只读巡检投影的 SQL 常量。
 *
 * 全部只读 SELECT；绝不写领域源表。从 system-inspection-facade.ts 拆出以控制文件体量。
 */

export const SYSTEM_INSPECTION_VISIBILITY_SQL = `
      COALESCE(me.meta->'spaceScope'->>'space', 'meta') = ANY($5::text[])
      AND (
        COALESCE(me.meta->'spaceScope'->>'visibility', 'public') = 'public'
        OR COALESCE(me.meta->'spaceScope'->>'space', 'meta') = $6::text
      )
`;

export const SYSTEM_INSPECTION_MEMORY_LIST_SQL = `
SELECT
  me.id,
  me.kind,
  me.status,
  me.anchors,
  me.version,
  me.created_at,
  me.updated_at,
  octet_length(me.content)::int AS content_bytes
FROM memory_entries me
WHERE me.tenant_id = $1::text
  AND me.status = ANY($2::text[])
  AND me.kind = ANY($3::text[])
  AND ($4::text[] IS NULL OR me.anchors ?| $4::text[])
  AND ${SYSTEM_INSPECTION_VISIBILITY_SQL}
  AND ($7::timestamptz IS NULL OR (me.updated_at, me.id) > ($7::timestamptz, $8::text))
ORDER BY me.updated_at ASC, me.id ASC
LIMIT $9::int
`;

export const SYSTEM_INSPECTION_MEMORY_ENTRY_SQL = `
SELECT
  me.id,
  me.kind,
  me.status,
  me.anchors,
  me.version,
  me.created_at,
  me.updated_at,
  octet_length(me.content)::int AS content_bytes
FROM memory_entries me
WHERE me.tenant_id = $1::text
  AND me.id = $2::text
  AND COALESCE(me.meta->'spaceScope'->>'space', 'meta') = ANY($3::text[])
  AND (
    COALESCE(me.meta->'spaceScope'->>'visibility', 'public') = 'public'
    OR COALESCE(me.meta->'spaceScope'->>'space', 'meta') = $4::text
  )
LIMIT 1
`;

export const SYSTEM_INSPECTION_MEMORY_SUMMARY_SQL = `
SELECT
  me.kind,
  count(*)::int AS count,
  COALESCE(sum(octet_length(me.content)), 0)::int AS bytes
FROM memory_entries me
WHERE me.tenant_id = $1::text
  AND me.status = ANY($2::text[])
  AND me.kind = ANY($3::text[])
  AND ($4::text[] IS NULL OR me.anchors ?| $4::text[])
  AND ${SYSTEM_INSPECTION_VISIBILITY_SQL}
GROUP BY me.kind
`;

export const SYSTEM_INSPECTION_MEMORY_REVISIONS_SQL = `
SELECT entry_id, revision, status, created_at, created_by, reason FROM (
  SELECT
    r.entry_id,
    r.revision,
    r.status,
    r.created_at,
    r.created_by,
    r.reason
  FROM memory_revisions r
  WHERE r.tenant_id = $1::text
    AND r.entry_id = $2::text
  UNION ALL
  SELECT
    me.id AS entry_id,
    me.version AS revision,
    me.status,
    me.updated_at AS created_at,
    NULL::text AS created_by,
    NULL::text AS reason
  FROM memory_entries me
  WHERE me.tenant_id = $1::text
    AND me.id = $2::text
) events
ORDER BY events.revision DESC, events.created_at DESC
LIMIT $3::int
`;
