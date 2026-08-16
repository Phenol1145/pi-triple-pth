/**
 * workload/environment.ts —— 不可信工作负载的环境与身份边界（P0-2）
 *
 * 原则：
 *  - 工作负载 env 一律 allowlist 构造，绝不继承 controller 的 process.env；
 *  - 控制器凭据（SANDBOX_SHARED_SECRET / PTH_MEMORY_BRIDGE_TOKEN / 数据库 / LLM key）永不进入 workload；
 *  - 容器内 controller 以 root 运行（仅用于 setuid 到不可信用户），工作负载以 PTH_WORKLOAD_UID/GID
 *    指定的低权限用户运行；宿主/单元测试未设该 env 时保持当前用户（不 setuid）。
 */

/** 可传给工作负载的基础环境白名单（语言运行时/终端/locale——不含任何密钥与连接串） */
const BASE_ALLOWLIST = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "SHELL",
  "PYTHONUNBUFFERED",
  "PYTHONIOENCODING",
] as const;

/** 即使调用方 override 也强制剔除的敏感键（纵深防御） */
const BLOCKED_KEYS = [
  "SANDBOX_SHARED_SECRET",
  "PTH_MEMORY_BRIDGE_TOKEN",
  "DATABASE_URL",
  "REDIS_URL",
  "POSTGRES_PASSWORD",
  "PI_ANTHROPIC_API_KEY",
  "PI_OPENAI_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
];

export function buildWorkloadEnv(
  overrides: Record<string, string | undefined> = {},
  opts: { allowBridgeToken?: boolean } = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of BASE_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) env[key] = value;
    else delete env[key];
  }
  // PTH_MEMORY_BRIDGE_TOKEN 仅允许可信 kernel-mode 显式 override（PTH 本容器内的 python/bash kernel）；
  // sandbox 工作负载一律不允许，即使调用方误传也剔除。
  const keepBridgeToken = opts.allowBridgeToken === true && overrides.PTH_MEMORY_BRIDGE_TOKEN !== undefined;
  for (const key of BLOCKED_KEYS) {
    if (key === "PTH_MEMORY_BRIDGE_TOKEN" && keepBridgeToken) continue;
    delete env[key];
  }
  return env;
}

import { loadSandboxConfig } from "../config.js";

export interface WorkloadIdentity {
  uid?: number;
  gid?: number;
}

/** workload 用户的 HOME（容器内 /home/workload——避免继承 controller 的 /root） */
export const WORKLOAD_HOME = "/home/workload";

/** 读取容器内注入的工作负载身份（Dockerfile ENV PTH_WORKLOAD_UID/GID）；未配置时返回空（当前用户） */
export function workloadIdentity(): WorkloadIdentity {
  const cfg = loadSandboxConfig();
  const uid = cfg.workloadUid;
  const gid = cfg.workloadGid;
  if (uid !== undefined && gid !== undefined) {
    return { uid, gid };
  }
  return {};
}
