#!/usr/bin/env node
/**
 * eval-k5-pilot.ts —— N23 K5 + F4 + R5 评测 CLI。
 *
 * 用法（仓库根）：
 *   npx tsx scripts/eval/eval-k5-pilot.ts              # 离线（生产端口 + 离线知识）
 *   DATABASE_URL=… npx tsx scripts/eval/eval-k5-pilot.ts --live
 *                                                 # 从真实 PG（PgMemoryStore）按生产端口评测
 *
 * R5 退出码：
 *   domainRecallAt3 ≥ 0.9 且 knowledgeRecallAt5 ≥ 0.9 且 evidenceCoverage ≥ 0.95 且
 *   hardNegativePassRate ≥ 0.95 且 noAnswerAbstention ≥ 0.95 且 mutationScore ≥ 0.9
 *   （coveredEntries 必须 = 24/24）→ 0；否则 1。
 */

import pg from "pg";
import { isVisible, PgMemoryStore } from "@away_from/pth-memory";
import { DisciplineCatalogBuilder } from "../../src/pth/catalog/discipline-catalog.ts";
import { createDisciplineResolver } from "../../src/pth/catalog/discipline-resolver.ts";
import { DISCIPLINE_DEFINITIONS } from "../../src/pth/catalog/data/discipline-catalog-data.ts";
import { PILOT_KNOWLEDGE } from "../../src/pth/catalog/data/pilot-knowledge.ts";
import { PILOT_EVAL_QUERIES } from "../../src/pth/catalog/data/pilot-eval-queries.ts";
import { PILOT_SOURCES } from "../../src/pth/catalog/data/pilot-source-registry.ts";
import {
  runMutationEval,
  runPilotEval,
  runPilotEvalWithPort,
  type MutationEvalReport,
  type PilotEvalMetrics,
  type PilotEvalProductionPort,
  type PilotSourceSnapshotIntegrity,
} from "../../src/pth/catalog/pilot-evaluator.ts";
import {
  createExecutionGrantService,
  createHmacGrantKeyProvider,
  createKnowledgeBroker,
} from "../../src/pth/execution/index.ts";
import { createKnowledgeContextProvider } from "../../src/pth/runner/index.ts";


const DOMAIN_RECALL_THRESHOLD = 0.9;
const KNOWLEDGE_RECALL_THRESHOLD = 0.9;
const EVIDENCE_COVERAGE_THRESHOLD = 0.95;
const HARD_NEGATIVE_THRESHOLD = 0.95;
const NO_ANSWER_THRESHOLD = 0.95;
const MUTATION_SCORE_THRESHOLD = 0.9;

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
  console.log(`hardNegativePassRate : ${metrics.hardNegativePassRate.toFixed(4)}  (threshold ≥ ${HARD_NEGATIVE_THRESHOLD})`);
  console.log(`noAnswerAbstention   : ${metrics.noAnswerAbstention.toFixed(4)}  (threshold ≥ ${NO_ANSWER_THRESHOLD})`);
  console.log(`multiDomainResolution: ${metrics.multiDomainResolution.toFixed(4)}`);
  console.log(`distractorTop3Rate   : ${metrics.distractorTop3Rate.toFixed(4)}`);
  console.log(`coveredEntries       : ${metrics.coveredEntries}/24  [${metrics.coveredEntryIds.join(", ")}]`);
  console.log(`holdoutQueryCount    : ${metrics.holdoutQueryCount}  passRate=${metrics.holdoutPassRate.toFixed(4)}`);
  console.log(`holdoutDigest        : ${metrics.holdoutDigest}`);
  console.log(`queryTypeCounts      : ${JSON.stringify(metrics.queryTypeCounts)}`);

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

function printMutation(report: MutationEvalReport): void {
  console.log(`\n== mutation 反事实报告 ==`);
  console.log(`mutationScore : ${report.mutationScore.toFixed(4)}  (threshold ≥ ${MUTATION_SCORE_THRESHOLD})`);
  console.log(`detected      : ${report.detectedMutations}/${report.totalMutations}`);
  for (const row of report.rows) {
    const flags = [
      row.removeDetected ? "remove:detected" : "remove:NOT-DETECTED",
      row.evidenceDetected ? "evidence:detected" : "evidence:NOT-DETECTED",
    ].join(" ");
    console.log(`  ${row.entryId.padEnd(34)} ${flags}  (baselinePass=${row.baselinePass}, removePass=${row.removePass}, evidencePass=${row.evidencePassRate})`);
  }
}

function metricsPass(metrics: PilotEvalMetrics): boolean {
  return metrics.domainRecallAt3 >= DOMAIN_RECALL_THRESHOLD
    && metrics.knowledgeRecallAt5 >= KNOWLEDGE_RECALL_THRESHOLD
    && metrics.evidenceCoverage >= EVIDENCE_COVERAGE_THRESHOLD
    && metrics.hardNegativePassRate >= HARD_NEGATIVE_THRESHOLD
    && metrics.noAnswerAbstention >= NO_ANSWER_THRESHOLD
    && metrics.coveredEntries === 24;
}

function thresholdMessage(): string {
  return "domainRecallAt3≥0.9 且 knowledgeRecallAt5≥0.9 且 evidenceCoverage≥0.95 且 "
    + "hardNegativePassRate≥0.95 且 noAnswerAbstention≥0.95 且 mutationScore≥0.9 且 coveredEntries=24/24";
}

async function runOffline(): Promise<{ metrics: PilotEvalMetrics; mutation: MutationEvalReport }> {
  const catalog = buildProductionCatalog();
  const metrics = await runPilotEval({
    catalog,
    knowledge: PILOT_KNOWLEDGE,
    queries: PILOT_EVAL_QUERIES,
    sources: PILOT_SOURCES,
  });
  const mutation = await runMutationEval({
    catalog,
    knowledge: PILOT_KNOWLEDGE,
    queries: PILOT_EVAL_QUERIES,
    sources: PILOT_SOURCES,
  });
  return { metrics, mutation };
}

async function loadLiveSourceIndex(pool: pg.Pool): Promise<{
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
  const store = new PgMemoryStore(pool);
  const memory = {
    retrieve: (opts: { anchors?: string[]; kinds?: string[]; status?: string[]; tenantId?: string }) => store.retrieve(opts),
    get: (id: string, opts?: { tenantId?: string }) => store.get(id, opts),
  };
  const grantService = createExecutionGrantService({
    keyProvider: createHmacGrantKeyProvider({ secret: "pilot-eval-r5-live-secret-0123456789" }),
    clock: () => new Date(),
  });
  const broker = createKnowledgeBroker({
    grantService,
    dataWorld: {
      queryReadOnly: async () => [],
      memory,
    },
    isVisible: (meta, space) => isVisible(meta, space),
  });
  const port: PilotEvalProductionPort = {
    resolver: createDisciplineResolver(catalog),
    contextProvider: createKnowledgeContextProvider({
      catalog,
      memory,
      isVisible: (meta, space) => isVisible(meta, space),
    }),
    broker,
  };
  const { sourceIds, sourceSnapshots } = await loadLiveSourceIndex(pool);
  return runPilotEvalWithPort({
    port,
    queries: PILOT_EVAL_QUERIES,
    sourceIds,
    sourceSnapshots,
  });
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
    const offline = await runOffline();
    printMutation(offline.mutation);
    if (!metricsPass(metrics) || offline.mutation.mutationScore < MUTATION_SCORE_THRESHOLD) {
      console.error(`\n阈值未达标：${thresholdMessage()}`);
      process.exit(1);
    }
    process.exit(0);
  } finally {
    await pool.end();
  }
} else {
  const { metrics, mutation } = await runOffline();
  printMetrics("K5 pilot eval (offline, production port)", metrics);
  printMutation(mutation);
  if (!metricsPass(metrics) || mutation.mutationScore < MUTATION_SCORE_THRESHOLD) {
    console.error(`\n阈值未达标：${thresholdMessage()}`);
    process.exit(1);
  }
  process.exit(0);
}
