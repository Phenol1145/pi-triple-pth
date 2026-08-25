/**
 * runner/exec-modes/task-capability-inject.ts —— TCE W1 任务级能力注入扩展。
 *
 * 在既有 capabilityInject（cache/knowledge/professional）之上，按角色 capabilities
 * 注入 dev/write/debug 能力对象。只注入角色已声明的具体方法（或族级声明=全方法），
 * 避免 acceptor 等只读角色获得 dev.write/write.create 等写方法。
 */

import {
  createDevCapability,
  createWriteCapability,
  createDebugCapability,
  createNetworkCapability,
  type DevCapability,
  type WriteCapability,
  type DebugCapability,
  type NetworkExecuteClient,
} from "@away_from/pth-kernel-execution";
import type { WorkerKernel } from "@away_from/pth-kernel-interpreter";

export interface TaskCapabilityInjectDeps {
  kernel: WorkerKernel;
  taskWorkspace?: string;
  toolstore?: import("@away_from/pth-kernel-interpreter").Toolstore;
  debugApi?: { url: string; secret: string };
  networkExecute?: NetworkExecuteClient;
  roleCapabilities?: readonly string[];
  base?: Record<string, unknown>;
}

const DEV_METHODS: Array<keyof DevCapability> = ["write", "edit", "build", "run", "save", "list"];
const WRITE_METHODS: Array<keyof WriteCapability> = ["create", "edit", "read", "list", "save", "section"];
const DEBUG_METHODS: Array<keyof DebugCapability> = ["attach", "breakpoint", "continue", "step", "snapshot", "evaluate", "detach", "sessions"];
const NETWORK_METHODS: Array<"search" | "fetch" | "extract"> = ["search", "fetch", "extract"];

function allowed(caps: readonly string[] | undefined, method: string): boolean {
  if (!caps || caps.length === 0) return false; // 缺省全量只对旧路径兼容；TCE 下未声明 = 不注入
  const family = method.split(".")[0]!;
  return caps.includes(family) || caps.includes(method);
}

export function buildTaskCapabilityInject(deps: TaskCapabilityInjectDeps): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(deps.base ?? {}) };
  const caps = deps.roleCapabilities;

  const devMethods = DEV_METHODS.filter((m) => allowed(caps, `dev.${m}`));
  if (devMethods.length > 0) {
    const dev = createDevCapability({
      kernel: deps.kernel,
      taskWorkspace: deps.taskWorkspace,
      toolstore: deps.toolstore,
    });
    const partial: Record<string, unknown> = {};
    for (const m of devMethods) partial[m] = dev[m];
    out["dev"] = partial;
  }

  const writeMethods = WRITE_METHODS.filter((m) => allowed(caps, `write.${m}`));
  if (writeMethods.length > 0) {
    const write = createWriteCapability({
      taskWorkspace: deps.taskWorkspace,
      toolstore: deps.toolstore,
    });
    const partial: Record<string, unknown> = {};
    for (const m of writeMethods) partial[m] = write[m];
    out["write"] = partial;
  }

  const debugMethods = DEBUG_METHODS.filter((m) => allowed(caps, `debug.${m}`));
  if (debugMethods.length > 0) {
    const debug = createDebugCapability({
      taskWorkspace: deps.taskWorkspace,
      debugApi: deps.debugApi,
    });
    const partial: Record<string, unknown> = {};
    for (const m of debugMethods) partial[m] = debug[m];
    out["debug"] = partial;
  }

  const networkMethods = NETWORK_METHODS.filter((m) => allowed(caps, `net.${m}`));
  if (networkMethods.length > 0) {
    if (!deps.networkExecute) {
      throw new Error(`net.* 能力已声明但未注入 NetworkExecuteClient（Wave 2 接线前不可用）: ${networkMethods.map((m) => `net.${m}`).join(", ")}`);
    }
    const network = createNetworkCapability({ client: deps.networkExecute });
    const partial: Record<string, unknown> = {};
    for (const m of networkMethods) partial[m] = network[m];
    out["net"] = partial;
  }

  return out;
}
