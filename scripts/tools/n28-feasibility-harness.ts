/**
 * scripts/tools/n28-feasibility-harness.ts —— N28 可行性 in-memory 公共装配（T6/T7 共用）。
 *
 * 垂直测试与 T7 evaluator 都从这里取同一生产组合：MemoryDirectory、layered retriever、
 * KnowledgeContextProvider、KnowledgeBroker、verified-scope authority、AuthorizedTaskReadFactory、
 * CognitiveWorkingSetProvider、真实 AgentTaskRunner/runAgentTask。仅 LLM 输出用确定性 stub。
 */

import type { LlmFn } from "@away_from/pth-kernel-interpreter";
import type { WorkerKernel } from "@away_from/pth-kernel-interpreter";
import type { TaskLease, TaskWorkItem } from "@away_from/pth-contracts";
import { createExecutionGrantService } from "../../src/pth/execution/authorization/execution-grant-service.js";
import { createHmacGrantKeyProvider } from "../../src/pth/execution/authorization/grant-key-provider.js";
import { createVerifiedTaskReadScopeFactory, type VerifiedTaskReadScope } from "../../src/pth/execution/authorization/verified-task-read-scope.js";
import { buildMemoryDirectorySnapshot, regionEntryIds, type DirectoryEntryInput, type MemoryDirectorySnapshot } from "../../src/pth/execution/memory-directory.js";
import { createLayeredKnowledgeRetriever, type LayeredSearchWaveInput, type LayeredSearchWaveResult } from "../../src/pth/execution/layered-knowledge-retriever.js";
import { createKnowledgeBroker, type KnowledgeBroker, type KnowledgeMemoryEntry } from "../../src/pth/execution/knowledge-broker.js";
import { filterKnowledgeEntriesByQueryText, rankKnowledgeEntries } from "../../src/pth/execution/knowledge-ranking.js";
import { createKnowledgeContextProvider } from "../../src/pth/runner/knowledge-context.js";
import { createAuthorizedStateReadPort } from "../../src/pth/runner/authorized-state-reads.js";
import { createAuthorizedTaskReadFactory, createScopedSkillPort, expandTaskReadGrantCapabilities } from "../../src/pth/runner/authorized-task-reads.js";
import { createCognitiveWorkingSetProvider } from "../../src/pth/runner/cognitive-working-set.js";
import { AgentTaskRunner, type AgentTaskRunnerDeps } from "../../src/pth/runner/agent-task-runner.js";
import { N28_FEASIBILITY_BUDGET } from "@away_from/pth-contracts";
import {
  N28_DOMAIN_IDS, N28_REGIONS, N28_REGIONS as REGIONS, N28_RESPONSIBILITIES, N28_ROLE,
  N28_ROLE_LOAD_POLICIES, N28_WORKERS, n28AuthorizedCorpus, n28DirectoryInputs,
  type N28KnowledgeEntry,
} from "./n28-feasibility-fixture.js";

export interface N28VerticalObservation {
  outcome: import("@away_from/pth-contracts").TaskOutcome;
  toolsByTurn: string[][];
  systemPrompt: string;
  traces: Array<{ type: string; phase?: string; toolNames?: string[]; directorySnapshotId?: string; retrievalTraceIds?: string[] }>;
  usage: Readonly<Record<string, number>> | undefined;
}

export interface N28InMemoryBundle {
  directory: MemoryDirectorySnapshot;
  directoryEntries: readonly DirectoryEntryInput[];
  corpus: readonly N28KnowledgeEntry[];
  broker: KnowledgeBroker;
  grantService: ReturnType<typeof createExecutionGrantService>;
  clock: () => Date;
  runTask(input: { workerKey: keyof typeof N28_WORKERS; taskText: string; taskTitle?: string }): Promise<N28VerticalObservation>;
}

export function createN28InMemoryBundle(): N28InMemoryBundle {
  const clock = () => new Date("2030-01-01T00:00:00.000Z");
  const grantService = createExecutionGrantService({
    keyProvider: createHmacGrantKeyProvider({ secret: "n28-feasibility-harness-secret-0123456789" }),
    clock,
  });

  const corpus = n28AuthorizedCorpus();
  const directoryEntries = n28DirectoryInputs(corpus);
  const directory = buildMemoryDirectorySnapshot({
    tenantId: "tenant-a", epoch: 1, knownDomainIds: N28_DOMAIN_IDS,
    workers: Object.values(N28_WORKERS), regions: REGIONS, responsibilities: N28_RESPONSIBILITIES,
    entries: directoryEntries,
  });
  const retriever = createLayeredKnowledgeRetriever<KnowledgeMemoryEntry>(directory, {
    knownDomainIds: N28_DOMAIN_IDS,
    entries: directoryEntries,
  }, { clock });

  const isVisible = (meta: Record<string, unknown> | undefined, space: string): boolean => {
    const scope = (meta as { spaceScope?: { space?: string; visibility?: string } } | undefined)?.spaceScope;
    if (!scope || scope.visibility === "public") return true;
    return scope.space === space;
  };

  const wavePort = async (input: LayeredSearchWaveInput): Promise<LayeredSearchWaveResult<KnowledgeMemoryEntry>> => {
    const regionSet = new Set(input.regionIds.flatMap((id) => regionEntryIds(directory, id)));
    const authorized = corpus.filter((e) => e.tenantId === input.authorization.tenantId && e.status === "official" && isVisible(e.meta, input.authorization.space));
    const inWave = input.candidateScope === "global" ? authorized : authorized.filter((e) => regionSet.has(e.id));
    const matching = filterKnowledgeEntriesByQueryText(inWave, input.queryText, { strict: true });
    const ranked = rankKnowledgeEntries(matching, { queryText: input.queryText, domains: ["mathematics"] });
    return {
      entries: ranked.slice(0, input.limit),
      candidateCount: authorized.length,
      visibleCount: authorized.length,
      scannedCount: authorized.length,
      completeForQuery: true,
    };
  };

  const scopeFactory = createVerifiedTaskReadScopeFactory({
    grantService,
    grantForTask: ({ lease, work, space, worker }) => grantService.issue({
      lease,
      scope: { ...work.scope, principalId: `worker:${worker.workerId}`, roles: [worker.role.roleId], space },
      workspace: lease.workspace,
      language: "ts",
      capabilities: expandTaskReadGrantCapabilities(N28_ROLE.capabilities ?? []),
      ttlMs: 120_000,
    }),
  });

  const broker = createKnowledgeBroker({
    grantService,
    dataWorld: {
      queryReadOnly: async () => [],
      memory: { retrieve: async () => corpus, get: async (id: string) => corpus.find((e) => e.id === id) },
    },
    isVisible,
    layeredRetriever: retriever,
    layeredSearchWave: wavePort,
    verifiedReadScopeAuthority: scopeFactory,
    clock,
  });

  const contextProvider = createKnowledgeContextProvider({
    memory: { retrieve: async () => corpus },
    isVisible,
    layeredRetriever: retriever,
    layeredSearchWave: wavePort,
    clock,
  });

  const statePort = createAuthorizedStateReadPort({
    memory: { retrieve: async () => [] },
    isVisible,
    clock,
  });
  const skillStore = {
    listIds: async () => ["skill:a", "skill:b"],
    get: async (id: string) => ({
      id, tenantId: "tenant-a", kind: id, anchors: ["skill"], content: "【场景锚点】a\n【何时用】w\n【效果】e",
      status: "official" as const, meta: { spaceScope: { space: "meta", visibility: "public" } },
    }),
  };
  const scopedSkillPort = createScopedSkillPort({ store: skillStore, isVisible, clock });
  const authorizedReads = createAuthorizedTaskReadFactory({
    broker,
    skills: scopedSkillPort,
    state: statePort,
    clock,
  });
  const provider = createCognitiveWorkingSetProvider({
    budget: N28_FEASIBILITY_BUDGET,
    resolveRoleBudget: (ref) => N28_ROLE_LOAD_POLICIES.get(ref),
  });

  return {
    directory,
    directoryEntries,
    corpus,
    broker,
    grantService,
    clock,
    async runTask({ workerKey, taskText, taskTitle = "n28" }) {
      const worker = N28_WORKERS[workerKey];
      const leaseIds: Record<string, string> = {
        algebra: "20000000-0000-4000-8000-000000000081",
        geometry: "20000000-0000-4000-8000-000000000082",
        curator: "20000000-0000-4000-8000-000000000083",
        global: "20000000-0000-4000-8000-000000000084",
      };
      const scope = {
        tenantId: "tenant-a",
        principalId: `worker:${worker.workerId}`,
        roles: [worker.role.roleId],
        traceId: `trace-${workerKey}`,
        space: "meta",
      };
      const lease: TaskLease = {
        taskId: `task-${workerKey}`, leaseId: leaseIds[workerKey] ?? "20000000-0000-4000-8000-000000000089", generation: 1,
        scope,
        workspace: { tenantId: "tenant-a", workspaceId: `ws-${workerKey}`, taskId: `task-${workerKey}` },
        roleId: worker.role.roleId,
        deadlineAt: "2030-01-01T00:02:00.000Z",
      };
      const work: TaskWorkItem = {
        taskId: lease.taskId, scope, title: taskTitle, text: taskText, tags: [], payload: {},
        assignedRole: worker.role.roleId, domains: ["mathematics"],
      };

      const toolsByTurn: string[][] = [];
      const promptParts: string[] = [];
      let call = 0;
      const llm: LlmFn = {
        complete: async (messages, options) => {
          call += 1;
          // 只记录真实 agent 轮次（含 tools 面）；runAgentTask 完成后的 context compaction
          // 是一次无 tools 的压缩调用，不属于 LLM 工具面回合。
          if (Array.isArray(options?.tools)) {
            toolsByTurn.push(options.tools.map((tool) => tool.name));
          }
          const system = messages.filter((m) => m.role === "system" || m.role === "user").map((m) => m.content).join("\n");
          if (call === 1) promptParts.push(system);
          return {
            content: "", model: "stub", usage: {},
            toolCalls: [{ id: `done-${call}`, name: "done", arguments: { result: { ok: true, workerKey } } }],
          };
        },
      };
      const traces: N28VerticalObservation["traces"] = [];
      const kernel = {
        ts: { execute: async () => ({ ok: true, value: { ran: true }, durationMs: 1, language: "ts" }), reset: () => {}, dispose: () => {}, snapshot: async () => ({ variables: [], functions: [], oversized: [] }), registerResult: () => {}, injectCapability: () => {}, state: {} },
        python: {}, bash: {}, llm: null, dataWorld: null,
        reset: async () => {}, dispose: async () => {}, snapshot: async () => ({ variables: [], functions: [], oversized: [] }),
      } as unknown as WorkerKernel;

      const runnerDeps: AgentTaskRunnerDeps = {
        kernel,
        role: N28_ROLE,
        workspace: { taskId: lease.taskId, tenant: "tenant-a", dir: "/tmp/n28" },
        llm,
        caps: { memory: {}, state: {}, skills: {} },
        config: { agentMode: true, aspMode: false },
        knowledgeContextProvider: contextProvider,
        replica: worker,
        verifiedReadScopeFactory: scopeFactory,
        memoryDirectory: directory,
        cognitiveWorkingSetProvider: provider,
        cognitiveResponsibilityMode: "feasibility",
        authorizedReads,
        onTrace: (e) => traces.push(e),
      };
      const outcome = await new AgentTaskRunner(runnerDeps).run({ lease, work });
      return {
        outcome,
        toolsByTurn,
        systemPrompt: promptParts[0] ?? "",
        traces,
        usage: outcome.usage,
      };
    },
  };
}
