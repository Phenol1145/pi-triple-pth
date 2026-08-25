# N17：A5 叶子角色 SOP 种子 / D1 MCP 拆解入 tool-reg 设计

> 2026-08-18 · 车道池 A5 + D1（用户：两者强关联、奠基性质）。
> 概念前提：`concepts.md §0.13`（生态转化：知识型 skill → 记忆区；工具型 MCP → 源码拆解
> 重实现）、`§8.3 W1/W4`（skill 四段式 SOP）、`N14`（tool-reg 治理通道）。
> 二者是 **N4 生态转化 pipeline 的两条腿**：A5 完成 skill 侧「每个叶子角色都有四段式 SOP」，
> D1 完成 MCP 侧「MCP 工具拆解重实现 → tool-proposal 治理注册」。均为 v1.2（N16 角色扩展）
> 的地基：新角色靠 SOP 种子 + 工具注册通道承接外部工具生态。

## 0. 车道划分与合并序

| 车道 | 内容 | 主要文件域 |
|---|---|---|
| **A5** | 全部 actuator 叶子角色（无子类型的 worker 角色）补齐四段式 SOP 种子并注入 prompt-docs | `packages/pth-memory/src/skill-format.ts`、`src/pth/kernel/prompt-docs.ts` |
| **D1** | MCP 工具包（已拆解重实现源码 + JSON schema）→ 校验/生成 ToolRegSpec → tool-proposal draft 批量落库；`manage.tool.importMcp` 入口 + `scripts/tools/import-mcp-bundle.ts` | `src/pth/tasking/mcp-decompose.ts`（新）、`src/pth/kernel/extensions/manage.ts`、`scripts/tools/import-mcp-bundle.ts`（新） |

合并序：A5 → D1（独立可交换；D1 不依赖 A5，A5 不依赖 D1——按 A5 先合并只为 review 顺序）。

---

## 1. A5：叶子角色 SOP 种子

### 1.1 范围钉死（实现不得增减）

以 `allWorkerRoles()` 中**当前 DEFAULT_ROLES 的无子类型角色**（actuator 叶子）为准，
逐一补齐缺种子的角色。现有种子已覆盖 `developer-sop` / `scout-sop` / `memory-keeper-sop`
（B4-2 裁决 A 的三条，`SEED_SKILL_SOPS` 保持不动）。

本次新增 **8 条**，id 必须精确为：

| id | 角色 | SOP 主题（从 role.prompt 提炼） |
|---|---|---|
| `writer-sop` | writer | 文档/报告写作：结构 → 内容 → 术语一致 → 交付 |
| `coder-sop` | coder | 实现：读契约 → 写代码 → 自验（执行/测试）→ 交付 |
| `debug-case-writer-sop` | debug-case-writer | bug 报告 → 最小复现 + 回归 + 边界用例 → 验证闭环 |
| `acceptor-sop` | acceptor | 验收：对照验收标准逐项核查 → 证据 → 结论（pass/reject） |
| `planner-sop` | planner | 计划分解：自包含子任务 + 依赖 DAG + 验收标准 + 时间复用 |
| `spider-sop` | spider | 抓取：目标清单 → 抓取 → 结构化抽取 → 压缩交接 |
| `solver-sop` | solver | 封闭求解：约束盘点 → 推导/验证 → 结论与边界 |
| `predictor-sop` | predictor | 预测：模型/假设 → 分尺度推理 → 校准记录 → 待验证边界 |

### 1.2 格式与注入（与既有种子完全同构）

- 在 `packages/pth-memory/src/skill-format.ts` 新增导出
  `export const SEED_LEAF_SOPS: SkillSopSeed[]`（8 条，类型 `SkillSopSeed`）；
- 每条必须：anchor/whenToUse/effect 三要素 + `procedure`（每步 `cost` 非空）+
  `pitfalls`（≥2 条，写已知失败模式与修正）+ `verification`（≥1 条，可证伪）；
- 内容必须引用该角色实际可用能力（如 planner 可用 tasks.delegate、debug-case-writer 的
  done.result 契约 repro/regression/boundary/verification、spider 的 web 抓取）——
  不写该角色没有的工具；
- `src/pth/kernel/prompt-docs.ts` 注入循环改为
  `[...SEED_SKILL_SOPS, ...SEED_OPT_SOPS, ...SEED_LEAF_SOPS]`（其余逻辑不动）。

### 1.3 A5 验收

- 扩展 `packages/pth-memory/test/skill-format.test.ts`：
  - `SEED_LEAF_SOPS.map(id)` 恰为上述 8 个；
  - 每条四段式完整、procedure 每步 cost 非空、pitfalls ≥2、verification ≥1；
  - 与 `SEED_SKILL_SOPS` / `SEED_OPT_SOPS` 无 id 冲突。
- 全量 vitest + `npm run lint` 绿；不在 A5 车道改 concepts.md。

---

## 2. D1：MCP 工具拆解 → tool-reg 提案

### 2.1 原则（0.13.1 钉死）

- **不做运行时 MCP 转接器**：本批只处理「已拆解重实现」的工具源码包；
- 输入 = 一个 JSON bundle：每个工具含 MCP 语义的 `inputSchema` + 重实现后的 TS/JS
  `source`（PTH ts 核可执行、无 import/require、无外部依赖）+ 尾调用表达式；
- 输出 = 逐工具的 `tool-proposal` **draft**（复用 N14 治理流——不直写 official；
  对抗性审核 → 监督批准 → `tool-reg` official 生效）；
- program 态能力边界继承 worker caps（N14 P2 裁决③）；执行期 import/require 仍由
  ts 核 preflight 兜底，本批导入期静态拒绝。

### 2.2 Bundle 格式（`mcp-tool-bundle-v1`）

```jsonc
{
  "format": "mcp-tool-bundle-v1",
  "server": "example-server",
  "tools": [
    {
      "name": "parse_log",                  // 必须匹配 TOOL_REG_NAME_RE
      "description": "解析日志首列时间戳",   // 可选；三要素缺省时由此派生
      "inputSchema": {                       // 可选；缺省 = 空对象参数
        "type": "object",
        "properties": { "text": { "type": "string" } },
        "required": ["text"]
      },
      "source": "function parseLog(text) { const m = text.match(/.../g); return m ?? []; }",
      "call": "parseLog(String(args.text))", // 必填：尾调用表达式（args.<param>）
      "anchor": "日志时间戳抽取",             // 可选；缺省派生
      "whenToUse": "解析杂乱日志首列时间戳",   // 可选；缺省派生
      "effect": "ISO 时间数组",               // 可选；缺省派生
      "roles": ["developer"],                 // 可选；缺省 ["developer","coder"]
      "pack": "util"                          // 可选；缺省 `mcp-<server>`
    }
  ]
}
```

三要素缺省派生规则（保证非空）：
- `anchor` = `${server}/${name}——${description 首句（≤80 字符）|| "MCP 拆解工具"}`；
- `whenToUse` = description 首句（同 anchor 的后半）|| "需要调用该 MCP 工具能力时"；
- `effect` = `返回 ${name} 的工具调用结果（program 态——ts 核执行）`。

### 2.3 新模块 `src/pth/tasking/mcp-decompose.ts`

```ts
export const MCP_BUNDLE_FORMAT = "mcp-tool-bundle-v1";

export interface McpBundleTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  source: string;
  call: string;
  anchor?: string; whenToUse?: string; effect?: string;
  roles?: string[]; pack?: string;
}
export interface McpToolBundle { format: string; server: string; tools: McpBundleTool[] }

export type McpBundleParseResult =
  | { ok: true; bundle: McpToolBundle }
  | { ok: false; errors: string[] };

export function parseMcpBundle(raw: unknown): McpBundleParseResult;
export function mcpToolToSpec(tool: McpBundleTool, server: string): { ok: true; spec: ToolRegSpec } | { ok: false; error: string };
export async function importMcpTools(store, bundle): Promise<{ imported: {name, proposalId}[]; failed: {name, error}[] }>;
```

校验规则（逐条拒绝，errors 全量收集）：
- `format === "mcp-tool-bundle-v1"`；`server` 非空（≤64，`[a-z0-9][a-z0-9._-]*` 校验）；
- `tools` 为非空数组；每个 name 非空且匹配 `TOOL_REG_NAME_RE`；
- `source` 非空；`source` 不得含真实代码层的 `import`/`require`（用
  `stripNonCode` 或等价扫描，字符串/注释中文本不误拒——与 ts-interpreter preflight 同源）；
- `call` 非空；
- `inputSchema` 若提供：必须 `{type:"object", properties: 对象}`，`required` 若提供必须
  数组且元素都在 properties 中；缺省 → `{type:"object", properties:{}, required:[]}`；
- `roles` 若提供：非空字符串数组；`pack` 若提供：非空；
- 生成 spec：`version:1`、`executor:{type:"program", source: `${source}\nreturn ${call};`}`、
  `promotedFrom: "mcp:<server>/<name>"`；
- `importMcpTools` 对每条：`validateToolRegSpec` → `proposeToolRegistration(store,
  { action:"register", name, spec, rationale: "MCP 拆解重实现导入" })`；
  `proposeToolRegistration` 失败（重名等）记 failed 不中断批量；**永不直写 official**。

### 2.4 manage 入口

`src/pth/kernel/extensions/manage.ts` 的 `manage.tool` 新增：

```ts
importMcp: async (opts: { bundle?: unknown }) => {
  const parsed = parseMcpBundle(opts?.bundle);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  const r = await importMcpTools(store as never, parsed.bundle);
  for (const ok of r.imported) ctx.onActivity?.({ kind: "tool.proposal.created", detail: ok.proposalId, at: Date.now() });
  return { ok: r.failed.length === 0, imported: r.imported, failed: r.failed };
}
```

- `doc` 字符串补一行说明 `manage.tool.importMcp({bundle})`；
- 事件复用 `tool.proposal.created`（触发既有 `tool-proposal-review` 自动审核）。

### 2.5 脚本 `scripts/tools/import-mcp-bundle.ts`

- 用法：`DATABASE_URL=… npx tsx scripts/tools/import-mcp-bundle.ts <bundle.json> [--dry-run]`
- 读文件 → `parseMcpBundle` → 每条 `mcpToolToSpec` 打印三要素/参数/source 长度；
- `--dry-run` 只校验不写库；真跑用 `PgMemoryStore` + `importMcpTools` 落 draft 提案，
  打印 proposal id（后续走既有 `/api/v1/kernel/memory-admin/approve` 批准）。
- 遵循 seed-tool-reg.ts 风格（pg.Pool + DATABASE_URL fail-closed + 幂等说明）。

### 2.6 D1 验收

- `test/pth-tasking/mcp-decompose.test.ts`（TDD 先测后写）：
  - parse：格式/server/name/source 空/import/require/坏 inputSchema 逐条拒绝且错误可读；
  - 合法 bundle 全量通过；三要素缺省派生与显式覆盖均正确；
  - `mcpToolToSpec`：spec.version=1、executor source 含尾调用、promotedFrom 前缀、参数映射；
  - `importMcpTools`：fake store 里每条落 draft tool-proposal、不落 tool-reg official；
    重名第二条 failed 不中断后续；
- `test/pth-kernel-extensions/manage-tool.test.ts` 增 `importMcp` 用例：合法 bundle →
  proposals draft + `tool.proposal.created` 事件；非法 bundle → `{ok:false, errors}`；
- 全量 vitest + `npm run lint` 绿；不在 D1 车道改 concepts.md。

---

## 3. 通用约束

- 两条车道各自 worktree + 车道分支：`.worktrees/a5` / `lane/a5-leaf-sops`；
  `.worktrees/d1` / `lane/d1-mcp-decompose`；基于当前 main HEAD 建分支；
- 不 npm install（node_modules 软链）、不改 README 徽章、不改 concepts.md/parallel-lanes.md/
  TODO.md（合并者统一归账）；
- 完成后各 lane 跑全量 vitest + `npm run lint`，提交一条 commit，不 merge/push；
- 返回改动文件清单、测试结果、与契约偏差。
