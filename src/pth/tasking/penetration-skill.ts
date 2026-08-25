/**
 * tasking/penetration-skill.ts —— W8 P3 穿透 skill 接口位 + 0.16.3 执行面配套。
 *
 * 穿透 = 类型树上的固化捷径边（0.16.3）：把「父类型 → 直接子类型」的稳定派发路径
 * 注册成特殊 skill（skill:penetrate:<child>）。本模块落：
 *   - 类型/内容四段式（可被 listSkills 三要素读取）；
 *   - 注册校验：parent→child 必须命中组织权矩阵（allowedDelegationTargets）；
 *   - 内存条目构造器（优化管线发现→审批→注册时直接落库）。
 * 执行面（2026-08-18 已落）：tasking/penetration-runner.ts——tasks.penetrate 显式原语，
 * 执行期重验组织权 + official 门槛 + 边归属校验；稳定路径自动发现→提案通道后续。
 */

import {
  allowedDelegationTargets,
} from "./delegation-policy.js";
import { knownRoleById } from "@away_from/pth-kernel-execution";

export const PENETRATION_SKILL_ID_PREFIX = "skill:penetrate:";
export const PENETRATION_SKILL_NAME_PREFIX = "penetrate:";
export const PENETRATION_SKILL_FORMAT = "skill-penetration-v1";

export interface PenetrationEdgeSpec {
  /** 调用方类型（谱系角色 id） */
  parent: string;
  /** 被穿透调用的直接子类型 */
  child: string;
  /** 输入契约（给子类型的自包含输入描述） */
  inputContract: string;
  /** 产物契约（子类型 done.result 形状/验收标准） */
  outputContract: string;
  /** 四段式三要素 */
  anchor: string;
  whenToUse: string;
  effect: string;
  /** 注册时已固化的派发路径（parent...child）——可选，校验时若提供必须与谱系一致 */
  path?: readonly string[];
}

export type PenetrationSkillParseResult =
  | { ok: true; id: string; child: string; spec: PenetrationEdgeSpec; content: string }
  | { ok: false; error: string };

const EDGE_MARKER = "__penetration_edge__";

function jsonEscapeLine(s: string): string {
  return JSON.stringify(s);
}

/** 机读边信息（四段式 Pitfalls 段首行——人类可读 + 注册校验单一真相源） */
function edgeLine(spec: PenetrationEdgeSpec): string {
  const meta = JSON.stringify({
    parent: spec.parent,
    child: spec.child,
    input: spec.inputContract,
    output: spec.outputContract,
    ...(spec.path ? { path: spec.path } : {}),
  });
  return `- ${EDGE_MARKER} ${meta}`;
}

export function buildPenetrationSkillContent(spec: PenetrationEdgeSpec): string {
  return `# skill:penetrate:${spec.child}（穿透——四段式 v1）

【场景锚点】${spec.anchor}
【何时用】${spec.whenToUse}
【效果】${spec.effect}

## Procedure（每步标注调用代价）
1. 由 ${spec.parent} 直接调用子类型 ${spec.child}，跳过逐级派发与任务池往返（代价：1×穿透边调用）
2. 输入自包含契约：${jsonEscapeLine(spec.inputContract)}（代价：0）
3. 产物按契约回流并校验：${jsonEscapeLine(spec.outputContract)}（代价：1×回流校验）

## Pitfalls（已知失败模式与修正）
${edgeLine(spec)}
- 只用于已固化的稳定路径——路径漂移时先走治理通道重新注册，不就地改边
- 调用方不在授权矩阵内 → 注册校验拒绝（组织权机器校验不信任自报）

## Verification（怎么确认成功）
- 注册校验通过：${spec.parent} 在组织权矩阵内可投递 ${spec.child}
- skill:penetrate:${spec.child} 可被 listSkills 三要素读取
`;
}

export function parsePenetrationSkillContent(content: string): PenetrationSkillParseResult {
  const text = String(content ?? "");
  const titleMatch = text.match(/^#\s*skill:(penetrate:[a-z0-9][a-z0-9-]{0,63})/m);
  const childName = titleMatch?.[1];
  if (!childName) {
    return { ok: false, error: "穿透 skill 标题缺失或非法（应为 `# skill:penetrate:<child>`）" };
  }
  const child = childName.slice("penetrate:".length);
  const anchor = text.match(/【场景锚点】([^\n]*)/)?.[1]?.trim() ?? "";
  const whenToUse = text.match(/【何时用】([^\n]*)/)?.[1]?.trim() ?? "";
  const effect = text.match(/【效果】([^\n]*)/)?.[1]?.trim() ?? "";
  if (!anchor || !whenToUse || !effect) {
    return { ok: false, error: "穿透 skill 四段式不完整：场景锚点/何时用/效果 缺一不可" };
  }
  const edgeMatch = text.match(new RegExp(`${EDGE_MARKER}\\s+(\\{.*\\})`));
  if (!edgeMatch) {
    return { ok: false, error: `穿透 skill 缺少机读边信息（${EDGE_MARKER} 行）` };
  }
  let edge: Record<string, unknown>;
  try {
    edge = JSON.parse(edgeMatch[1]!) as Record<string, unknown>;
  } catch {
    return { ok: false, error: "穿透 skill 机读边信息 JSON 非法" };
  }
  const parent = typeof edge.parent === "string" ? edge.parent : "";
  const edgeChild = typeof edge.child === "string" ? edge.child : "";
  const inputContract = typeof edge.input === "string" ? edge.input : "";
  const outputContract = typeof edge.output === "string" ? edge.output : "";
  if (!parent || !edgeChild || edgeChild !== child) {
    return { ok: false, error: "穿透 skill 边信息不完整：parent/child 必填且 child 必须与标题一致" };
  }
  if (!inputContract.trim() || !outputContract.trim()) {
    return { ok: false, error: "穿透 skill 边信息不完整：inputContract/outputContract 必填" };
  }
  return {
    ok: true,
    id: `${PENETRATION_SKILL_ID_PREFIX}${child}`,
    child,
    content: text,
    spec: {
      parent,
      child,
      inputContract,
      outputContract,
      anchor,
      whenToUse,
      effect,
      ...(Array.isArray(edge.path) && edge.path.every((p) => typeof p === "string")
        ? { path: edge.path as string[] }
        : {}),
    },
  };
}

export type PenetrationSkillRegisterResult =
  | { ok: true; id: string; child: string; parent: string; content: string }
  | { ok: false; error: string };

/**
 * 注册校验（组织权机器校验——不信任 skill 自报）：
 *  - child/parent 必须是已注册角色；
 *  - parent→child 必须命中 allowedDelegationTargets（直接子类型/补充权/三源森林合法投递边）；
 *  - 若 spec.path 提供，末位必须等于 child 且包含 parent。
 */
export function validatePenetrationSkillRegistration(content: string): PenetrationSkillRegisterResult {
  const parsed = parsePenetrationSkillContent(content);
  if (!parsed.ok) return parsed;
  const { child, spec } = parsed;
  const childRole = knownRoleById(child);
  if (!childRole) {
    return { ok: false, error: `穿透目标角色未注册: ${child}` };
  }
  const parentRole = knownRoleById(spec.parent);
  if (!parentRole) {
    return { ok: false, error: `穿透调用方角色未注册: ${spec.parent}` };
  }
  const allowed = allowedDelegationTargets(spec.parent);
  if (!allowed.includes(child)) {
    return {
      ok: false,
      error: `组织权拒绝：${spec.parent} 不可投递 ${child}（可投递: ${allowed.length > 0 ? allowed.join("/") : "无"}）`,
    };
  }
  if (spec.path) {
    if (spec.path[spec.path.length - 1] !== child || !spec.path.includes(spec.parent)) {
      return { ok: false, error: `穿透路径与谱系不一致：path=${spec.path.join("/")}（应含 ${spec.parent} 且以 ${child} 结尾）` };
    }
  }
  return { ok: true, id: parsed.id, child, parent: spec.parent, content: parsed.content };
}

/** 内存条目构造器（优化管线发现→审批→注册落库时直接消费） */
export function buildPenetrationSkillEntry(
  content: string,
  opts: { status?: "official" | "draft" } = {},
): { id: string; kind: "skill"; anchors: string[]; content: string; status: "official" | "draft"; meta: Record<string, unknown> } {
  const r = validatePenetrationSkillRegistration(content);
  if (!r.ok) throw new Error(r.error);
  const parsed = parsePenetrationSkillContent(content) as { ok: true; child: string; spec: PenetrationEdgeSpec };
  return {
    id: r.id,
    kind: "skill",
    anchors: ["skill", "penetration", parsed.child, parsed.spec.parent, "穿透", "固化捷径"],
    content: r.content,
    status: opts.status ?? "draft",
    meta: {
      format: PENETRATION_SKILL_FORMAT,
      child: parsed.child,
      parent: parsed.spec.parent,
      path: parsed.spec.path ?? [parsed.spec.parent, parsed.child],
    },
  };
}
