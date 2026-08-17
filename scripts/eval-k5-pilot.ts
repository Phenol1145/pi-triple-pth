#!/usr/bin/env node
/**
 * eval-k5-pilot.ts —— N23 K5 + F4 评测批：离线/在线双域冻结查询评测 CLI。
 *
 * 用法（仓库根）：
 *   npx tsx scripts/eval-k5-pilot.ts           # 离线（内存 knowledge）跑 runPilotEval
 *   DATABASE_URL=… npx tsx scripts/eval-k5-pilot.ts --live
 *                                               # 从 PgMemoryStore 按生产路径检索后计算同样指标
 *
 * F4 退出码：
 *   domainRecallAt3 ≥ 0.9 且 knowledgeRecallAt5 ≥ 0.9 且 evidenceCoverage ≥ 0.95 且
 *   hardNegativePassRate = 1.0 且 multiDomainResolution = 1.0 且 distractorTop3Rate ≥ 0.9 → 0；否则 1。
 */

import pg from "pg";
import { PgMemoryStore } from "@away_from/pth-memory";
import { DisciplineCatalogBuilder } from "../src/pth/catalog/discipline-catalog.ts";
import { createDisciplineResolver } from "../src/pth/catalog/discipline-resolver.ts";
import { DISCIPLINE_DEFINITIONS } from "../src/pth/catalog/data/discipline-catalog-data.ts";
import type { PilotKnowledgeEntry } from "../src/pth/catalog/data/pilot-knowledge.ts";
import { PILOT_KNOWLEDGE } from "../src/pth/catalog/data/pilot-knowledge.ts";
import { PILOT_EVAL_QUERIES } from "../src/pth/catalog/data/pilot-eval-queries.ts";
import { PILOT_SOURCES } from "../src/pth/catalog/data/pilot-source-registry.ts";
import {
  aggregatePilotMetrics,
  evaluatePilotQuery,
  runPilotEval,
  type PilotEvalMetrics,
  type PilotSourceSnapshotIntegrity,
} from "../src/pth/catalog/pilot-evaluator.ts";


const DOMAIN_RECALL_THRESHOLD = 0.9;
const KNOWLEDGE_RECALL_THRESHOLD = 0.9;
const EVIDENCE_COVERAGE_THRESHOLD = 0.95;
const HARD_NEGATIVE_THRESHOLD = 1.0;
const MULTI_DOMAIN_THRESHOLD = 1.0;
const DISTRACTOR_TOP3_THRESHOLD = 0.9;

const PILOT_DOMAIN_IDS = new Set(["programming-languages", "materials-science"]);

function buildProductionCatalog() {
  const builder = new DisciplineCatalogBuilder();
  for (const def of DISCIPLINE_DEFINITIONS) builder.add(def);
  return builder.build();
}

function printMetrics(label: string, metrics: PilotEvalMetrics): void {
  console.log(`\n== ${label} ==`);
  console.log(`queryCount           : ${metrics.queryCount}`);
  console.log(`standardQueryCount   : ${metrics.standardQueryCount}`);
  console.log(`domainRecallAt3      : ${metrics.domainRecallAt3.toFixed(4)}  (threshold ≥ ${DOMAIN_RECALL_THRESHOLD})`);
  console.log(`domainTop1           : ${metrics.domainTop1.toFixed(4)}`);
  console.log(`knowledgeRecallAt5   : ${metrics.knowledgeRecallAt5.toFixed(4)}  (threshold ≥ ${KNOWLEDGE_RECALL_THRESHOLD})`);
  console.log(`evidenceCoverage     : ${metrics.evidenceCoverage.toFixed(4)}  (threshold ≥ ${EVIDENCE_COVERAGE_THRESHOLD})`);
  console.log(`hardNegativePassRate : ${metrics.hardNegativePassRate.toFixed(4)}  (threshold = ${HARD_NEGATIVE_THRESHOLD})`);
  console.log(`multiDomainResolution: ${metrics.multiDomainResolution.toFixed(4)}  (threshold = ${MULTI_DOMAIN_THRESHOLD})`);
  console.log(`distractorTop3Rate   : ${metrics.distractorTop3Rate.toFixed(4)}  (threshold ≥ ${DISTRACTOR_TOP3_THRESHOLD})`);

  const failed = metrics.details.filter((detail) => !detail.pass);
  if (failed.length > 0) {
    console.log(`\n-- 未通过明细（${failed.length} 条）--`);
    for (const detail of failed) {
      console.log(`  ✗ ${detail.queryId} [${detail.domain}] ${detail.reason ?? ""}`);
    }
  } else {
    console.log("\n-- 全部查询通过 --");
  }
}

function metricsPass(metrics: PilotEvalMetrics): boolean {
  return metrics.domainRecallAt3 >= DOMAIN_RECALL_THRESHOLD
    && metrics.knowledgeRecallAt5 >= KNOWLEDGE_RECALL_THRESHOLD
    && metrics.evidenceCoverage >= EVIDENCE_COVERAGE_THRESHOLD
    && metrics.hardNegativePassRate === HARD_NEGATIVE_THRESHOLD
    && metrics.multiDomainResolution === MULTI_DOMAIN_THRESHOLD
    && metrics.distractorTop3Rate >= DISTRACTOR_TOP3_THRESHOLD;
}

function thresholdMessage(): string {
  return "domainRecallAt3≥0.9 且 knowledgeRecallAt5≥0.9 且 evidenceCoverage≥0.95 且 "
    + "hardNegativePassRate=1.0 且 multiDomainResolution=1.0 且 distractorTop3Rate≥0.9";
}

function runOffline(): PilotEvalMetrics {
  const catalog = buildProductionCatalog();
  return runPilotEval({
    catalog,
    knowledge: PILOT_KNOWLEDGE,
    queries: PILOT_EVAL_QUERIES,
    sources: PILOT_SOURCES,
  });
}

interface LiveMemoryRow {
  id: string;
  kind: string;
  anchors: string[];
  status: string;
  content: string;
  meta?: Record<string, unknown>;
}

/** live：只读 DB meta.evidence，禁止离线回填；缺字段即 evidence 为空 → authoritative fail-closed。 */
function toKnowledge(row: LiveMemoryRow): PilotKnowledgeEntry {
  const domain = row.anchors.find((anchor) => PILOT_DOMAIN_IDS.has(anchor)) ?? "";
  const meta = (row.meta ?? {}) as Record<string, unknown>;
  const rawEvidence = meta["evidence"];
  let evidence: PilotKnowledgeEntry["evidence"] = [];
  if (Array.isArray(rawEvidence)) {
    evidence = rawEvidence.flatMap((item) => {
      if (typeof item !== "object" || item === null) return [];
      const record = item as Record<string, unknown>;
      const sourceId = record["sourceId"];
      const locator = record["locator"];
      if (typeof sourceId === "string" && sourceId.length > 0 && typeof locator === "string" && locator.length > 0) {
        return [{ sourceId, locator }];
      }
      return [];
    });
  }
  return {
    id: row.id,
    domain,
    kind: "domain-fact",
    anchors: row.anchors,
    content: row.content,
    evidence,
  };
}

async function loadLiveSources(pool: pg.Pool): Promise<{
  sourceIds: Set<string>;
  sourceSnapshots: Map<string, PilotSourceSnapshotIntegrity>;
}> {
  const { rows } = await pool.query<{ id: string; meta: Record<string, unknown> | null }>(
    `SELECT id, meta FROM memory_entries WHERE id LIKE 'pilot-source:%' ORDER BY id`,
  );
  const sourceIds = new Set<string>();
  const sourceSnapshots = new Map<string, PilotSourceSnapshotIntegrity>();
  for (const row of rows) {
    sourceIds.add(row.id);
    const meta = (row.meta ?? {}) as Record<string, unknown>;
    const artifactHash = typeof meta["artifactHash"] === "string" ? meta["artifactHash"] : "";
    const snapshotContent = typeof meta["snapshotContent"] === "string" ? meta["snapshotContent"] : "";
    sourceSnapshots.set(row.id, { artifactHash, snapshotContent });
  }
  return { sourceIds, sourceSnapshots };
}

async function runLive(pool: pg.Pool): Promise<PilotEvalMetrics> {
  const catalog = buildProductionCatalog();
  const resolver = createDisciplineResolver(catalog);
  const store = new PgMemoryStore(pool);
  const { sourceIds, sourceSnapshots } = await loadLiveSources(pool);

  const results = [];
  for (const query of PILOT_EVAL_QUERIES) {
    const resolved = resolver.resolve({
      title: query.text.slice(0, 80),
      text: query.text,
      tags: [],
      explicitDomains: [],
    });
    const domains = resolved.ok
      ? resolved.binding.matches.map((match) => match.domainId)
      : [];

    const rows = domains.length > 0
      ? await store.retrieve({
          anchors: domains,
          // 冻结查询集评估的是 domain-fact 知识（离线 PILOT_KNOWLEDGE 全为 domain-fact）；
          // 收窄 kind 避免生产库中 task-insight/skill 等非评测条目污染 top-5。
          kinds: ["domain-fact"],
          status: ["official"],
        })
      : [];
    const knowledge = rows.map((row) => toKnowledge(row as LiveMemoryRow));
    results.push(evaluatePilotQuery({ catalog, knowledge, query, sourceIds, sourceSnapshots }));
  }

  return aggregatePilotMetrics(PILOT_EVAL_QUERIES, results);
}

const live = process.argv.includes("--live");

if (live) {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("--live 需要 DATABASE_URL（fail-closed 退出）");
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString: dbUrl, max: 2 });
  try {
    const metrics = await runLive(pool);
    printMetrics("K5 pilot eval (live, PgMemoryStore)", metrics);
    if (!metricsPass(metrics)) {
      console.error(`\n阈值未达标：${thresholdMessage()}`);
      process.exit(1);
    }
    process.exit(0);
  } finally {
    await pool.end();
  }
} else {
  const metrics = runOffline();
  printMetrics("K5 pilot eval (offline, in-memory)", metrics);
  if (!metricsPass(metrics)) {
    console.error(`\n阈值未达标：${thresholdMessage()}`);
    process.exit(1);
  }
  process.exit(0);
}
