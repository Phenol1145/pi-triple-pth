/**
 * runner/task-workspace.ts — 任务工作区值对象（模块化 v2 P1-4）。
 *
 * 工作区目录由调度层（P1-5 dispatcher）分配后传入 runner；runner 只消费
 * dir/tenant/taskId，不负责分配、清理或归档。
 */

export interface TaskWorkspace {
  taskId: string;
  tenant: string;
  /** 任务工作目录（调度层已分配；runner 直接把 ts/agent 执行 cwd 指向这里） */
  dir: string;
}

export function makeTaskWorkspace(taskId: string, tenant: string, dir: string): TaskWorkspace {
  return { taskId, tenant, dir };
}
