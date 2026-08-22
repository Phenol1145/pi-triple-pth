/**
 * runtime/runtime-profiles.ts —— P6-2 运行时剖面 schema、校验与展开。
 *
 * `deploy/runtime-profiles.json` 是声明式组合层（配置可变层）：组件清单与剖面组合都写在
 * 文件里，CLI 只持有 component.kind 的执行映射；本模块不硬编码剖面内容。
 */

export const RUNTIME_PROFILE_VERSION = 1;

export type RuntimeComponentKind = "compose" | "pth-up" | "tools" | "service";
export type RuntimeComponentPhase = "data" | "optional" | "engine";

export interface RuntimeComponent {
  id: string;
  kind: RuntimeComponentKind;
  phase: RuntimeComponentPhase;
  /** kind=compose：compose 服务名列表 */
  services?: string[];
  /** kind=service：deploy/services/<serviceId>/service.json 的 id */
  serviceId?: string;
  /** doctor 前置事实（信息性；doctor 按事实名触发检查） */
  requiredHostFacts?: string[];
  /** 该组件启动前必须注入子进程 env 的 secrets 键 */
  secretKeys?: string[];
}

export interface RuntimeProfileDecl {
  description?: string;
  extends?: string;
  components: string[];
}

export interface RuntimeProfilesFile {
  version: number;
  components: RuntimeComponent[];
  profiles: Record<string, RuntimeProfileDecl>;
}

export interface ResolvedProfile {
  name: string;
  components: RuntimeComponent[];
}

export class RuntimeProfilesError extends Error {
  readonly detail: string;
  constructor(message: string, detail: string) {
    super(`${message}（${detail}）`);
    this.name = "RuntimeProfilesError";
    this.detail = detail;
  }
}

const ALLOWED_KINDS = new Set<RuntimeComponentKind>(["compose", "pth-up", "tools", "service"]);
const ALLOWED_PHASES = new Set<RuntimeComponentPhase>(["data", "optional", "engine"]);
const COMPONENT_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** 组件稳定顺序：数据层 → 可选组件 → engine（engine 永远最后）。 */
const CANONICAL_ORDER: Readonly<Record<string, number>> = {
  redis: 0,
  postgres: 1,
  sandbox: 2,
  tools: 3,
  "local-lean": 4,
  "local-u8": 5,
  jupyter: 6,
  engine: 1000,
};

const DATA_COMPONENT_IDS = new Set(["redis", "postgres", "sandbox"]);
const ENGINE_COMPONENT_ID = "engine";

function bad(detail: string): never {
  throw new RuntimeProfilesError("runtime-profiles.json 非法", detail);
}

export function validateRuntimeProfiles(input: unknown): RuntimeProfilesFile {
  if (!input || typeof input !== "object") bad("根节点必须是对象");
  const root = input as Record<string, unknown>;
  if (root.version !== RUNTIME_PROFILE_VERSION) bad(`version 必须为 ${RUNTIME_PROFILE_VERSION}`);
  if (!Array.isArray(root.components) || root.components.length === 0) bad("components 必须是非空数组");

  const seen = new Set<string>();
  const components: RuntimeComponent[] = [];
  for (const raw of root.components) {
    if (!raw || typeof raw !== "object") bad("component 必须是对象");
    const c = raw as Record<string, unknown>;
    const id = typeof c.id === "string" ? c.id : "";
    if (!COMPONENT_ID_RE.test(id)) bad(`component id 非法: ${JSON.stringify(c.id)}`);
    if (seen.has(id)) bad(`component id 重复: ${id}`);
    seen.add(id);
    const kind = c.kind as RuntimeComponentKind;
    if (!ALLOWED_KINDS.has(kind)) bad(`component ${id} 的 kind 非法: ${String(c.kind)}`);
    const phase = c.phase as RuntimeComponentPhase;
    if (!ALLOWED_PHASES.has(phase)) bad(`component ${id} 的 phase 非法: ${String(c.phase)}`);
    if (kind === "compose" && (!Array.isArray(c.services) || c.services.length === 0 || c.services.some((s) => typeof s !== "string" || !s))) {
      bad(`component ${id}（compose）必须声明非空 services`);
    }
    if (kind === "service" && (typeof c.serviceId !== "string" || !c.serviceId)) {
      bad(`component ${id}（service）必须声明 serviceId`);
    }
    if (kind === "pth-up" && phase !== "engine") bad(`component ${id}（pth-up）只能 phase=engine`);
    const component: RuntimeComponent = {
      id,
      kind,
      phase,
      ...(Array.isArray(c.services) ? { services: (c.services as string[]) } : {}),
      ...(typeof c.serviceId === "string" ? { serviceId: c.serviceId } : {}),
      ...(Array.isArray(c.requiredHostFacts) ? { requiredHostFacts: c.requiredHostFacts as string[] } : {}),
      ...(Array.isArray(c.secretKeys) ? { secretKeys: c.secretKeys as string[] } : {}),
    };
    components.push(component);
  }

  if (!components.some((c) => c.id === ENGINE_COMPONENT_ID && c.kind === "pth-up" && c.phase === "engine")) {
    bad(`必须包含 engine 组件（kind=pth-up, phase=engine）`);
  }

  if (!root.profiles || typeof root.profiles !== "object" || Array.isArray(root.profiles)) bad("profiles 必须是对象");
  const profileDecls = root.profiles as Record<string, unknown>;
  if (!profileDecls.core) bad("必须声明 core profile");
  const profileNames = new Set(Object.keys(profileDecls));
  const byId = new Map(components.map((c) => [c.id, c]));

  for (const [name, raw] of Object.entries(profileDecls)) {
    if (!COMPONENT_ID_RE.test(name)) bad(`profile 名非法: ${name}`);
    if (!raw || typeof raw !== "object") bad(`profile ${name} 必须是对象`);
    const p = raw as Record<string, unknown>;
    if (p.extends !== undefined && (typeof p.extends !== "string" || !profileNames.has(p.extends))) {
      bad(`profile ${name} 的 extends 不存在: ${String(p.extends)}`);
    }
    if (!Array.isArray(p.components) || p.components.some((c) => typeof c !== "string")) bad(`profile ${name} 的 components 必须是字符串数组`);
    for (const ref of p.components as string[]) {
      if (!byId.has(ref)) bad(`profile ${name} 引用了不存在的 component: ${ref}`);
    }
  }

  // extends 环检测
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (name: string): void => {
    if (done.has(name)) return;
    if (visiting.has(name)) bad(`profile extends 环: ${name}`);
    visiting.add(name);
    const decl = profileDecls[name]! as Record<string, unknown>;
    if (typeof decl.extends === "string") visit(decl.extends);
    visiting.delete(name);
    done.add(name);
  };
  for (const name of profileNames) visit(name);

  return { version: RUNTIME_PROFILE_VERSION, components, profiles: profileDecls as unknown as Record<string, RuntimeProfileDecl> };
}

export function componentById(file: RuntimeProfilesFile, id: string): RuntimeComponent | undefined {
  return file.components.find((c) => c.id === id);
}

function collectProfileIds(file: RuntimeProfilesFile, name: string, out: Set<string>, trail: string[]): void {
  if (trail.includes(name)) throw new RuntimeProfilesError("profile extends 环", trail.concat(name).join(" → "));
  const decl = file.profiles[name];
  if (!decl) throw new RuntimeProfilesError("unknown profile", name);
  if (decl.extends) collectProfileIds(file, decl.extends, out, trail.concat(name));
  for (const id of decl.components) out.add(id);
}

/** 把 profile 名或 component id 展开成 component id 集合（--with/--without 共用；同名时 component 优先）。 */
function expandRef(file: RuntimeProfilesFile, ref: string): string[] {
  if (componentById(file, ref)) return [ref];
  if (file.profiles[ref]) {
    const ids = new Set<string>();
    collectProfileIds(file, ref, ids, []);
    return [...ids];
  }
  throw new RuntimeProfilesError("unknown component/profile", ref);
}

function orderIndex(file: RuntimeProfilesFile, id: string): number {
  return CANONICAL_ORDER[id] ?? 500;
}

function sortComponents(file: RuntimeProfilesFile, ids: Iterable<string>): RuntimeComponent[] {
  return [...new Set(ids)]
    .sort((a, b) => orderIndex(file, a) - orderIndex(file, b))
    .map((id) => componentById(file, id)!);
}

export function resolveProfile(
  file: RuntimeProfilesFile,
  name: string,
  opts: { readonly withIds?: readonly string[]; readonly withoutIds?: readonly string[] } = {},
): ResolvedProfile {
  if (!file.profiles[name]) throw new RuntimeProfilesError("unknown profile", name);
  const ids = new Set<string>();
  collectProfileIds(file, name, ids, []);

  for (const ref of opts.withIds ?? []) {
    for (const id of expandRef(file, ref)) ids.add(id);
  }
  for (const ref of opts.withoutIds ?? []) {
    for (const id of expandRef(file, ref)) {
      if (DATA_COMPONENT_IDS.has(id) || id === ENGINE_COMPONENT_ID) {
        throw new RuntimeProfilesError("核心组件不允许 --without", id);
      }
      ids.delete(id);
    }
  }
  const components = sortComponents(file, ids);
  const engine = components.filter((c) => c.id === ENGINE_COMPONENT_ID);
  if (engine.length !== 1) throw new RuntimeProfilesError("engine 缺失或重复", name);
  if (components[components.length - 1]?.id !== ENGINE_COMPONENT_ID) {
    throw new RuntimeProfilesError("engine 必须最后", name);
  }
  return { name, components };
}

export const DEFAULT_RUNTIME_PROFILES: RuntimeProfilesFile = {
  version: RUNTIME_PROFILE_VERSION,
  components: [
    { id: "redis", kind: "compose", phase: "data", services: ["redis"] },
    { id: "postgres", kind: "compose", phase: "data", services: ["postgres"] },
    { id: "sandbox", kind: "compose", phase: "data", services: ["sandbox"] },
    { id: "engine", kind: "pth-up", phase: "engine" },
    { id: "tools", kind: "tools", phase: "optional" },
    { id: "local-lean", kind: "service", phase: "optional", serviceId: "local-lean", requiredHostFacts: ["PATH_HAS_LEAN"] },
    { id: "local-u8", kind: "service", phase: "optional", serviceId: "local-u8", requiredHostFacts: ["U8_BUILT"] },
    {
      id: "jupyter",
      kind: "service",
      phase: "optional",
      serviceId: "jupyter",
      requiredHostFacts: ["PTH_WORKSPACES_HOST"],
      secretKeys: ["JUPYTER_SERVICE_TOKEN", "JUPYTER_ENGINE_TOKEN"],
    },
  ],
  profiles: {
    core: { description: "pi-platform + sandbox + postgres + redis", components: ["redis", "postgres", "sandbox", "engine"] },
    tools: { description: "core + compiled/network/secrets 工具容器", extends: "core", components: ["tools"] },
    lean4: { description: "core + local-lean（Lean4 证明）", extends: "core", components: ["local-lean"] },
    u8: { description: "core + local-u8（U8 VM 编译/运行）", extends: "core", components: ["local-u8"] },
    jupyter: { description: "core + jupyter（双面 + pi-kernel）", extends: "core", components: ["jupyter"] },
    full: {
      description: "全部运行时",
      extends: "core",
      components: ["tools", "local-lean", "local-u8", "jupyter"],
    },
  },
};
