/**
 * batch-process-types.ts —— runBatchProcess 依赖类型（Phase D D4 拆分）。
 */

import type { MemoryDirectorySnapshot, DirectoryEntryInput, VerifiedTaskReadScopeFactory } from "../execution/index.js";
import type { AuthorizedTaskReadFactory } from "../runner/index.js";
import type { CognitiveBudget, WorkerReplicaRef, ProfessionalRuntimeId } from "@away_from/pth-contracts";
import type { RoleDefinition, WorkerReplica } from "@away_from/pth-kernel-execution";
import type { ProfessionalRuntimeAdapterFactory } from "./professional-runtime-adapters.js";

export interface RunBatchProcessDeps {
  databaseUrl: string;
  basePath: string;       // 工作区根（workspaces）
  artifactPath: string;   // 产物归档根（artifacts）
  intervalMs?: number;
  /** N28 T6：feasibility 依赖（正常 CLI 入口全部 undefined → off 模式）。 */
  memoryDirectory?: MemoryDirectorySnapshot;
  /** N28 复核修复 Layer2：Directory 完整性源（entries + catalog 域）——feasibility 必填。 */
  directoryEntries?: readonly DirectoryEntryInput[];
  knownDomainIds?: ReadonlySet<string>;
  authorizedTaskReadFactory?: AuthorizedTaskReadFactory;
  verifiedReadScopeFactory?: VerifiedTaskReadScopeFactory;
  resolveRoleBudget?: (loadPolicyRef: string) => Partial<CognitiveBudget> | undefined;
  workerSpecs?: readonly {
    role: RoleDefinition;
    requestedReplica?: WorkerReplicaRef;
  }[];
  replicaFactory?: (input: {
    role: RoleDefinition;
    batchId: string;
    index: number;
    requestedReplica?: WorkerReplicaRef;
  }) => WorkerReplica;
  /** Task 4：专业 runtime adapter 工厂（缺省 = committed lock 下零 adapter，后续垂直切片注入）。 */
  professionalRuntimeFactories?: Readonly<Partial<Record<import("@away_from/pth-contracts").ProfessionalRuntimeId, ProfessionalRuntimeAdapterFactory<any, any>>>>;
}
