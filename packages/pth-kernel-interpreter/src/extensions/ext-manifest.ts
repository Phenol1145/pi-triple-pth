/**
 * ext-manifest.ts —— 兼容性扩展 manifest 规范与校验（P2——SPEC 2026-08-09 §1）
 *
 * toolstore/extensions/<id>/plugin.json：声明式 contracts（tools/capabilities/events/
 * roles/kernels/debugAdapters）。借鉴 OpenClaw openclaw.plugin.json 的声明式形态。
 */

import { z } from "zod";

/** 角色声明（PTH 独有——正交角色谱系扩展） */
export const ExtRoleSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  tags: z.array(z.string()).min(1),
  prompt: z.string().min(1),
  capabilities: z.array(z.string()).optional(),   // 权限最小化（缺省全量——兼容）
  memoryScope: z.enum(["own", "all"]).optional(), // memory 区域（own 默认）
});

/** kernel 声明（新执行核） */
export const ExtKernelSchema = z.object({
  language: z.string().regex(/^[a-z0-9-]+$/),
  impl: z.string(),   // index.ts#ClassName（eval 重放定位）
  mode: z.enum(["repl", "compiled"]).optional(),
});

/** 调试适配器声明（新调试核） */
export const ExtDebugAdapterSchema = z.object({
  language: z.string().regex(/^[a-z0-9-]+$/),
  impl: z.string(),
});

/** manifest schema */
export const ExtManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  version: z.string().optional(),
  description: z.string().optional(),
  contracts: z.object({
    tools: z.array(z.string()).optional(),
    capabilities: z.array(z.string()).optional(),
    events: z.array(z.string()).optional(),
    roles: z.array(ExtRoleSchema).optional(),
    kernels: z.array(ExtKernelSchema).optional(),
    debugAdapters: z.array(ExtDebugAdapterSchema).optional(),
  }),
  activation: z.object({
    onStartup: z.boolean().optional(),
    lazy: z.boolean().optional(),
  }).optional(),
  configSchema: z.record(z.string(), z.unknown()).optional(),
  compat: z.object({
    pluginApi: z.string().optional(),
  }).optional(),
});

export type ExtManifest = z.infer<typeof ExtManifestSchema>;
export type ExtRole = z.infer<typeof ExtRoleSchema>;
export type ExtKernel = z.infer<typeof ExtKernelSchema>;
export type ExtDebugAdapter = z.infer<typeof ExtDebugAdapterSchema>;

/** 解析 + 校验 manifest（JSON 文本 → ExtManifest——schema 校验 + compat 版本检查） */
export function parseExtManifest(json: string, pluginApiVersion = "0.7.0"): ExtManifest {
  const raw = JSON.parse(json);
  const manifest = ExtManifestSchema.parse(raw);
  // compat 版本检查（pluginApi 声明——简单 semver 前缀比较）
  if (manifest.compat?.pluginApi) {
    const declared = manifest.compat.pluginApi.replace(/^>=?/, "");
    if (!versionGte(pluginApiVersion, declared)) {
      throw new Error(`manifest ${manifest.id}: pluginApi ${manifest.compat.pluginApi} > 当前 ${pluginApiVersion}——版本不兼容`);
    }
  }
  return manifest;
}

/** 简单 semver 比较（x.y.z——数字段比较） */
function versionGte(current: string, required: string): boolean {
  const c = current.split(".").map(Number);
  const r = required.split(".").map(Number);
  for (let i = 0; i < Math.max(c.length, r.length); i++) {
    const cv = c[i] ?? 0;
    const rv = r[i] ?? 0;
    if (cv > rv) return true;
    if (cv < rv) return false;
  }
  return true;
}
