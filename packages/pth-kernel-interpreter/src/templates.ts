/**
 * kernel/templates.ts — 任务模板库（工具链优化：模板固化）
 *
 * 任务 = 一段 TS 代码（ts-interpreter 在 vm 白名单能力内执行）。手写代码易错
 * （试运行踩过字符串转义/JSON 拼接坑）。模板库把常用任务骨架参数化：
 *
 *   recon   信息搜集类：网络获取 → LLM 转写 → 记忆存储
 *   memory  记忆维护类：检索记忆区 → LLM 整理/沉淀 → 写回
 *   dev     开发类：任务描述 → python 解释器执行（完整能力）
 *
 * 渲染约定（防注入/转义错误——试运行教训）：
 *   - 所有参数经 JSON.stringify 嵌入（字符串安全序列化，杜绝手工拼接）
 *   - 任务代码只使用 vm 白名单能力（llm/memory/web/tasks/bash/python）
 */

import type { WorkMode } from "@away_from/pth-contracts";

export interface TaskTemplate {
  id: string;
  name: string;
  description: string;
  /** 派发角色标签（任务池纯化 D4——模板发布的默认路由依据，精确匹配 tag-registry） */
  roleTag: string;
  /** 渲染任务 text（TS 代码）。参数已 JSON 序列化嵌入。 */
  render(params: Record<string, unknown>): string;
  /** 模板需要的参数说明（命令补全/帮助用） */
  params: Array<{ key: string; required: boolean; description: string }>;
  /** 标题（缺省 `[id] name`；函数形态可依赖已渲染参数——如 entryId） */
  title?: string | ((params: Record<string, unknown>) => string);
  /** 系统内部模板：不出现在 /api/v1/kernel/templates 公开列表（仍可引用渲染） */
  hidden?: boolean;
  /** 渲染产物形态：ts-code（PTC 直接执行，缺省）/ natural-language（NL 任务——worker 转译） */
  renderKind?: "ts-code" | "natural-language";
  /** M0：code-owned Work Mode（缺省 run；系统/优化模板可显式 optimize/intake）。 */
  workMode?: WorkMode;
  /** 生命周期 P0：模板默认根目标（可选；发布时显式 goal > 模板 goal——逐字传播防长任务漂移）。 */
  goal?: string;
}

// ── 任务模板统一收口（A+，2026-08-16）────────────────────────────
// 发布 API / TriggerEngine / PerfStrategy 三消费方共用的“模板 → task”解析器。
// 必填校验发生在事件变量注入之后（url:"{{detail}}" 且 detail 为空 = missing）；
// 路由优先级：显式 role > 显式 tags > 模板 roleTag。

export interface TemplateTaskSpec {
  template: string;
  params?: Record<string, unknown>;
  /** 标题覆盖（支持 {{eventVar}} 注入；缺省用模板 title） */
  title?: string;
  /** 路由覆盖（非空才覆盖模板 roleTag） */
  tags?: string[];
  /** 显式 flow 角色（优先级高于 tags） */
  role?: string;
  /** 生命周期 P0：显式根目标覆盖（优先级高于模板 goal；不传则回退模板 goal） */
  goal?: string;
  /** 额外 payload（合并进 {template, params} 之后） */
  payload?: Record<string, unknown>;
}

export type TemplateTaskResolution =
  | { ok: true; title: string; text: string; tags: string[]; role?: string; goal?: string; workMode: WorkMode; payload: Record<string, unknown> }
  | { ok: false; code: "unknown-template" | "missing-params"; error: string; missing?: string[] };

/** 事件变量注入：字符串 `{{key}}` 递归替换（缺失 → 空字符串——与 trigger 旧语义一致） */
export function interpolateEventVars(value: unknown, vars: Record<string, string>): unknown {
  if (typeof value === "string") {
    return value.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? "");
  }
  if (Array.isArray(value)) return value.map((v) => interpolateEventVars(v, vars));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = interpolateEventVars(v, vars);
    return out;
  }
  return value;
}

/** 模板 → task 统一解析（发布 API / trigger / perf 策略共用） */
export function resolveTemplateTask(
  spec: TemplateTaskSpec,
  opts: { eventVars?: Record<string, string> } = {},
): TemplateTaskResolution {
  const tpl = getTemplate(spec.template);
  if (!tpl) return { ok: false, code: "unknown-template", error: `unknown template: ${spec.template}` };

  // 事件变量注入 → 必填校验（注入后仍为空 = missing）
  const vars = opts.eventVars ?? {};
  const params = interpolateEventVars(spec.params ?? {}, vars) as Record<string, unknown>;
  const missing = tpl.params
    .filter((p) => p.required && (params[p.key] === undefined || params[p.key] === null || params[p.key] === ""))
    .map((p) => p.key);
  if (missing.length > 0) {
    return { ok: false, code: "missing-params", error: `missing required params: ${missing.join(", ")}`, missing };
  }

  const text = tpl.render(params);
  // 路由优先级：显式 role > 显式 tags > 模板 roleTag
  const tags = Array.isArray(spec.tags) && spec.tags.length > 0 ? spec.tags.map(String) : [tpl.roleTag];
  const role = typeof spec.role === "string" && spec.role.trim() !== "" ? spec.role.trim() : undefined;
  const defaultTitle = typeof tpl.title === "function" ? tpl.title(params) : (tpl.title ?? `[${tpl.id}] ${tpl.name}`);
  const title = spec.title !== undefined ? String(interpolateEventVars(spec.title, vars)) : defaultTitle;
  const explicitGoal = typeof spec.goal === "string" && spec.goal.trim() !== "" ? spec.goal.trim() : undefined;
  const goal = explicitGoal ?? tpl.goal;
  return {
    ok: true,
    title,
    text,
    tags,
    ...(role ? { role } : {}),
    ...(goal && goal.trim() !== "" ? { goal: goal.trim() } : {}),
    workMode: tpl.workMode ?? "run",
    payload: { template: tpl.id, params, ...(spec.payload ?? {}) },
  };
}

/** 公开模板列表（hidden 系统内部模板不外显） */
export function listPublicTemplates(): TaskTemplate[] {
  return TASK_TEMPLATES.filter((t) => !t.hidden);
}

// ── 工具：JSON 嵌入辅助 ──────────────────────────────────────

const j = (v: unknown): string => JSON.stringify(v);

// ── 模板 1：recon（信息搜集）──────────────────────────────────
// web.fetchText(url) → 定位章节（可选）→ llm.complete 转写 → memory.write
// N29/P0-4（§1.6）：外部内容 + LLM 产物只能进 **private draft**——不再 direct public official。
// id/kind/status/visibility 全部由服务端模板参数固定，不接受 LLM（或调用方经 LLM 回传）自报；
// official 只能由 Promotion Service 在 Source Revision + Evidence + 双 verdict 满足后晋升。
const RECON_DOC = (p: Record<string, unknown>): string => {
  const url = String(p.url ?? "");
  const section = p.section ? String(p.section) : undefined;
  const anchors = Array.isArray(p.anchors) ? p.anchors.map(String) : [];
  const entryId = String(p.entryId ?? "recon-doc");
  const kind = String(p.kind ?? "research-note");
  const title = String(p.title ?? "文档转写");
  return `// 信息搜集任务：${title}
const url = ${j(url)};
const doc = await web.fetchText(url, { maxBytes: 1024 * 1024, timeoutMs: 60_000 });
${section
    ? `// 定位章节
const markers = ${j(section)};
const idx = doc.indexOf(markers);
const start = idx >= 0 ? Math.max(0, idx - 2000) : 0;
const chunk = doc.slice(start, start + 10000);`
    : `const chunk = doc.slice(0, 12000);`}
const sys = [
  "你是信息搜集专家。将以下文本转写为结构化记忆条目，只输出 JSON：",
  "{anchors, content}",
  "anchors 用英文关键词数组；content 用中文总结核心内容（300 字内），覆盖：主题、关键概念、要点。",
  "不要输出 id/kind/status——条目身份与状态由系统固定。",
].join("\\n");
const res = await llm.complete(
  [{ role: "system", content: sys }, { role: "user", content: chunk }],
  { model: "deepseek-v4-flash", provider: "deepseek" },
);
let entry: any;
try {
  const cleaned = res.content.replace(/^\`\`\`json?|\`\`\`$/g, "").trim();
  entry = JSON.parse(cleaned);
} catch {
  entry = { anchors: ${j(anchors)}, content: res.content };
}
// 锚点强制并集：调用方传入锚点 + LLM 生成锚点（保证检索稳定性——deepseek 常自由发挥）
const mergedAnchors = Array.from(new Set([...(Array.isArray(entry.anchors) ? entry.anchors : []), ...${j(anchors)}]));
await memory.write({
  visibility: "private",   // N29 P0-4：外部内容只进当前空间私有草稿（不共享、不进 authoritative 检索）
  id: ${j(entryId)},       // 服务端固定（LLM 不得改写条目身份）
  kind: ${j(kind)},        // 服务端固定
  anchors: mergedAnchors.length > 0 ? mergedAnchors : ${j(anchors)},
  content: entry.content ?? res.content,
  status: "draft",         // N29 P0-4：外部内容不得 direct official（晋升走 Promotion Service）
  meta: { source: url, provider: "deepseek", model: res.model, template: "recon-doc", section: ${j(section ?? null)} },
});
const check = await memory.retrieve({ anchors: ${j(anchors.length ? [anchors[0]] : ["recon"])} });
return { written: true, entryId: ${j(entryId)}, status: "draft", storedCount: check.length, model: res.model, fetchedChars: doc.length };`;
};

// ── 模板 2：memory（记忆维护）────────────────────────────────
// memory.retrieve(anchors) → llm 整理/沉淀 → memory.write 写回
// N29/P0-4：LLM 整理结果同样只能进 private draft（不得把 LLM 输出直接变成 official 知识）。
const MEMORY_MAINTAIN = (p: Record<string, unknown>): string => {
  const anchors = Array.isArray(p.anchors) ? p.anchors.map(String) : [];
  const task = String(p.task ?? "整理检索到的记忆，去重并提炼要点");
  const entryId = String(p.entryId ?? `memory-maintain-${Date.now() % 100000}`);
  const kind = String(p.kind ?? "memory-summary");
  return `// 记忆维护任务
const anchors = ${j(anchors)};
const found = await memory.retrieve({ anchors, excludeDrafts: false });
const sys = [
  "你是记忆维护专家。以下是记忆区检索结果。",
  "任务：" + ${j(task)} + "。",
  "输出 JSON：{anchors, content}",
  "content 用中文，300 字内，提炼关键信息与去重后的要点。",
  "不要输出 id/kind/status——条目身份与状态由系统固定。",
].join("\\n");
const payload = found.map(e => ({ id: e.id, kind: e.kind, content: e.content })).slice(0, 10);
const res = await llm.complete(
  [{ role: "system", content: sys }, { role: "user", content: JSON.stringify(payload, null, 2) }],
  { model: "deepseek-v4-flash", provider: "deepseek" },
);
let entry: any;
try {
  const cleaned = res.content.replace(/^\`\`\`json?|\`\`\`$/g, "").trim();
  entry = JSON.parse(cleaned);
} catch {
  entry = { anchors: ${j(anchors)}, content: res.content };
}
await memory.write({
  visibility: "private",   // N29 P0-4：整理结果先进私有草稿（晋升/共享走治理流）
  id: ${j(entryId)},       // 服务端固定
  kind: ${j(kind)},        // 服务端固定
  anchors: Array.isArray(entry.anchors) && entry.anchors.length > 0 ? entry.anchors : ${j(anchors)},
  content: entry.content ?? res.content,
  status: "draft",         // N29 P0-4：LLM 整理结果不得 direct official
  meta: { provider: "deepseek", model: res.model, template: "memory-maintain", sourceCount: found.length },
});
return { written: true, entryId: ${j(entryId)}, status: "draft", sourceCount: found.length, model: res.model };`;
};

// ── 模板 3：dev（开发类）──────────────────────────────────────
// description → python 解释器执行（子进程完整能力：文件/网络/系统）
// 约定：description 为 python 代码（或自然语言+代码，python 可运行即可）
const DEV_TASK = (p: Record<string, unknown>): string => {
  const description = String(p.description ?? "");
  const entryId = String(p.entryId ?? `dev-task-${Date.now() % 100000}`);
  const anchors = Array.isArray(p.anchors) ? p.anchors.map(String) : ["dev", "artifact"];
  return `// 开发任务
const description = ${j(description)};
// python 解释器执行（子进程，完整能力）
const result = await python.execute(description, { timeoutMs: 120_000 });
if (!result.ok) {
  throw new Error("python execution failed: " + (result.error?.message ?? "unknown"));
}
// 结果写入记忆（开发产物沉淀）
const stdout = (result.stdout ?? "").slice(0, 3000);
const stderr = (result.stderr ?? "").slice(0, 500);
await memory.write({
  visibility: "public",   // ASP 可见性显式声明（模板=系统资产——全局共享）
  id: ${j(entryId)},
  kind: "dev-artifact",
  anchors: ${j(anchors)},
  // content 只存执行输出（记忆可检索）；代码进 meta（防噪音）
  content: "开发任务输出: " + (stdout || stderr || "(无输出)"),
  status: "draft",
  meta: { provider: "python", template: "dev-task", description: description.slice(0, 500), stdout, stderr },
});
return { done: true, entryId: ${j(entryId)}, stdout: stdout.slice(0, 300) };`;
};

// ── 模板 3b：dev-task-ts（TS 多语言开发任务）──────────────────
// description = TS 任务代码（顶层 return 结果）——可调 python/bash/fs/state/llm/memory 能力。
// 用户代码包成 async 函数体（其 return 被捕获为 __out）；结果自动沉淀记忆（dev-artifact）。
const DEV_TASK_TS = (p: Record<string, unknown>): string => {
  const description = String(p.description ?? "");
  const entryId = String(p.entryId ?? `dev-ts-${Date.now() % 100000}`);
  const anchors = Array.isArray(p.anchors) ? p.anchors.map(String) : ["dev", "artifact"];
  return `// 开发任务（TS 多语言）
const __fn = async () => {
${autoExportBlock(description)}
};
const __out = await __fn();
// 结果沉淀记忆（dev-artifact）
await memory.write({
  visibility: "public",   // ASP 可见性显式声明（模板=系统资产——全局共享）
  id: ${j(entryId)},
  kind: "dev-artifact",
  anchors: ${j(anchors)},
  content: "开发任务输出: " + JSON.stringify(__out ?? null).slice(0, 2000),
  status: "draft",
  meta: { provider: "ts", template: "dev-task-ts", task: ${j(entryId)} },
});
return { done: true, entryId: ${j(entryId)}, output: __out };`;
};

/** 在用户代码的最后一个 return 前注入 globalThis 导出（refine 可提炼用户声明的函数/var） */
function autoExportBlock(code: string): string {
  const names = new Set<string>();
  for (const m of code.matchAll(/^\s*function\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]!);
  for (const m of code.matchAll(/^\s*var\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]!);
  if (names.size === 0) return code;
  const exports = [...names].map((n) => `  globalThis.${n} = ${n};`).join("\n");
  const lines = code.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*return\b/.test(lines[i]!)) {
      lines.splice(i, 0, exports);
      return lines.join("\n");
    }
  }
  return code + "\n" + exports;
}

// ── 模板注册表 ───────────────────────────────────────────────

export const TASK_TEMPLATES: TaskTemplate[] = [
  {
    id: "recon-doc",
    name: "信息搜集（文档转写）",
    roleTag: "recon",
    goal: "忠实转写指定 URL 文档为结构化记忆条目：不偏离原文、不补充源外信息、不臆造内容。",
    description: "从网络获取文档 → LLM 转写 → 记忆存储。可选 section 定位章节。",
    params: [
      { key: "url", required: true, description: "文档 URL（http/https）" },
      { key: "section", required: false, description: "章节标题（定位片段，默认全文前 12K）" },
      { key: "anchors", required: false, description: "记忆锚点数组（默认 [url]）" },
      { key: "entryId", required: false, description: "记忆条目 id（默认 recon-doc）" },
      { key: "kind", required: false, description: "记忆种类（默认 research-note）" },
    ],
    render: RECON_DOC,
  },
  {
    id: "memory-maintain",
    name: "记忆维护（整理沉淀）",
    roleTag: "memory",
    goal: "按检索锚点整理沉淀记忆：去重、提炼、保持事实一致，不引入未经验证的新断言。",
    description: "检索记忆区 → LLM 去重/提炼 → 写回新记忆。",
    params: [
      { key: "anchors", required: true, description: "检索锚点（决定检索哪些记忆）" },
      { key: "task", required: false, description: "整理任务描述（默认去重提炼）" },
      { key: "entryId", required: false, description: "新记忆条目 id" },
    ],
    render: MEMORY_MAINTAIN,
  },
  {
    id: "dev-task",
    name: "开发任务（代码执行）",
    roleTag: "code",
    goal: "按任务描述完成可验证的开发产物，以实际执行结果为准，不臆造输出。",
    description: "任务描述 → python 解释器执行（完整能力）→ 产物沉淀记忆。",
    params: [
      { key: "description", required: true, description: "开发任务描述（python 可执行）" },
      { key: "entryId", required: false, description: "产物记忆 id" },
      { key: "anchors", required: false, description: "产物记忆锚点" },
    ],
    render: DEV_TASK,
  },
  {
    id: "dev-task-ts",
    name: "开发任务（TS 多语言）",
    roleTag: "code",
    goal: "按任务描述完成可验证的 TS 开发产物，以实际执行结果为准，不臆造输出。",
    description: "TS 任务代码（可调 python/bash/fs/state 能力）→ 执行 → 结果沉淀记忆。",
    params: [
      { key: "description", required: true, description: "TS 任务代码（顶层 return 结果）" },
      { key: "entryId", required: false, description: "产物记忆 id（默认 dev-ts-<时间>）" },
      { key: "anchors", required: false, description: "产物记忆锚点（默认 [dev, artifact]）" },
    ],
    render: DEV_TASK_TS,
  },
  // 系统内部模板（hidden：不出现在 /templates 公开列表——trigger 统一收口 A+ 迁入）
  {
    id: "memory-sweep",
    name: "记忆维护巡检（归档候选提案）",
    roleTag: "memory",
    hidden: true,
    workMode: "optimize",
    goal: "扫描并提案归档过期/低命中/重复记忆条目，不直接执行归档，等待监督批准。",
    description: "系统内部：扫描过期 draft/低命中/重复条目 → 归档候选提案（监督批准后执行）。",
    params: [],
    title: "记忆维护巡检（归档候选提案）",
    renderKind: "natural-language",
    render: () => `你是记忆维护巡检任务。用 memory.query 检查：① status='draft' 且长期未更新的条目；② 低 hit_count 的 official 条目；③ 重复条目。对确认应归档的目标，用 memory.write 落一条 kind='memory-admin-proposal' 的 draft 提案，content 为 JSON：{"action":"archive","target":"<条目id>","rationale":"<归档理由>"}。不要直接归档/删除——监督层批准后由 memory-admin approve 执行。本次未发现候选则 done 空清单说明即可。`,
  },
];

export function getTemplate(id: string): TaskTemplate | undefined {
  return TASK_TEMPLATES.find((t) => t.id === id);
}

export function renderTaskTemplate(id: string, params: Record<string, unknown>): string | undefined {
  const tpl = getTemplate(id);
  if (!tpl) return undefined;
  return tpl.render(params);
}

/** 校验必填参数；返回缺参列表 */
export function validateTemplateParams(id: string, params: Record<string, unknown>): string[] {
  const tpl = getTemplate(id);
  if (!tpl) return ["unknown-template"];
  return tpl.params.filter((p) => p.required && (params[p.key] === undefined || params[p.key] === "")).map((p) => p.key);
}
