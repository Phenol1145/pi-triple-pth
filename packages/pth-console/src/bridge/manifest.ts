/**
 * bridge/manifest.ts — 构件清单校验器（ProgramManifest → ComponentManifest 泛化）
 *
 * type 分派校验：
 *   - agent-program（或缺省，旧 agent.json 原样通过）→ 原 validateManifest 逻辑
 *   - scheduler / optimizer / memory-pack / skeleton-update → 最小校验（name/type + payload 骨架）
 * 原 ProgramManifest 字段归入 agent-program 分支——完全等价映射，避免两套校验逻辑。
 * 手写校验，零外部依赖；NAME_RE/路径穿越防御等既有规则保留。
 */

/** 构件类型（5 类） */
export const COMPONENT_TYPES = [
  "agent-program",
  "scheduler",
  "optimizer",
  "memory-pack",
  "skeleton-update",
] as const;
export type ComponentType = (typeof COMPONENT_TYPES)[number];

/** agent 程序 manifest（agent.json 合法内容） */
export interface ProgramManifest {
  name: string;
  description?: string;
  model?: string;
  provider?: string;
  thinking?: string;
  systemPrompt?: string;
  skills?: string[];
  tools?: string[];
  excludeTools?: string[];
  input?: {
    schema?: Record<string, unknown>;
  };
  timeoutSec?: number;
}

/** 构件 manifest：type 分派；agent-program 时携带原 ProgramManifest 全部字段 */
export interface ComponentManifest extends ProgramManifest {
  type: ComponentType;
  version?: string; // version-pin
  payload?: Record<string, unknown>;
  targetSlot?: string; // 空位绑定（§5.2）
  legalAuth?: string; // 治理授权引用（§5.3）
}

/** 校验结果 */
export interface ManifestResult {
  ok: true;
  manifest: ProgramManifest;
}
export interface ComponentManifestResult {
  ok: true;
  manifest: ComponentManifest;
}
export interface ManifestError {
  ok: false;
  errors: string[];
}

/** name 正则：^[a-z0-9][a-z0-9-]{0,62}$ */
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** 允许的工具名（非空字母数字 + 下划线/连字符） */
const TOOL_RE = /^[a-zA-Z0-9_-]+$/;

/** 禁止路径穿越的字符 */
const DANGEROUS_PATH = /(?:^\.\.(?:\/|$)|(?:\/|^)\.\.$|(?:\/\.\.\/))/;

export function validateManifest(raw: unknown): ManifestResult | ManifestError {
  const errors: string[] = [];

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["agent.json 必须是 JSON 对象"] };
  }

  const m = raw as Record<string, unknown>;

  // name（必需，正则）
  if (typeof m.name !== "string" || !NAME_RE.test(m.name)) {
    errors.push("name 必需且格式为 a-z0-9 + 连字符（1~63 字符，首位字母或数字）");
  }

  // description（可选）
  if (m.description !== undefined && typeof m.description !== "string") {
    errors.push("description 必须是字符串");
  }

  // model/provider/thinking（可选字符串）
  for (const f of ["model", "provider", "thinking"]) {
    if (m[f] !== undefined && typeof m[f] !== "string") {
      errors.push(`${f} 必须是字符串`);
    }
  }

  // systemPrompt（可选，路径禁 `..`）
  if (m.systemPrompt !== undefined) {
    if (typeof m.systemPrompt !== "string") {
      errors.push("systemPrompt 必须是相对路径字符串");
    } else if (DANGEROUS_PATH.test(m.systemPrompt)) {
      errors.push(`systemPrompt 路径不得包含 ".."`);
    }
  }

  // skills（可选，字符串数组，路径禁 `..`）
  if (m.skills !== undefined) {
    if (!Array.isArray(m.skills) || !m.skills.every((s) => typeof s === "string")) {
      errors.push("skills 必须是字符串数组");
    } else {
      for (let i = 0; i < m.skills.length; i++) {
        if (DANGEROUS_PATH.test(m.skills[i] as string)) {
          errors.push(`skills[${i}] 路径不得包含 ".."`);
          break;
        }
      }
    }
  }

  // tools/excludeTools（可选，字符串数组）
  for (const f of ["tools", "excludeTools"]) {
    if (m[f] !== undefined) {
      if (!Array.isArray(m[f]) || !(m[f] as any[]).every((s) => typeof s === "string")) {
        errors.push(`${f} 必须是字符串数组`);
      } else {
        for (let i = 0; i < (m[f] as string[]).length; i++) {
          if (!TOOL_RE.test((m[f] as string[])[i]!)) {
            errors.push(`${f}[${i}] 包含非法字符`);
            break;
          }
        }
      }
    }
  }

  // input
  if (m.input !== undefined) {
    if (typeof m.input !== "object" || m.input === null || Array.isArray(m.input)) {
      errors.push("input 必须是对象");
    }
  }

  // timeoutSec（可选，1-3600 整数）
  if (m.timeoutSec !== undefined) {
    if (typeof m.timeoutSec !== "number" || !Number.isFinite(m.timeoutSec) || m.timeoutSec < 1 || m.timeoutSec > 3600) {
      errors.push("timeoutSec 必须是 1-3600 的整数");
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    manifest: {
      name: m.name as string,
      description: m.description as string | undefined,
      model: m.model as string | undefined,
      provider: m.provider as string | undefined,
      thinking: m.thinking as string | undefined,
      systemPrompt: m.systemPrompt as string | undefined,
      skills: m.skills as string[] | undefined,
      tools: m.tools as string[] | undefined,
      excludeTools: m.excludeTools as string[] | undefined,
      input: m.input as { schema?: Record<string, unknown> } | undefined,
      timeoutSec: m.timeoutSec as number | undefined,
    },
  };
}

/** 通用扩展字段校验（version/payload/targetSlot/legalAuth——各 type 共用） */
function validateComponentExtras(m: Record<string, unknown>, errors: string[]): void {
  if (m.version !== undefined && typeof m.version !== "string") {
    errors.push("version 必须是字符串");
  }
  if (m.payload !== undefined) {
    if (typeof m.payload !== "object" || m.payload === null || Array.isArray(m.payload)) {
      errors.push("payload 必须是 JSON 对象");
    }
  }
  for (const f of ["targetSlot", "legalAuth"]) {
    if (m[f] !== undefined && typeof m[f] !== "string") {
      errors.push(`${f} 必须是字符串`);
    }
  }
}

/**
 * 构件清单分派校验器。
 * type 缺省 → agent-program（旧 agent.json 原样通过）；
 * type=agent-program → 原 validateManifest 逻辑 + 扩展字段校验；
 * 其余类型 → 最小校验（name/type 合法、payload 结构骨架校验）。
 */
export function validateComponentManifest(raw: unknown): ComponentManifestResult | ManifestError {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["manifest 必须是 JSON 对象"] };
  }
  const m = raw as Record<string, unknown>;

  // type 分派（缺省 → agent-program，兼容旧 agent.json）
  let type: ComponentType = "agent-program";
  if (m.type !== undefined) {
    if (typeof m.type !== "string" || !(COMPONENT_TYPES as readonly string[]).includes(m.type)) {
      return { ok: false, errors: [`type 必须是 ${COMPONENT_TYPES.join(" | ")} 之一`] };
    }
    type = m.type as ComponentType;
  }

  if (type === "agent-program") {
    const legacy = validateManifest(raw);
    if (!legacy.ok) return legacy;
    const errors: string[] = [];
    validateComponentExtras(m, errors);
    if (errors.length > 0) return { ok: false, errors };
    return {
      ok: true,
      manifest: {
        type,
        ...legacy.manifest,
        version: m.version as string | undefined,
        payload: m.payload as Record<string, unknown> | undefined,
        targetSlot: m.targetSlot as string | undefined,
        legalAuth: m.legalAuth as string | undefined,
      },
    };
  }

  // 其余类型：最小校验
  const errors: string[] = [];
  if (typeof m.name !== "string" || !NAME_RE.test(m.name)) {
    errors.push("name 必需且格式为 a-z0-9 + 连字符（1~63 字符，首位字母或数字）");
  }
  if (m.description !== undefined && typeof m.description !== "string") {
    errors.push("description 必须是字符串");
  }
  validateComponentExtras(m, errors);
  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    manifest: {
      type,
      name: m.name as string,
      description: m.description as string | undefined,
      version: m.version as string | undefined,
      payload: m.payload as Record<string, unknown> | undefined,
      targetSlot: m.targetSlot as string | undefined,
      legalAuth: m.legalAuth as string | undefined,
    },
  };
}
