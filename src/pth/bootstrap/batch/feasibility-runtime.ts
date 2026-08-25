/**
 * bootstrap/batch/feasibility-runtime.ts —— P2-9 装配段：N28 认知责任（feasibility）运行时。
 *
 * 默认 off=legacy 逐字节兼容；feasibility 由确定性装配/harness 显式开启。
 * 本段包含：
 *  - knowledgeContextProvider / authorizedTaskReadFactory / verifiedReadScopeFactory /
 *    cognitiveWorkingSetProvider 装配（feasibility 缺依赖 = 启动错误，绝不省略）；
 *  - feasibility slot 工厂（makeWorkerSlot）与 workerSpecs 派生（buildAssemblyWorkerSpecs）。
 */

import { pthConfig } from "@away_from/pth-config";
import { isVisible } from "@away_from/pth-memory";
import { knownRoleById, roleDefinitionRevision } from "@away_from/pth-kernel-execution";
import type { RoleDefinition, WorkerReplica } from "@away_from/pth-kernel-execution";
import type { WorkerReplicaRef } from "@away_from/pth-contracts";
import { N28_FEASIBILITY_BUDGET } from "@away_from/pth-contracts";
import type { SkillStoreLike } from "@away_from/pth-memory";
import {
  assertMemoryDirectoryResponsibilityCapacity,
  createExecutionGrantService,
  createHmacGrantKeyProvider,
  createKnowledgeBroker,
  createLayeredKnowledgeRetriever,
  createVerifiedTaskReadScopeFactory,
  filterKnowledgeEntriesByQueryText,
  rankKnowledgeEntries,
  regionEntryIds,
  type KnowledgeMemoryEntry,
  type LayeredSearchWaveInput,
  type LayeredSearchWaveResult,
  type VerifiedTaskReadScopeFactory,
} from "../../execution/index.js";
import {
  createKnowledgeContextProvider,
  KNOWLEDGE_CONTEXT_KINDS,
  createAuthorizedStateReadPort,
  createAuthorizedTaskReadFactory,
  createCognitiveWorkingSetProvider,
  createScopedSkillPort,
  expandTaskReadGrantCapabilities,
  type AuthorizedTaskReadFactory,
} from "../../runner/index.js";
import type { DisciplineCatalogSnapshot } from "../../catalog/index.js";
import type { RunBatchProcessDeps } from "../batch-process-types.js";
import type { WorkerSlot } from "../worker-slot-runtime.js";
import type { AuthoritativeWorkingSets, BatchDataWorld, CreatedWorker } from "./context.js";

export interface CognitiveResponsibilityAssembly {
  /** K3：任务知识上下文 provider（memory + catalog + isVisible 同源装配；feasibility 带 layered wave）。 */
  knowledgeContextProvider: ReturnType<typeof createKnowledgeContextProvider>;
  /** N28 T6：feasibility 模式 provider；off 为 undefined。 */
  cognitiveWorkingSetProvider: ReturnType<typeof createCognitiveWorkingSetProvider> | undefined;
  authorizedTaskReadFactory: AuthorizedTaskReadFactory | undefined;
  verifiedReadScopeFactory: VerifiedTaskReadScopeFactory | undefined;
}

/**
 * N28 T6 + 复核 Layer2：feasibility 模式 provider + 启动前责任容量硬闸
 * （缺依赖=启动错误，绝不省略）。off 模式返回 legacy 默认 provider + deps 透传工厂。
 */
export function assembleCognitiveResponsibility(input: {
  deps: RunBatchProcessDeps;
  mode: "off" | "feasibility";
  dataWorld: BatchDataWorld;
  catalog: DisciplineCatalogSnapshot;
  authoritativeWorkingSets: AuthoritativeWorkingSets;
}): CognitiveResponsibilityAssembly {
  const { deps, mode, dataWorld, catalog, authoritativeWorkingSets } = input;
  // K3：catalog 快照与 K2 resolver 同源（同一 builder 产物），供 KnowledgeContextProvider ancestors 展开。
  let knowledgeContextProvider = createKnowledgeContextProvider({
    memory: dataWorld.memory,
    catalog,
    // K1a 同款可见性判定：pth-memory isVisible（spaceScope 沿空间树向下可见）。
    isVisible: (meta, space) => isVisible(meta, space),
  });
  let authorizedTaskReadFactory = deps.authorizedTaskReadFactory;
  let verifiedReadScopeFactory = deps.verifiedReadScopeFactory;
  const cognitiveWorkingSetProvider = mode === "feasibility"
    ? (() => {
        if (!deps.memoryDirectory || !deps.directoryEntries || !deps.knownDomainIds) {
          throw new Error("feasibility mode requires memoryDirectory/directoryEntries/knownDomainIds");
        }
        assertMemoryDirectoryResponsibilityCapacity(deps.memoryDirectory, N28_FEASIBILITY_BUDGET.responsibility);
        // P0-2 修复：生产 batch 构造并注入同一 layeredRetriever + layeredSearchWave，
        // Broker 与 Context 共用同一 wave port/trace 语义；factory 未注入时用生产 grant service 自建。
        const directory = deps.memoryDirectory;
        const clock = () => new Date();
        const layeredRetriever = createLayeredKnowledgeRetriever<KnowledgeMemoryEntry>(directory, {
          knownDomainIds: deps.knownDomainIds,
          entries: deps.directoryEntries,
        }, { clock });
        const layeredSearchWave = async (input: LayeredSearchWaveInput): Promise<LayeredSearchWaveResult<KnowledgeMemoryEntry>> => {
          const regionSet = new Set(input.regionIds.flatMap((id) => regionEntryIds(directory, id)));
          const all = await dataWorld.memory.retrieve({
            anchors: [],
            kinds: [...KNOWLEDGE_CONTEXT_KINDS],
            status: ["official"],
            tenantId: input.authorization.tenantId,
          });
          const authorized = all.filter((e) => isVisible(e.meta, input.authorization.space));
          const inWave = input.candidateScope === "global" ? authorized : authorized.filter((e) => regionSet.has(e.id));
          const matching = filterKnowledgeEntriesByQueryText(inWave, input.queryText, { strict: true });
          const ranked = rankKnowledgeEntries(matching, { queryText: input.queryText, domains: [] });
          return {
            entries: ranked.slice(0, input.limit),
            candidateCount: all.length,
            visibleCount: inWave.length,
            scannedCount: all.length,
            completeForQuery: true,
          };
        };
        knowledgeContextProvider = createKnowledgeContextProvider({
          memory: dataWorld.memory,
          catalog,
          isVisible: (meta, space) => isVisible(meta, space),
          layeredRetriever,
          layeredSearchWave,
          clock,
        });
        const grantService = createExecutionGrantService({
          keyProvider: createHmacGrantKeyProvider({ secret: pthConfig().str("PTH_EXECUTION_GRANT_SECRET") }),
          clock,
        });
        verifiedReadScopeFactory ??= createVerifiedTaskReadScopeFactory({
          grantService,
          grantForTask: ({ lease, work, space, worker }) => {
            const roleDef = knownRoleById(worker.role.roleId);
            return grantService.issue({
              lease,
              scope: { ...work.scope, principalId: `worker:${worker.workerId}`, roles: [worker.role.roleId], space },
              workspace: lease.workspace,
              language: "ts",
              capabilities: expandTaskReadGrantCapabilities(roleDef?.capabilities ?? []),
              ttlMs: 120_000,
            });
          },
        });
        authorizedTaskReadFactory ??= createAuthorizedTaskReadFactory({
          broker: createKnowledgeBroker({
            grantService,
            dataWorld: { queryReadOnly: dataWorld.queryReadOnly, memory: dataWorld.memory },
            isVisible: (meta, space) => isVisible(meta, space),
            layeredRetriever,
            layeredSearchWave,
            verifiedReadScopeAuthority: verifiedReadScopeFactory,
            clock,
          }),
          skills: createScopedSkillPort({ store: dataWorld.memory as unknown as SkillStoreLike, isVisible: (meta, space) => isVisible(meta, space), clock }),
          state: createAuthorizedStateReadPort({ memory: dataWorld.memory, isVisible: (meta, space) => isVisible(meta, space), clock }),
          clock,
        });
        const baseProvider = createCognitiveWorkingSetProvider({ budget: N28_FEASIBILITY_BUDGET, resolveRoleBudget: deps.resolveRoleBudget });
        // P1-2：同一 provider 每次 build 后记录账本快照，heartbeat 只投有界投影。
        return {
          build: async (input) => {
            const built = await baseProvider.build(input);
            authoritativeWorkingSets.set(input.worker.workerId, {
              taskId: input.taskId,
              directorySnapshotId: input.directorySnapshotId,
              snapshot: built.ledger.snapshot(),
            });
            return built;
          },
        } as typeof baseProvider;
      })()
    : undefined;
  return { knowledgeContextProvider, cognitiveWorkingSetProvider, authorizedTaskReadFactory, verifiedReadScopeFactory };
}

/**
 * N28 T2：feasibility 模式 slot 工厂——off 模式完全不实例化新控制面。
 * slot.loop 委托 TaskLoop；slot.dispose 拥有 optimizer/kernel 的清理顺序（停表 → abort → dispose）。
 */
export function makeWorkerSlot(w: CreatedWorker): WorkerSlot {
  if (!w.replica) throw new Error("feasibility slot requires replica");
  return {
    replica: w.replica,
    role: w.role,
    loop: {
      runOnce: () => w.loop.runOnce(),
      pause: () => w.loop.pause(),
      resume: () => w.loop.resume(),
      stop: () => w.loop.stop(),
      // W-b/W-c：feasibility 模式同样暴露在飞活动/实时上下文（心跳与 worker-context-query 共用）。
      getActiveTask: () => w.loop.getActiveTask(),
      getLiveContext: () => w.loop.getLiveContext(),
    },
    dispose: async () => {
      try { w.optimizer?.stop?.(); } catch { /* 停表容错 */ }
      try { await w.kernel.abort?.(); } catch { /* abort 容错 */ }
      try { await w.kernel.dispose?.(); } catch { /* dispose 容错 */ }
    },
  };
}

/**
 * P0-1 修复：feasibility 下 workerSpecs 必须来自 Directory 的 exact WorkerReplicaRef（UUID 一致）；
 * role revision 按生产 catalog role 重算，未知 Directory 角色 fail-closed。
 * off 模式 = 配置的 role 权重展开（PTH_WORKER_ROLES）。
 */
export function buildAssemblyWorkerSpecs(input: {
  mode: "off" | "feasibility";
  deps: RunBatchProcessDeps;
  workerRoles: readonly RoleDefinition[];
}): readonly { role: RoleDefinition; requestedReplica?: WorkerReplicaRef }[] {
  const { mode, deps, workerRoles } = input;
  return mode === "feasibility"
    ? deps.workerSpecs ?? (deps.memoryDirectory?.workers ?? []).map((directoryWorker) => {
        const roleDef = knownRoleById(directoryWorker.role.roleId);
        if (!roleDef) throw new Error(`unknown directory worker role: ${directoryWorker.role.roleId}`);
        return {
          role: roleDef,
          requestedReplica: {
            ...directoryWorker,
            role: { roleId: directoryWorker.role.roleId, revision: roleDefinitionRevision(roleDef) },
          },
        };
      })
    : workerRoles.map((role) => ({ role }));
}
