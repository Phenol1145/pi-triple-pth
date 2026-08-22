/**
 * services/service-manifest.ts —— pth services 声明文件（T2b，宿主执行器统一管理）。
 *
 * 两类 service：
 *  - kind=host：宿主机长驻进程（本地执行器 local-lean/local-u8）——pth 进程监督器管理；
 *  - kind=compose：常驻容器服务（jupyter，P5）——docker compose 生命周期。
 * 声明文件 immutable（T0/T1 边界）；token/实际端口只进运行时注册表。
 */

export type ServiceKind = "host" | "compose";

export interface HostServiceManifest {
  schemaVersion: 1;
  kind: "host";
  id: string;
  description?: string;
  /** argv 数组（无 shell 拼接）；首元素可执行名 */
  command: string[];
  /** token 注入的目标环境变量名（值由 up 时本地生成） */
  tokenEnv: string;
  /** 健康探测（/health 免认证） */
  healthUrl: string;
  /** 就绪超时 ms（默认 30s） */
  readyTimeoutMs?: number;
  /** 优雅停止宽限 ms（默认 5s；超时 SIGKILL） */
  stopGraceMs?: number;
  /** 宿主 pathMapping（engine 合并 services.json 时写进 descriptor） */
  pathMapping?: {
    hostRoot: string;
    /** execRoot 从该环境变量解析（如 PTH_WORKSPACES_HOST）；空则拒绝启动 */
    execRootEnv: string;
  };
}

export interface ComposeServiceManifest {
  schemaVersion: 1;
  kind: "compose";
  id: string;
  description?: string;
  /** 相对 deploy/services/<id>/ 的 compose 文件 */
  composeFile: string;
  projectName: string;
}

export type ServiceManifest = HostServiceManifest | ComposeServiceManifest;

export class ServiceManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceManifestError";
  }
}

const ID_RE = /^[a-z][a-z0-9._-]{0,63}$/;

function fail(message: string): never {
  throw new ServiceManifestError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateCommon(raw: Record<string, unknown>, allowed: string[], id: string): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) fail(`${id}: unknown service field ${key}`);
  }
  if (typeof raw.id !== "string" || !ID_RE.test(raw.id)) fail(`service id must match ^[a-z][a-z0-9._-]{0,63}$`);
  if (raw.description !== undefined && (typeof raw.description !== "string" || raw.description.length > 200)) {
    fail(`${id}: description must be a string ≤200`);
  }
}

export function validateServiceManifest(input: unknown): ServiceManifest {
  if (!isRecord(input)) fail("service manifest must be an object");
  if (input.schemaVersion !== 1) fail("service schemaVersion must be 1");
  if (input.kind === "host") {
    const raw = input;
    const id = String(raw.id ?? "");
    validateCommon(raw, ["schemaVersion", "kind", "id", "description", "command", "tokenEnv", "healthUrl", "readyTimeoutMs", "stopGraceMs", "pathMapping"], id);
    if (!Array.isArray(raw.command) || raw.command.length === 0 || raw.command.some((c) => typeof c !== "string" || c.length === 0)) {
      fail(`${id}: command must be a non-empty argv array`);
    }
    if (typeof raw.tokenEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(raw.tokenEnv)) {
      fail(`${id}: tokenEnv must be an env variable name`);
    }
    if (typeof raw.healthUrl !== "string" || !/^http:\/\/127\.0\.0\.1:\d{1,5}\/.*$/.test(raw.healthUrl)) {
      fail(`${id}: healthUrl must be http://127.0.0.1:<port>/...`);
    }
    const num = (v: unknown, field: string) => {
      if (v !== undefined && (!Number.isFinite(v) || (v as number) <= 0)) fail(`${id}: ${field} must be positive`);
    };
    num(raw.readyTimeoutMs, "readyTimeoutMs");
    num(raw.stopGraceMs, "stopGraceMs");
    let pathMapping: HostServiceManifest["pathMapping"];
    if (raw.pathMapping !== undefined) {
      if (!isRecord(raw.pathMapping)
        || typeof raw.pathMapping.hostRoot !== "string" || raw.pathMapping.hostRoot.length === 0
        || typeof raw.pathMapping.execRootEnv !== "string" || raw.pathMapping.execRootEnv.length === 0) {
        fail(`${id}: pathMapping must be { hostRoot, execRootEnv }`);
      }
      pathMapping = { hostRoot: raw.pathMapping.hostRoot, execRootEnv: raw.pathMapping.execRootEnv };
    }
    return {
      schemaVersion: 1,
      kind: "host",
      id,
      command: [...(raw.command as string[])],
      tokenEnv: raw.tokenEnv as string,
      healthUrl: raw.healthUrl as string,
      ...(typeof raw.description === "string" ? { description: raw.description } : {}),
      ...(typeof raw.readyTimeoutMs === "number" ? { readyTimeoutMs: raw.readyTimeoutMs } : {}),
      ...(typeof raw.stopGraceMs === "number" ? { stopGraceMs: raw.stopGraceMs } : {}),
      ...(pathMapping ? { pathMapping } : {}),
    };
  }
  if (input.kind === "compose") {
    const raw = input;
    const id = String(raw.id ?? "");
    validateCommon(raw, ["schemaVersion", "kind", "id", "description", "composeFile", "projectName"], id);
    if (typeof raw.composeFile !== "string" || raw.composeFile.length === 0) fail(`${id}: composeFile required`);
    if (typeof raw.projectName !== "string" || raw.projectName.length === 0) fail(`${id}: projectName required`);
    return {
      schemaVersion: 1,
      kind: "compose",
      id,
      composeFile: raw.composeFile,
      projectName: raw.projectName,
      ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    };
  }
  fail("service kind must be host or compose");
}
