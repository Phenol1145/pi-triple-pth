/**
 * tools/tool-manifest.ts —— tool containers 部署事实源（T2，T0 不可修改）。
 *
 * `deploy/tool-containers/tool-manifest.json` 的 schema 与 fail-closed 校验：
 *  - 域：compiled（运行时离线）/ network（出网）/ secrets（凭据，仅宿主）；
 *  - 工具 = 命令行 job（argv 白名单），不是服务；
 *  - digest 钉版：release 后必须是 `sha256:<64hex>`；未 release 允许空串（本地构建模式）。
 */

export type ToolContainerDomain = "compiled" | "network" | "secrets";
export type ToolMode = "sync" | "stream" | "interactive";

export const TOOL_CONTAINER_DOMAINS: readonly ToolContainerDomain[] = ["compiled", "network", "secrets"];
export const TOOL_MODES: readonly ToolMode[] = ["sync", "stream", "interactive"];

export interface ToolDefinition {
  /** ^[a-z][a-z0-9._-]{0,63}$（全 manifest 唯一） */
  name: string;
  /** 默认 [name]；容器内真实 argv 前缀（白名单执行依据） */
  argv?: string[];
  description?: string;
  /** engine 可见白名单（role capability 授权仍在 engine 内做） */
  engineVisible: boolean;
  /** 仅宿主 pth CLI 可调；凭据工具恒 true */
  hostOnly: boolean;
  /** 该工具支持的模式（按域能力约束） */
  modes: ToolMode[];
  /** TCE P5：per-tool 参数 JSON Schema（严格 per-tool schema——禁止通用 argv 透传）。 */
  argsSchema?: Record<string, unknown>;
  /** TCE P5：argv 模板（{{param}} 槽位；槽位必须 ⊆ argsSchema.properties）。 */
  argvTemplate?: string[];
}

export interface DomainToolManifest {
  /** GHCR 仓库（release 后配合 digest 钉版；本地构建可覆盖为 dev 镜像） */
  image: string;
  /** "" = 未 release；否则 sha256:<64hex> */
  digest?: string;
  /** compiled=internal（离线）；network/secrets=default（出网） */
  network: "internal" | "default";
  /** 域级 engineVisible（secrets 恒 false——物理上不 join engine 网络） */
  engineVisible: boolean;
  tools: ToolDefinition[];
}

export interface ToolManifestFile {
  schemaVersion: 1;
  generatedAt: string;
  domains: Partial<Record<ToolContainerDomain, DomainToolManifest>>;
}

export class ToolManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolManifestError";
  }
}

const TOOL_NAME_RE = /^[a-z][a-z0-9._-]{0,63}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

function fail(message: string): never {
  throw new ToolManifestError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateTool(raw: unknown, domain: ToolContainerDomain, seen: Set<string>): ToolDefinition {
  if (!isRecord(raw)) fail(`${domain} tool must be an object`);
  for (const key of Object.keys(raw)) {
    if (!["name", "argv", "description", "engineVisible", "hostOnly", "modes", "argsSchema", "argvTemplate"].includes(key)) {
      fail(`${domain} tool ${String(raw.name)}: unknown field ${key}`);
    }
  }
  if (typeof raw.name !== "string" || !TOOL_NAME_RE.test(raw.name)) {
    fail(`${domain} tool name must match ^[a-z][a-z0-9._-]{0,63}$: ${String(raw.name)}`);
  }
  if (seen.has(raw.name)) fail(`duplicate tool name across domains: ${raw.name}`);
  seen.add(raw.name);

  let argv: string[] | undefined;
  if (raw.argv !== undefined) {
    if (!Array.isArray(raw.argv) || raw.argv.length === 0 || raw.argv.some((a) => typeof a !== "string" || a.length === 0)) {
      fail(`${domain} tool ${raw.name}: argv must be a non-empty array of strings`);
    }
    argv = [...(raw.argv as string[])];
  }
  if (raw.description !== undefined && (typeof raw.description !== "string" || raw.description.length > 200)) {
    fail(`${domain} tool ${raw.name}: description must be a string ≤200`);
  }
  if (typeof raw.engineVisible !== "boolean" || typeof raw.hostOnly !== "boolean") {
    fail(`${domain} tool ${raw.name}: engineVisible/hostOnly must be booleans`);
  }
  if (!Array.isArray(raw.modes) || raw.modes.length === 0 || raw.modes.some((m) => !(TOOL_MODES as readonly string[]).includes(String(m)))) {
    fail(`${domain} tool ${raw.name}: modes must be a non-empty subset of sync|stream|interactive`);
  }
  const modes = [...new Set(raw.modes as ToolMode[])];

  // TCE P5：per-tool schema / argvTemplate 校验（fail-closed）
  let argsSchema: Record<string, unknown> | undefined;
  if (raw.argsSchema !== undefined) {
    if (!isRecord(raw.argsSchema) || raw.argsSchema.type !== "object" || !isRecord(raw.argsSchema.properties)) {
      fail(`${domain} tool ${raw.name}: argsSchema must be {type:"object", properties:{...}}`);
    }
    argsSchema = raw.argsSchema as Record<string, unknown>;
  }
  let argvTemplate: string[] | undefined;
  if (raw.argvTemplate !== undefined) {
    if (!Array.isArray(raw.argvTemplate) || raw.argvTemplate.length === 0 || raw.argvTemplate.some((a) => typeof a !== "string" || a.length === 0)) {
      fail(`${domain} tool ${raw.name}: argvTemplate must be a non-empty array of strings`);
    }
    if (!argsSchema) {
      fail(`${domain} tool ${raw.name}: argvTemplate requires argsSchema`);
    }
    const props = (argsSchema.properties ?? {}) as Record<string, unknown>;
    for (const part of raw.argvTemplate as string[]) {
      for (const m of part.matchAll(/\{\{([^}]+)\}\}/g)) {
        if (!(m[1]! in props)) {
          fail(`${domain} tool ${raw.name}: argvTemplate slot {{${m[1]}}} not in argsSchema.properties`);
        }
      }
    }
    argvTemplate = [...(raw.argvTemplate as string[])];
  }

  if (raw.hostOnly === true && raw.engineVisible === true) {
    fail(`${domain} tool ${raw.name}: hostOnly tool must be engineVisible=false（不进入工具面）`);
  }

  if (domain === "secrets") {
    if (raw.engineVisible !== false || raw.hostOnly !== true) {
      fail(`secrets tool ${raw.name} must be engineVisible=false hostOnly=true`);
    }
  }
  if (domain === "compiled" || domain === "network") {
    if (modes.includes("interactive")) {
      fail(`${domain} tool ${raw.name}: interactive 模式本轮只对 secrets 域开放`);
    }
  }
  return {
    name: raw.name,
    ...(argv ? { argv } : {}),
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    ...(argsSchema ? { argsSchema } : {}),
    ...(argvTemplate ? { argvTemplate } : {}),
    engineVisible: raw.engineVisible as boolean,
    hostOnly: raw.hostOnly as boolean,
    modes,
  };
}

export function validateToolManifest(input: unknown): ToolManifestFile {  if (!isRecord(input)) fail("tool-manifest must be an object");
  if (input.schemaVersion !== 1) fail("tool-manifest schemaVersion must be 1");
  if (typeof input.generatedAt !== "string" || input.generatedAt.length === 0) {
    fail("tool-manifest generatedAt must be an ISO string");
  }
  if (!isRecord(input.domains)) fail("tool-manifest domains must be an object");
  for (const key of Object.keys(input.domains)) {
    if (!(TOOL_CONTAINER_DOMAINS as readonly string[]).includes(key)) {
      fail(`unknown tool domain: ${key}（只允许 compiled|network|secrets）`);
    }
  }

  const seen = new Set<string>();
  const domains: ToolManifestFile["domains"] = {};
  for (const domain of TOOL_CONTAINER_DOMAINS) {
    const raw = input.domains[domain];
    if (raw === undefined) continue;
    if (!isRecord(raw)) fail(`${domain} domain must be an object`);
    for (const key of Object.keys(raw)) {
      if (!["image", "digest", "network", "engineVisible", "tools"].includes(key)) {
        fail(`${domain} domain: unknown field ${key}`);
      }
    }
    if (typeof raw.image !== "string" || raw.image.length === 0) fail(`${domain}.image must be a non-empty string`);
    let digest: string | undefined;
    if (raw.digest !== undefined && raw.digest !== "") {
      if (typeof raw.digest !== "string" || !DIGEST_RE.test(raw.digest)) {
        fail(`${domain}.digest must be "" or sha256:<64hex>`);
      }
      digest = raw.digest;
    }
    const network = raw.network as DomainToolManifest["network"];
    const expectedNetwork = domain === "compiled" ? "internal" : "default";
    if (network !== expectedNetwork) {
      fail(`${domain}.network must be ${expectedNetwork}（域信任边界固定）`);
    }
    const expectedEngineVisible = domain !== "secrets";
    if (raw.engineVisible !== expectedEngineVisible) {
      fail(`${domain}.engineVisible must be ${String(expectedEngineVisible)}`);
    }
    if (!Array.isArray(raw.tools) || raw.tools.length === 0) fail(`${domain}.tools must be a non-empty array`);
    domains[domain] = {
      image: raw.image,
      ...(digest !== undefined ? { digest } : {}),
      network,
      engineVisible: raw.engineVisible as boolean,
      tools: (raw.tools as unknown[]).map((tool) => validateTool(tool, domain, seen)),
    };
  }
  return { schemaVersion: 1, generatedAt: input.generatedAt, domains };
}

export function hasAllDomainDigests(manifest: ToolManifestFile): boolean {
  return Object.values(manifest.domains).every((d) => typeof d.digest === "string" && d.digest.length > 0);
}

/** release 命令：把 buildx push 后查得的 digest 钉进 manifest（域必须存在；digest 强校验）。 */
export function pinToolManifestDigest(
  manifest: ToolManifestFile,
  domain: ToolContainerDomain,
  digest: string,
): ToolManifestFile {
  const entry = manifest.domains[domain];
  if (!entry) fail(`cannot pin digest for missing domain: ${domain}`);
  if (!DIGEST_RE.test(digest)) fail(`digest must be sha256:<64hex>: ${digest}`);
  return {
    ...manifest,
    generatedAt: new Date().toISOString(),
    domains: { ...manifest.domains, [domain]: { ...entry, digest } },
  };
}
