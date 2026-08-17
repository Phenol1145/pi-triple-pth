#!/usr/bin/env node
/**
 * eval-k5-pilot.ts —— N23 K5 评测批：离线/在线双域冻结查询评测 CLI。
 *
 * 用法（仓库根）：
 *   npx tsx scripts/eval-k5-pilot.ts           # 离线（内存 knowledge）跑 runPilotEval
 *   DATABASE_URL=… npx tsx scripts/eval-k5-pilot.ts --live
 *                                               # 从 PgMemoryStore 按 K3 provider 规则检索后计算同样指标
 *
 * 退出码：domainRecallAt3 ≥ 0.9 且 knowledgeRecallAt5 ≥ 0.9 且 evidenceCoverage ≥ 0.95 → 0；否则 1。
 */

import pg from "pg";
import { PgMemoryStore } from "@away_from/pth-memory";
import { createDisciplineResolver } from "../src/pth/catalog/discipline-resolver.ts";
import { buildPilotCatalog } from "../src/pth/catalog/data/pilot-domain-overrides.ts";
import type { PilotKnowledgeEntry } from "../src/pth/catalog/data/pilot-knowledge.ts";
import { PILOT_KNOWLEDGE } from "../src/pth/catalog/data/pilot-knowledge.ts";
import { PILOT_EVAL_QUERIES } from "../src/pth/catalog/data/pilot-eval-queries.ts";
import { PILOT_SOURCES } from "../src/pth/catalog/data/pilot-source-registry.ts";
import {
  evaluatePilotQuery,
  runPilotEval,
  type PilotEvalMetrics,
} from "../src/pth/catalog/pilot-evaluator.ts";
import { KNOWLEDGE_CONTEXT_KINDS } from "../src/pth/runner/knowledge-context.ts";

const DOMAIN_RECALL_THRESHOLD = 0.9;
const KNOWLEDGE_RECALL_THRESHOLD = 0.9;
const EVIDENCE_COVERAGE_THRESHOLD = 0.95;

function printMetrics(label: string, metrics: PilotEvalMetrics): void {
  console.log(`\n== ${label} ==`);
  console.log(`queryCount        : ${metrics.queryCount}`);
  console.log(`domainRecallAt3   : ${metrics.domainRecallAt3.toFixed(4)}  (threshold ≥ ${DOMAIN_RECALL_THRESHOLD})`);
  console.log(`domainTop1        : ${metrics.domainTop1.toFixed(4)}`);
  console.log(`knowledgeRecallAt5: ${metrics.knowledgeRecallAt5.toFixed(4)}  (threshold ≥ ${KNOWLEDGE_RECALL_THRESHOLD})`);
  console.log(`evidenceCoverage  : ${metrics.evidenceCoverage.toFixed(4)}  (threshold ≥ ${EVIDENCE_COVERAGE_THRESHOLD})`);

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
    && metrics.evidenceCoverage >= EVIDENCE_COVERAGE_THRESHOLD;
}

function runOffline(): PilotEvalMetrics {
  const catalog = buildPilotCatalog();
  return runPilotEval({
    catalog,
    knowledge: PILOT_KNOWLEDGE,
    queries: PILOT_EVAL_QUERIES,
    sources: PILOT_SOURCES,
  });
}

async function runLive(pool: pg.Pool): Promise<PilotEvalMetrics> {
  const catalog = buildPilotCatalog();
  const resolver = createDisciplineResolver(catalog);
  const store = new PgMemoryStore(pool);
  const sourceIds = new Set(PILOT_SOURCES.map((source) => source.id));
  const offlineById = new Map(PILOT_KNOWLEDGE.map((entry) => [entry.id, entry]));

  function toKnowledge(row: {
    id: string;
    anchors: string[];
    content: string;
  }): PilotKnowledgeEntry {
    const offline = offlineById.get(row.id);
    const domain = offline?.domain
      ?? row.anchors.find((anchor) => anchor === "programming-languages" || anchor === "materials-science")
      ?? "";
    return {
      id: row.id,
      domain,
      kind: "domain-fact",
      anchors: row.anchors,
      content: row.content,
      // evidence.sourceId 不落 DB（provenance.sourceRefs 只有 locator），
      // 已知 pilot 条目用离线 registry 回填；未知条目 evidence 为空。
      evidence: offline?.evidence ?? [],
    };
  }

  let domainTop3Hits = 0;
  let domainTop1Hits = 0;
  let knowledgeHits = 0;
  let evidenceHits = 0;
  let authoritativeCount = 0;
  const details: PilotEvalMetrics["details"] = [];

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
          kinds: [...KNOWLEDGE_CONTEXT_KINDS],
          status: ["official"],
        })
      : [];
    const knowledge = rows.map(toKnowledge);
    const result = evaluatePilotQuery({ catalog, knowledge, query, sourceIds });

    if (result.domainInTop3) domainTop3Hits += 1;
    if (result.domainTop1) domainTop1Hits += 1;
    if (result.knowledgePass) knowledgeHits += 1;
    if (result.authoritative && result.evidencePass) evidenceHits += 1;
    if (result.authoritative) authoritativeCount += 1;
    details.push(result.detail);
  }

  const queryCount = PILOT_EVAL_QUERIES.length;
  return {
    domainRecallAt3: queryCount === 0 ? 0 : domainTop3Hits / queryCount,
    domainTop1: queryCount === 0 ? 0 : domainTop1Hits / queryCount,
    knowledgeRecallAt5: queryCount === 0 ? 0 : knowledgeHits / queryCount,
    evidenceCoverage: authoritativeCount === 0 ? 1 : evidenceHits / authoritativeCount,
    queryCount,
    details,
  };
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
      console.error("\n阈值未达标：domainRecallAt3≥0.9 且 knowledgeRecallAt5≥0.9 且 evidenceCoverage≥0.95");
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
    console.error("\n阈值未达标：domainRecallAt3≥0.9 且 knowledgeRecallAt5≥0.9 且 evidenceCoverage≥0.95");
    process.exit(1);
  }
  process.exit(0);
}
