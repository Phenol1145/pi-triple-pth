/**
 * @away_from/pth-console — PTH Console 公共入口（barrel）。
 *
 * 导出 PTH 侧核心能力（client/protocol/pack + operator-console 服务器），
 * 以及 pth CLI 的全部交互面（commands / launcher / web）——根仓 CLI（src/cli/pth-cli.ts）
 * 只 import 本包入口，不再穿透包的源码路径。
 */
export * from "./bridge/client-types.js";
export * from "./bridge/client.js";
export * from "./bridge/manifest.js";
export * from "./bridge/pack.js";
export * from "./bridge/ustar.js";
export * from "./operator-console/index.js";

export { parseCommandArgs } from "./commands/flags.js";
export { cmdSubmit } from "./commands/submit.js";
export { cmdRun } from "./commands/run.js";
export { cmdPrograms } from "./commands/programs.js";
export { cmdHubRequest, cmdHubRequests } from "./commands/request.js";
export { cmdHubRespond } from "./commands/respond.js";
export { cmdHubObserve } from "./commands/observe.js";
export { cmdHubDebug } from "./commands/debug.js";
export { cmdHubBench } from "./commands/bench.js";
export { cmdHubConsole } from "./commands/console.js";
export { cmdHubLineage } from "./commands/lineage.js";
export { cmdHubTrigger } from "./commands/trigger.js";
export { cmdHubJobSubmit, cmdHubJobStatus, cmdHubJobFetch } from "./commands/jobs.js";
export {
  cmdKernelTasksAdd,
  cmdKernelTemplatesLs,
  cmdKernelTasksLs,
  cmdKernelTasksCancel,
  cmdKernelWait,
  cmdKernelBatchAdd,
  cmdKernelBatchRemove,
  cmdKernelBatchWorker,
  cmdKernelStatus,
} from "./commands/kernel.js";
export {
  runPthUp,
  runPthDown,
  runPthStatus,
  runPthLogs,
  runPthInit,
} from "./launcher.js";
export { runPthWeb } from "./cli.js";
