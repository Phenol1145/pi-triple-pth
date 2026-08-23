/**
 * execution/execution-target-registry.ts —— ExecutionTarget 注册表装配（Execution Target Matrix）。
 *
 * 事实源：
 *  - `deploy/executor-matrix.json`：静态/标准 target（sandbox、engine-ts 等）；
 *  - `PTH_EXEC_BACKENDS` + tool/service registry：派生 command target（local/tool/jupyter）。
 *
 * 冲突优先级与 `buildExecutionBackendRegistry` 一致：显式（静态文件）优先，派生冲突产生 warnings。
 * persistent 会话能力不在 `HttpExecutionBackend.execute()` 上，因此 sandbox 的
 * `execution-session` binding 仍保留在静态矩阵中，由 NotebookTargetRouter 走 session 路径。
 */

import { readFileSync } from "node:fs";
import type {
  ExecutionTargetDefinition,
  ExecutionTargetRegistry,
  NotebookLanguage,
} from "@away_from/pth-contracts";
import { validateExecutionTargetMatrix } from "@away_from/pth-contracts";
import type { ExecutionBackendDescriptor } from "@away_from/shared/execution";
import {
  buildExecutionBackendRegistry,
  type BuildExecutionBackendRegistryInput,
  type ExecutionBackendRegistry,
} from "./backend-registry.js";

export interface ExecutionTargetMatrixFile {
  version: number;
  targets: ExecutionTargetDefinition[];
}

export interface BuildExecutionTargetRegistryInput extends Omit<BuildExecutionBackendRegistryInput, "strict" | "env"> {
  /** 仅内部 build backend registry 时使用；缺省 process.env */
  env?: NodeJS.ProcessEnv;
  /** 静态矩阵 JSON 字符串；缺省读 `deploy/executor-matrix.json` */
  matrixJson?: string;
  /** 静态矩阵文件路径（当 matrixJson 未提供时） */
  matrixPath?: string;
  /** 装配后 backend registry（缺省内部 build——测试可注入） */
  backendRegistry?: ExecutionBackendRegistry;
  /** 注册表是否对 backend 缺失 fail-closed；测试可关闭 */
  strict?: boolean;
}

export interface BuildExecutionTargetRegistryResult {
  registry: ExecutionTargetRegistry;
  warnings: string[];
}

export function defaultExecutionTargetMatrixPath(): string {
  return new URL("../../../deploy/executor-matrix.json", import.meta.url).pathname;
}

export function loadExecutionTargetMatrix(matrixJson?: string, matrixPath = defaultExecutionTargetMatrixPath()): ExecutionTargetMatrixFile {
  let raw: unknown;
  try {
    raw = JSON.parse(matrixJson ?? readFileSync(matrixPath, "utf8"));
  } catch (error) {
    throw new Error(`executor-matrix.json 不可解析: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof raw !== "object" || raw === null || (raw as { version?: unknown }).version !== 1) {
    throw new Error("executor-matrix.json 必须是 { version: 1, targets: [...] }");
  }
  const targets = (raw as { targets?: unknown }).targets;
  if (!Array.isArray(targets)) {
    throw new Error("executor-matrix.json targets 必须是数组");
  }
  return { version: 1, targets: targets as ExecutionTargetDefinition[] };
}

function descriptorProfile(profile: ExecutionBackendDescriptor["profile"]): ExecutionTargetDefinition["profile"] {
  return profile;
}

/** 从 backend descriptor 派生 command target（local/tool/jupyter 等一次性执行面）。 */
function deriveCommandTarget(descriptor: ExecutionBackendDescriptor, backendId: string): ExecutionTargetDefinition {
  return {
    id: backendId,
    kind: "command",
    profile: descriptorProfile(descriptor.profile),
    languages: ["bash"],
    modes: { sync: true, stream: false, interactive: false, persistent: false },
    session: { type: "one-shot" },
    capabilities: {
      richMedia: false,
      streaming: false,
      cancel: false,
      pathMapping: descriptor.pathMapping !== undefined,
    },
    routing: { defaultFor: [], userSelectable: true, requiresApproval: true },
    binding: { type: "execution-backend", backendId, mode: "sync" },
  };
}

/**
 * 装配 ExecutionTargetRegistry。
 *
 * 流程：
 *  1. 读静态矩阵；
 *  2. 构建（或注入）ExecutionBackendRegistry；
 *  3. 把未在静态矩阵中声明的 backend 派生为 command target；
 *  4. 校验（重复 id、非法 language、binding 未注册 fail-closed）。
 */
export function buildExecutionTargetRegistry(
  input: BuildExecutionTargetRegistryInput,
): BuildExecutionTargetRegistryResult {
  const warnings: string[] = [];
  const matrix = loadExecutionTargetMatrix(input.matrixJson, input.matrixPath);
  const staticTargets = [...matrix.targets];
  const staticIds = new Set(staticTargets.map((t) => t.id));

  const backendResult = input.backendRegistry
    ? { registry: input.backendRegistry, warnings: [] as string[] }
    : buildExecutionBackendRegistry({ ...input, env: input.env ?? process.env, strict: input.strict ?? true });
  warnings.push(...backendResult.warnings);

  const backendRegistry = backendResult.registry;
  const registeredBackendIds = new Set(backendRegistry.list().keys());

  const targets = new Map<string, ExecutionTargetDefinition>();
  for (const target of staticTargets) targets.set(target.id, target);

  for (const [backendId, backend] of backendRegistry.list()) {
    if (targets.has(backendId)) {
      // 静态显式声明优先；派生冲突只告警（与 buildExecutionBackendRegistry 语义一致）。
      warnings.push(`execution target ${backendId} 静态矩阵与 backend registry 冲突——静态配置优先`);
      continue;
    }
    const descriptor = backend.descriptor;
    const derived = deriveCommandTarget(descriptor, backendId);
    targets.set(derived.id, derived);
  }

  const strict = input.strict ?? true;
  if (strict) {
    validateExecutionTargetMatrix([...targets.values()], { registeredBackendIds });
  }

  const registry: ExecutionTargetRegistry = {
    get: (id) => targets.get(id),
    list: () => targets,
    resolve: (language, target) => {
      // 纯解析：不抛 userSelectable/requiresApproval——显式选择策略与批准全部在 Command 层。
      if (target) {
        const def = targets.get(target);
        if (!def) {
          throw new Error(`ExecutionTarget 不存在: ${target}`);
        }
        if (!def.languages.includes(language)) {
          throw new Error(`ExecutionTarget ${target} 不支持 language ${language}`);
        }
        return def;
      }
      // 默认路由：按语言的第一个 defaultFor 命中（安全默认 sandbox / engine-ts）。
      const def = [...targets.values()].find((t) => t.routing.defaultFor.includes(language));
      if (!def) {
        throw new Error(`没有 language ${language} 的默认 ExecutionTarget`);
      }
      return def;
    },
  };

  return { registry, warnings };
}
