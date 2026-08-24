/**
 * runtime/runtime-secrets.ts —— P6-4 secrets env 自动注入（编排器专用）。
 *
 * 只读取 deploy/.env.pth.secrets 并注入子进程环境；token 不落命令行参数。
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnvFile } from "@away_from/pth-config";

export const parseSecretsEnvFile = parseEnvFile;

export async function loadSecretsFile(repoRoot: string, envFile?: string): Promise<Record<string, string>> {
  const path = resolve(envFile ?? resolve(repoRoot, "deploy", ".env.pth.secrets"));
  const text = await readFile(path, "utf8");
  return parseSecretsEnvFile(text);
}

/** 把指定 secrets 注入 env 副本（不修改入参）。 */
export function injectSecrets(env: NodeJS.ProcessEnv, secrets: Record<string, string>, keys?: readonly string[]): Record<string, string> {
  const out: Record<string, string> = { ...env } as Record<string, string>;
  for (const [key, value] of Object.entries(secrets)) {
    if (keys !== undefined && !keys.includes(key)) continue;
    if (value.trim() !== "") out[key] = value;
  }
  return out;
}

/** 校验指定 keys 均非空；返回缺失清单（空数组 = 完整）。 */
export function missingSecretKeys(secrets: Record<string, string>, keys: readonly string[]): string[] {
  return keys.filter((k) => !secrets[k]?.trim());
}

/** 同步到真实 process.env（编排器真实模式使用；测试不得调用）。 */
export function applySecretsToProcessEnv(secrets: Record<string, string>, keys?: readonly string[]): void {
  for (const [key, value] of Object.entries(secrets)) {
    if (keys !== undefined && !keys.includes(key)) continue;
    if (value.trim() !== "") process.env[key] = value;
  }
}
