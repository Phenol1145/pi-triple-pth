#!/usr/bin/env node
/**
 * seed-k5-pilot.ts —— N23 K5 + F4 评测批：双域 source registry + domain-fact seed 脚本。
 *
 * 把 PILOT_SOURCES 与 PILOT_KNOWLEDGE 落 PgMemoryStore：
 *  - sources：kind="knowledge-source"、status=official、tenant=default、
 *    id=`pilot-source:<id>`、meta 存全量 source + snapshotContent（F4 6.4）；
 *  - knowledge：kind="domain-fact"、status=official、tenant=default、
 *    meta.provenance 用 buildKnowledgeProvenance 生成（canonical），并同步写结构化
 *    meta.evidence = [{ sourceId: "pilot-source:" + id, locator }]（F4 AB-08）。
 *
 * 用法（仓库根）：
 *   DATABASE_URL=… npx tsx scripts/seed-k5-pilot.ts          # 落库（幂等：内容相同跳过）
 *   DATABASE_URL=… npx tsx scripts/seed-k5-pilot.ts --check  # 只体检：DB ≡ 生成集？
 */

import pg from "pg";
import {
  buildKnowledgeProvenance,
  contentHashOf,
  PgMemoryStore,
  validateKnowledgeEvidenceRefs,
  type KnowledgeEvidenceRef,
} from "@away_from/pth-memory";
import type { PilotKnowledgeEntry } from "../src/pth/catalog/data/pilot-knowledge.ts";
import { PILOT_KNOWLEDGE } from "../src/pth/catalog/data/pilot-knowledge.ts";
import type { PilotKnowledgeSource } from "../src/pth/catalog/data/pilot-source-registry.ts";
import { PILOT_SOURCES } from "../src/pth/catalog/data/pilot-source-registry.ts";
import { PILOT_SOURCE_SNAPSHOTS } from "../src/pth/catalog/data/pilot-source-snapshots.ts";

const SOURCE_TASK_ID = "k5-eval-seed";
const PRODUCER_ROLE = "k5-pilot-seed";
const PRODUCER_MODEL = "curated";
/** 固定 createdAt：让 seed 幂等（内容相同跳过；否则 provenance.createdAt 每次变化会触发 version 递增）。 */
const SEED_CREATED_AT = 0;

const checkOnly = process.argv.includes("--check");
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error("缺少 DATABASE_URL（compose 已配）——fail-closed 退出");
  process.exit(1);
}

function sourceContent(source: PilotKnowledgeSource): string {
  return `${source.authority} | ${source.uri}${source.version ? ` | ${source.version}` : ""}`;
}

function sourceSnapshotContent(source: PilotKnowledgeSource): string {
  return PILOT_SOURCE_SNAPSHOTS.find((snapshot) => snapshot.sourceId === source.id)?.snapshotContent ?? "";
}

function sourceEntry(source: PilotKnowledgeSource) {
  return {
    id: `pilot-source:${source.id}`,
    tenantId: "default",
    kind: "knowledge-source",
    anchors: [source.domain, source.id],
    content: sourceContent(source),
    status: "official" as const,
    // F4 6.4：source entry 的 meta.artifactHash 与 meta.snapshotContent 同步落库。
    // 注意：meta.version 由 PgMemoryStore 列联动占用，source.version 改用 sourceVersion 保留。
    meta: { ...source, sourceVersion: source.version ?? null, snapshotContent: sourceSnapshotContent(source) },
  };
}

function structuredEvidence(entry: PilotKnowledgeEntry): KnowledgeEvidenceRef[] {
  const byId = new Map(PILOT_SOURCES.map((source) => [source.id, source]));
  const refs: KnowledgeEvidenceRef[] = entry.evidence.map((evidence) => {
    const source = byId.get(evidence.sourceId);
    return {
      sourceId: `pilot-source:${evidence.sourceId}`,
      locator: evidence.locator,
      ...(source?.version !== undefined ? { sourceVersion: source.version } : {}),
      ...(source?.artifactHash !== undefined ? { artifactHash: source.artifactHash } : {}),
    };
  });
  const checked = validateKnowledgeEvidenceRefs(refs);
  if (!checked.ok) {
    throw new Error(`seed-k5-pilot: invalid structured evidence for ${entry.id}: ${checked.error}`);
  }
  return checked.refs;
}

function knowledgeEntryMeta(entry: PilotKnowledgeEntry): Record<string, unknown> {
  const provenance = buildKnowledgeProvenance({
    content: entry.content,
    sourceTaskId: SOURCE_TASK_ID,
    producerRole: PRODUCER_ROLE,
    producerModel: PRODUCER_MODEL,
    sourceRefs: entry.evidence.map((evidence) => evidence.locator),
    createdAt: SEED_CREATED_AT,
  });
  // AB-02 canonical：meta.provenance 是唯一契约位置；R5/P1-4 写结构化 meta.evidence
  // （sourceId 为 DB source row id，即 "pilot-source:" + id；含 sourceVersion + artifactHash）。
  return { provenance, evidence: structuredEvidence(entry) };
}

function knowledgeEntry(entry: PilotKnowledgeEntry) {
  return {
    id: entry.id,
    tenantId: "default",
    kind: "domain-fact",
    anchors: entry.anchors,
    content: entry.content,
    status: "official" as const,
    meta: knowledgeEntryMeta(entry),
  };
}

function arraysEqual(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

/** meta.evidence 是对象数组（jsonb 往返后引用不同——必须逐字段比较）。 */
function evidenceMatches(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((value, index) => {
    const other = b[index];
    if (typeof value !== "object" || value === null || typeof other !== "object" || other === null) return false;
    const v = value as Record<string, unknown>;
    const o = other as Record<string, unknown>;
    return v["sourceId"] === o["sourceId"]
      && v["locator"] === o["locator"]
      && (v["sourceVersion"] ?? undefined) === (o["sourceVersion"] ?? undefined)
      && (v["artifactHash"] ?? undefined) === (o["artifactHash"] ?? undefined)
      && (v["quoteHash"] ?? undefined) === (o["quoteHash"] ?? undefined);
  });
}

function sourceMetaMatches(meta: unknown, source: PilotKnowledgeSource): boolean {
  if (typeof meta !== "object" || meta === null) return false;
  const m = meta as Record<string, unknown>;
  return m.id === source.id
    && m.domain === source.domain
    && m.authority === source.authority
    && m.uri === source.uri
    && (m.sourceVersion ?? undefined) === (source.version ?? undefined)
    && m.retrievedAt === source.retrievedAt
    && (m.license ?? undefined) === (source.license ?? undefined)
    && m.registryFingerprint === source.registryFingerprint
    && m.artifactHash === source.artifactHash
    && m.snapshotContent === sourceSnapshotContent(source);
}

function knowledgeMetaMatches(meta: unknown, entry: PilotKnowledgeEntry): boolean {
  if (typeof meta !== "object" || meta === null) return false;
  const m = meta as Record<string, unknown>;
  const provenance = m["provenance"];
  if (typeof provenance !== "object" || provenance === null) return false;
  const p = provenance as Record<string, unknown>;
  const evidence = m["evidence"];
  const expectedEvidence = structuredEvidence(entry);
  return p.sourceTaskId === SOURCE_TASK_ID
    && p.producerRole === PRODUCER_ROLE
    && p.producerModel === PRODUCER_MODEL
    && p.createdAt === SEED_CREATED_AT
    && p.contentHash === contentHashOf(entry.content)
    && arraysEqual(p.sourceRefs, entry.evidence.map((evidence) => evidence.locator))
    && evidenceMatches(evidence, expectedEvidence);
}

function sourceRowsMatch(row: Record<string, unknown>, source: PilotKnowledgeSource): boolean {
  return row.kind === "knowledge-source"
    && row.status === "official"
    && row.content === sourceContent(source)
    && sourceMetaMatches(row.meta, source);
}

function knowledgeRowsMatch(row: Record<string, unknown>, entry: PilotKnowledgeEntry): boolean {
  return row.kind === "domain-fact"
    && row.status === "official"
    && row.content === entry.content
    && arraysEqual(row.anchors, entry.anchors)
    && knowledgeMetaMatches(row.meta, entry);
}

async function runCheck(pool: pg.Pool): Promise<number> {
  const expectedSources = new Map(PILOT_SOURCES.map((source) => [`pilot-source:${source.id}`, source]));
  const expectedKnowledge = new Map(PILOT_KNOWLEDGE.map((entry) => [entry.id, entry]));

  const { rows } = await pool.query(
    `SELECT id, kind, status, content, anchors, meta
       FROM memory_entries
      WHERE id LIKE 'pilot-source:%' OR id LIKE 'pl-fact-%' OR id LIKE 'ms-fact-%'
      ORDER BY id`,
  );

  const byId = new Map(rows.map((row) => [row.id as string, row]));
  const issues: string[] = [];

  for (const [id, source] of expectedSources) {
    const row = byId.get(id);
    if (!row) {
      issues.push(`DB 缺条目：${id}`);
      continue;
    }
    if (!sourceRowsMatch(row as Record<string, unknown>, source)) {
      issues.push(`DB 条目漂移：${id}（重跑本脚本对齐）`);
    }
  }
  for (const [id, entry] of expectedKnowledge) {
    const row = byId.get(id);
    if (!row) {
      issues.push(`DB 缺条目：${id}`);
      continue;
    }
    if (!knowledgeRowsMatch(row as Record<string, unknown>, entry)) {
      issues.push(`DB 条目漂移：${id}（重跑本脚本对齐）`);
    }
  }
  for (const id of byId.keys()) {
    if (!expectedSources.has(id) && !expectedKnowledge.has(id)) {
      issues.push(`DB 多条目：${id}（生成集已无——按治理流退役）`);
    }
  }

  await pool.end();
  if (issues.length > 0) {
    console.error("DB ⇄ 生成集对账不通过：\n - " + issues.join("\n - "));
    return 1;
  }
  console.log(`--check 通过：DB ${rows.length} 条 ≡ 生成集 ${expectedSources.size + expectedKnowledge.size} 条`);
  return 0;
}

async function runSeed(pool: pg.Pool): Promise<number> {
  const store = new PgMemoryStore(pool);
  let written = 0;
  let skipped = 0;
  let failed = 0;

  for (const source of PILOT_SOURCES) {
    const row = sourceEntry(source);
    try {
      const { rows } = await pool.query(
        "SELECT kind, status, content, meta FROM memory_entries WHERE id = $1",
        [row.id],
      );
      const existing = rows[0] as Record<string, unknown> | undefined;
      if (existing && sourceRowsMatch(existing, source)) {
        skipped += 1;
        continue;
      }
      await store.write(row);
      written += 1;
    } catch (error) {
      failed += 1;
      console.error("写入失败 " + row.id + ": " + (error instanceof Error ? error.message : String(error)));
    }
  }

  for (const entry of PILOT_KNOWLEDGE) {
    const row = knowledgeEntry(entry);
    try {
      const { rows } = await pool.query(
        "SELECT kind, status, content, anchors, meta FROM memory_entries WHERE id = $1",
        [row.id],
      );
      const existing = rows[0] as Record<string, unknown> | undefined;
      if (existing && knowledgeRowsMatch(existing, entry)) {
        skipped += 1;
        continue;
      }
      // N29 P0-4：official 领域知识（domain-fact）只能由与 worker capability 分离的内部
      // seed/migration authority 直写；worker/service/模板路径一律 draft，official 由
      // Promotion Service 的 promoteOfficial() 晋升。
      await store.write(row, { knowledgeOfficialAuthority: "seed-migration" });
      written += 1;
    } catch (error) {
      failed += 1;
      console.error("写入失败 " + row.id + ": " + (error instanceof Error ? error.message : String(error)));
    }
  }

  await pool.end();
  console.log(`完成：写入 ${written} · 跳过（未变更） ${skipped} · 失败 ${failed} · 共 ${PILOT_SOURCES.length + PILOT_KNOWLEDGE.length}`);
  return failed > 0 ? 1 : 0;
}

const pool = new pg.Pool({ connectionString: dbUrl, max: 2 });
const exitCode = checkOnly ? await runCheck(pool) : await runSeed(pool);
process.exit(exitCode);
