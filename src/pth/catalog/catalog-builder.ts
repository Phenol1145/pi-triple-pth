/**
 * catalog/catalog-builder.ts — 运行时目录构建器（模块化 v2 P3-1）。
 *
 * build() 前可增量装配；build() 后 builder sealed，任何修改都抛错。
 * 重复 id / 非法 capability / 非法 policy 一律 fail-closed；
 * build 时按 id 字典序排序，同一 manifest 构建结果确定一致。
 */

import { isCapabilityName, validateCapabilityPolicy, type CapabilityPolicy } from "./capability-policy.js";
import { RuntimeCatalogSnapshot, type CatalogRole, type CatalogSpace } from "./runtime-catalog.js";

const NON_EMPTY = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

export class CatalogBuilder {
  private sealed = false;
  private roles = new Map<string, CatalogRole>();
  private spaces = new Map<string, CatalogSpace>();
  private extensions = new Map<string, string>();
  private policy: CapabilityPolicy | null = null;

  private assertMutable(): void {
    if (this.sealed) throw new Error("catalog builder sealed after build()");
  }

  private validateRole(role: CatalogRole): void {
    if (!NON_EMPTY(role.id)) throw new Error("role: id required");
    if (this.roles.has(role.id)) throw new Error(`role: duplicate id ${role.id}`);
    if (role.tags.length === 0 || role.tags.some((t) => !NON_EMPTY(t))) throw new Error(`role ${role.id}: at least one non-empty tag required`);
    if (!NON_EMPTY(role.prompt)) throw new Error(`role ${role.id}: prompt required`);
    if (role.capabilities?.some((c) => !isCapabilityName(c))) {
      throw new Error(`role ${role.id}: invalid capability in ${JSON.stringify(role.capabilities)}`);
    }
  }

  addRole(role: CatalogRole): this {
    this.assertMutable();
    this.validateRole(role);
    this.roles.set(role.id, {
      ...role,
      tags: [...role.tags].sort(),
      capabilities: role.capabilities ? [...role.capabilities].sort() : undefined,
    });
    return this;
  }

  addSpace(space: CatalogSpace): this {
    this.assertMutable();
    if (!NON_EMPTY(space.id)) throw new Error("space: id required");
    if (this.spaces.has(space.id)) throw new Error(`space: duplicate id ${space.id}`);
    if (space.kind !== "meta" && !NON_EMPTY(space.execTool)) throw new Error(`space ${space.id}: execTool required（非 meta 空间）`);
    this.spaces.set(space.id, { ...space, bindRoles: space.bindRoles ? [...space.bindRoles].sort() : undefined });
    return this;
  }

  addExtension(id: string): this {
    this.assertMutable();
    if (!NON_EMPTY(id)) throw new Error("extension: id required");
    if (this.extensions.has(id)) throw new Error(`extension: duplicate id ${id}`);
    this.extensions.set(id, id);
    return this;
  }

  setCapabilityPolicy(policy: CapabilityPolicy): this {
    this.assertMutable();
    const check = validateCapabilityPolicy(policy);
    if (!check.ok) throw new Error(check.error);
    this.policy = { allow: [...policy.allow].sort(), deny: policy.deny ? [...policy.deny].sort() : undefined };
    return this;
  }

  build(): RuntimeCatalogSnapshot {
    this.assertMutable();
    this.sealed = true;
    return new RuntimeCatalogSnapshot({
      roles: [...this.roles.values()].sort((a, b) => a.id.localeCompare(b.id)),
      spaces: [...this.spaces.values()].sort((a, b) => a.id.localeCompare(b.id)),
      extensions: [...this.extensions.keys()].sort(),
      capabilityPolicy: this.policy ?? { allow: [] },
    });
  }
}
