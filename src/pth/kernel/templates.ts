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
}

// ── 工具：JSON 嵌入辅助 ──────────────────────────────────────

const j = (v: unknown): string => JSON.stringify(v);

// ── 模板 1：recon（信息搜集）──────────────────────────────────
// web.fetchText(url) → 定位章节（可选）→ llm.complete 转写 → memory.write
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
  "{id, kind, anchors, content}",
  "id 用 " + ${j(entryId)} + "；kind 用 " + ${j(kind)} + "；",
  "anchors 用英文关键词数组；content 用中文总结核心内容（300 字内），覆盖：主题、关键概念、要点。",
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
  entry = { id: ${j(entryId)}, kind: ${j(kind)}, anchors: ${j(anchors)}, content: res.content };
}
// 锚点强制并集：调用方传入锚点 + LLM 生成锚点（保证检索稳定性——deepseek 常自由发挥）
const mergedAnchors = Array.from(new Set([...(Array.isArray(entry.anchors) ? entry.anchors : []), ...${j(anchors)}]));
await memory.write({
  visibility: "public",   // ASP 可见性显式声明（模板=系统资产——全局共享）
  id: entry.id ?? ${j(entryId)},
  kind: entry.kind ?? ${j(kind)},
  anchors: mergedAnchors.length > 0 ? mergedAnchors : ${j(anchors)},
  content: entry.content ?? res.content,
  status: "official",
  meta: { source: url, provider: "deepseek", model: res.model, template: "recon-doc", section: ${j(section ?? null)} },
});
const check = await memory.retrieve({ anchors: ${j(anchors.length ? [anchors[0]] : ["recon"])} });
return { written: true, entryId: entry.id ?? ${j(entryId)}, storedCount: check.length, model: res.model, fetchedChars: doc.length };`;
};

// ── 模板 2：memory（记忆维护）────────────────────────────────
// memory.retrieve(anchors) → llm 整理/沉淀 → memory.write 写回
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
  "输出 JSON：{id, kind, anchors, content}",
  "content 用中文，300 字内，提炼关键信息与去重后的要点。",
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
  entry = { id: ${j(entryId)}, kind: ${j(kind)}, anchors: ${j(anchors)}, content: res.content };
}
await memory.write({
  visibility: "public",   // ASP 可见性显式声明（模板=系统资产——全局共享）
  id: entry.id ?? ${j(entryId)},
  kind: entry.kind ?? ${j(kind)},
  anchors: Array.isArray(entry.anchors) && entry.anchors.length > 0 ? entry.anchors : ${j(anchors)},
  content: entry.content ?? res.content,
  status: "official",
  meta: { provider: "deepseek", model: res.model, template: "memory-maintain", sourceCount: found.length },
});
return { written: true, entryId: entry.id ?? ${j(entryId)}, sourceCount: found.length, model: res.model };`;
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
    description: "TS 任务代码（可调 python/bash/fs/state 能力）→ 执行 → 结果沉淀记忆。",
    params: [
      { key: "description", required: true, description: "TS 任务代码（顶层 return 结果）" },
      { key: "entryId", required: false, description: "产物记忆 id（默认 dev-ts-<时间>）" },
      { key: "anchors", required: false, description: "产物记忆锚点（默认 [dev, artifact]）" },
    ],
    render: DEV_TASK_TS,
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
