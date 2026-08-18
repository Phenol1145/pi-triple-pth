/**
 * bootstrap/worker-slot-assembly.ts —— N28 T2 worker 身份装配（生产与内存测试共用）。
 *
 * 旧系统按 surface 分用两个 principal：任务侧 `role.id`、sandbox 侧 `worker:<roleId>`；
 * feasibility 模式两者统一为 `worker:<workerId>`。本 helper 返回两个显式 principal，
 * 绝不折叠成单一 ambiguous principalId；测试不得重述分支逻辑。
 */

import { createWorkerReplica, roleDefinitionRevision, type WorkerReplica } from "../kernel/execution/worker-replica.js";
import type { RoleDefinition } from "../kernel/execution/worker-cluster.js";

export interface WorkerSlotIdentity {
  /** off 模式为 undefined（legacy 无副本身份）；feasibility 模式为新建副本。 */
  replica: WorkerReplica | undefined;
  taskPrincipalId: string;
  sandboxPrincipalId: string;
}

export function assembleWorkerSlotIdentity(input: {
  mode: "off" | "feasibility";
  role: RoleDefinition;
  batchId: string;
  idFactory?: () => string;
}): WorkerSlotIdentity {
  if (input.mode !== "feasibility") {
    return {
      replica: undefined,
      taskPrincipalId: input.role.id,
      sandboxPrincipalId: `worker:${input.role.id}`,
    };
  }
  const replica = createWorkerReplica(
    input.role.id,
    roleDefinitionRevision(input.role),
    input.batchId,
    input.idFactory,
  );
  return {
    replica,
    taskPrincipalId: `worker:${replica.ref.workerId}`,
    sandboxPrincipalId: `worker:${replica.ref.workerId}`,
  };
}
