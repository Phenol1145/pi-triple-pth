#!/usr/bin/env node
/**
 * seed-k5-pilot.ts —— N23 K5 评测批：双域 source registry + domain-fact seed 脚本。
 *
 * 把 PILOT_SOURCES 与 PILOT_KNOWLEDGE 落 PgMemoryStore：
 *  - sources：kind="knowledge-source"、status=official、tenant=default、
 *    id=`pilot-source:<id>`、meta 存全量 source；
 *  - knowledge：kind="domain-fact"、status=official、tenant=default、
 *    meta.provenance 用 buildKnowledgeProvenance 生成（sourceTaskId=k5-eval-seed、
 *    producerRole=k5-pilot-seed、producerModel=curated、sourceRefs=evidence locators）。
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
} from "@away_from/pth-memory";
import type { PilotKnowledgeEntry } from "../src/pth/catalog/data/pilot-knowledge.ts";
import { PILOT_KNOWLEDGE } from "../src/pth/catalog/data/pilot-knowledge.ts";
import type { PilotKnowledgeSource } from "../src/pth/catalog/data/pilot-source-registry.ts";
import { PILOT_SOURCES } from "../src/pth/catalog/data/pilot-source-registry.ts";

const SOURCE_TASK_ID = "k5-eval-seed";
const PRODUCER_ROLE = "k5-pilot-seed";
const PRODUCER_MODEL = "curated";

const checkOnly = process.argv.includes("--check");
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error("缺少 DATABASE_URL（compose 已配）——fail-closed 退出");
  process.exit(1);
}

function sourceContent(source: PilotKnowledgeSource): string {
  return `${source.authority} | ${source.uri}${source.version ? ` | ${source.version}` : ""}`;
}

function sourceEntry(source: PilotKnowledgeSource) {
  return {
    id: `pilot-source:${source.id}`,
    tenantId: "default",
    kind: "knowledge-source",
    anchors: [source.domain, source.id],
    content: sourceContent(source),
    status: "official" as const,
    meta: { ...source },
  };
}

function knowledgeEntryMeta(entry: PilotKnowledgeEntry): Record<string, unknown> {
  const provenance = buildKnowledgeProvenance({
    content: entry.content,
    sourceTaskId: SOURCE_TASK_ID,
    producerRole: PRODUCER_ROLE,
    producerModel: PRODUCER_MODEL,
    sourceRefs: entry.evidence.map((evidence) => evidence.locator),
  });
  // N23 契约：meta.provenance 为六字段 provenance；
  // PgMemoryStore.write 对 official domain-fact 的门禁校验 meta 顶层六字段，
  // 因此同时平铺同一份 provenance（保持门禁兼容，meta.provenance 仍为唯一契约读取位）。
  return { ...provenance, provenance };
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

function sourceMetaMatches(meta: unknown, source: PilotKnowledgeSource): boolean {
  if (typeof meta !== "object" || meta === null) return false;
  const m = meta as Record<string, unknown>;
  return m.id === source.id
    && m.domain === source.domain
    && m.authority === source.authority
    && m.uri === source.uri
    && (m.version ?? undefined) === (source.version ?? undefined)
    && m.retrievedAt === source.retrievedAt
    && (m.license ?? undefined) === (source.license ?? undefined)
    && m.contentHash === source.contentHash;
}

function knowledgeMetaMatches(meta: unknown, entry: PilotKnowledgeEntry): boolean {
  if (typeof meta !== "object" || meta === null) return false;
  const provenance = (meta as Record<string, unknown>)["provenance"];
  if (typeof provenance !== "object" || provenance === null) return false;
  const p = provenance as Record<string, unknown>;
  return p.sourceTaskId === SOURCE_TASK_ID
    && p.producerRole === PRODUCER_ROLE
    && p.producerModel === PRODUCER_MODEL
    && typeof p.createdAt === "number"
    && p.contentHash === contentHashOf(entry.content)
    && arraysEqual(p.sourceRefs, entry.evidence.map((evidence) => evidence.locator));
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
      await store.write(row);
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
