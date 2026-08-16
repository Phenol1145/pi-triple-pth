/**
 * catalog/runtime-catalog.ts — 不可变运行时目录快照（模块化 v2 P3-1）。
 *
 * snapshot 一经 build 即冻结：roles/spaces/extension allowlist/capability policy
 * 都只能读取；对外返回副本，调用方无法改动内部状态。排序确定（id 字典序），
 * 同一 manifest 构建结果一致（toJSON 可做稳定性断言）。
 */

import type { CapabilityPolicy } from "./capability-policy.js";

export interface CatalogRole {
  readonly id: string;
  readonly parent?: string | null;
  readonly generation?: number;
  readonly tags: readonly string[];
  readonly prompt: string;
  readonly description?: string;
  readonly capabilities?: readonly string[];
  readonly thinking?: "high" | "medium" | "low";
  readonly acceptanceRole?: "read-only" | "writer";
  readonly output?: string;
}

export interface CatalogSpace {
  readonly id: string;
  readonly parent: string | null;
  readonly execTool: string;
  readonly description?: string;
  readonly memoryScope?: string;
  readonly bindRoles?: readonly string[];
  readonly allowChildren?: boolean;
  readonly maxDepth?: number;
}

export interface RuntimeCatalogData {
  readonly roles: readonly CatalogRole[];
  readonly spaces: readonly CatalogSpace[];
  readonly extensions: readonly string[];
  readonly capabilityPolicy: CapabilityPolicy;
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export class RuntimeCatalogSnapshot {
  readonly #data: RuntimeCatalogData;

  constructor(data: RuntimeCatalogData) {
    this.#data = {
      roles: Object.freeze(data.roles.map((r) => Object.freeze({ ...r, tags: Object.freeze([...r.tags]), capabilities: r.capabilities ? Object.freeze([...r.capabilities]) : undefined }))),
      spaces: Object.freeze(data.spaces.map((s) => Object.freeze({ ...s, bindRoles: s.bindRoles ? Object.freeze([...s.bindRoles]) : undefined }))),
      extensions: Object.freeze([...data.extensions]),
      capabilityPolicy: Object.freeze({ allow: Object.freeze([...data.capabilityPolicy.allow]), deny: data.capabilityPolicy.deny ? Object.freeze([...data.capabilityPolicy.deny]) : undefined }),
    };
    Object.freeze(this.#data);
  }

  roles(): CatalogRole[] { return JSON.parse(JSON.stringify(this.#data.roles)) as CatalogRole[]; }
  spaces(): CatalogSpace[] { return JSON.parse(JSON.stringify(this.#data.spaces)) as CatalogSpace[]; }
  extensions(): string[] { return JSON.parse(JSON.stringify(this.#data.extensions)) as string[]; }
  capabilityPolicy(): CapabilityPolicy { return JSON.parse(JSON.stringify(this.#data.capabilityPolicy)) as CapabilityPolicy; }

  roleIds(): string[] { return [...this.#data.roles.map((r) => r.id)]; }
  spaceIds(): string[] { return [...this.#data.spaces.map((s) => s.id)]; }
  extensionIds(): string[] { return [...this.#data.extensions]; }

  role(id: string): CatalogRole | undefined {
    const r = this.#data.roles.find((x) => x.id === id);
    return r ? clone(r) : undefined;
  }

  toJSON(): RuntimeCatalogData {
    return JSON.parse(JSON.stringify(this.#data)) as RuntimeCatalogData;
  }
}
