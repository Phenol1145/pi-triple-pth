# N23：K5 评测批设计（双域冻结评测 + source registry）

> 2026-08-18 · 承接 `docs/pth/report/k5-pilot-report.md` §4：真实任务试点已过，
> 下一步在扩展前建立两个试点域的 **source registry + 30 题冻结查询集 + 可复现评测器**。
> 验收对标组合设计 §12.3（本批可离线全自动验证；`--live` 可选接运行栈）。

## 0. 车道

- 分支 `lane/k5-eval` / `.worktrees/k5-eval`；单 lane。

---

## 1. 数据文件（`src/pth/catalog/data/` 新增，均为机器可校验 TS 数据）

### 1.1 `pilot-domain-overrides.ts`

```ts
export interface PilotDomainOverride {
  id: string;                 // 必须已存在于 DISCIPLINE_DEFINITIONS
  aliases: string[];          // 追加的检索别名（小写/中文均可——resolver 大小写不敏感）
  names?: Record<string, string>;  // 覆盖 names（可选）
}
export const PILOT_DOMAIN_OVERRIDES: PilotDomainOverride[];
```

- 覆盖 `programming-languages` 与 `materials-science` 两个 id；
- 别名必须包含：编程语言 / 类型系统 / 编译器 / 程序分析 / 类型检查 / 中间表示 / 语言规范 /
  材料科学 / 固态电解质 / 离子电导率 / 电化学稳定窗口 / 材料数据库 / Materials Project / NOMAD；
- 提供 `buildPilotCatalog()`：把 overrides 合并进 `DISCIPLINE_DEFINITIONS`
  （aliases 追加去重、names 覆盖）后用 `DisciplineCatalogBuilder` 构建快照。

### 1.2 `pilot-source-registry.ts`

```ts
export interface PilotKnowledgeSource {
  id: string;
  domain: string;             // domain id
  authority: string;
  uri: string;
  version?: string;
  retrievedAt: string;        // ISO 日期
  license?: string;
  contentHash: string;        // sha256(uri|version|authority)
}
export const PILOT_SOURCES: PilotKnowledgeSource[];
```

- 两个域各至少 5 条（共 ≥10）：编程语言侧覆盖 JLS / Rust Reference / LLVM LangRef /
  C++ draft / Python Language Reference；材料科学侧覆盖 Materials Project / NOMAD / ICSD /
  AFLOW / 开放晶体学数据（实际 URI 用官方文档/站点根即可）。

### 1.3 `pilot-knowledge.ts`

```ts
export interface PilotKnowledgeEntry {
  id: string;                 // 全局唯一
  domain: string;
  kind: "domain-fact";
  anchors: string[];          // 含 domain id + 概念锚点
  content: string;            // 一句话权威定义/判据（≤300 字符）
  evidence: Array<{ sourceId: string; locator: string }>;  // sourceId 必须存在 PILOT_SOURCES
}
export const PILOT_KNOWLEDGE: PilotKnowledgeEntry[];
```

- 每个域 12 条（共 24）：编程语言域覆盖类型检查/中间表示/代码生成/类型系统/语义/ABI/
  标准库/内存模型等；材料科学域覆盖离子电导率/活化能/电化学窗口/界面稳定性/晶体结构/
  带隙/热稳定性/机械性能等。

### 1.4 `pilot-eval-queries.ts`

```ts
export interface PilotEvalQuery {
  id: string;                 // 全局唯一
  domain: string;             // 期望 domain
  text: string;               // 冻结查询（中文）
  authoritative: boolean;     // 是否需要权威事实/证据（§12.3）
  expectedEntryIds: string[]; // 期望 top-5 命中的 knowledge entry（≥1）
}
export const PILOT_EVAL_QUERIES: PilotEvalQuery[];
```

- 每个域 30 条（共 60），id 形如 `pl-01` / `ms-01`；
- 查询文本必须可被 resolver 的 alias 扫描命中（否则 domain recall 会自然暴露覆盖缺口——
  评测集允许包含 ≤10% 的“别名覆盖外”查询用于报告覆盖缺口，但**不得**靠删题硬凑指标）。

## 2. 评测器（`src/pth/catalog/pilot-evaluator.ts` 新）

```ts
export interface PilotEvalMetrics {
  domainRecallAt3: number;      // 期望 domain 出现在 resolver.matches 前 3
  domainTop1: number;           // primaryDomain = 期望 domain 占比
  knowledgeRecallAt5: number;   // 期望 entryId 出现在 top-5 检索结果
  evidenceCoverage: number;     // authoritative 查询命中的条目 100% 有 evidence 的占比
  queryCount: number;
  details: Array<{ queryId; domain; pass: boolean; reason?: string }>;
}

export function runPilotEval(input: {
  catalog: DisciplineCatalogSnapshot;
  knowledge: PilotKnowledgeEntry[];
  queries: PilotEvalQuery[];
  sources: PilotKnowledgeSource[];
}): PilotEvalMetrics;
```

- domain 解析：`createDisciplineResolver(catalog).resolve({ title:text.slice(0,80), text, tags:[], explicitDomains:[] })`；
- knowledge 检索：anchors = resolver.matches 的 domainIds；对 knowledge 计算 relevance =
  anchors ∩ (domains ∪ catalog.ancestors(domains))；relevance 降序 → id 升序 → top5
  （与 K3 provider 同规则）；
- evidence：命中条目的 evidence[].sourceId 全部存在于 sources；
- 指标计算必须确定性（同输入同输出）。

## 3. 脚本

- `scripts/seed/seed-k5-pilot.ts`：`DATABASE_URL=… npx tsx scripts/seed/seed-k5-pilot.ts [--check]`
  ——把 PILOT_SOURCES 与 PILOT_KNOWLEDGE 落 PgMemoryStore：
  - sources：kind=`knowledge-source`、status=official、tenant=default、id=`pilot-source:<id>`
    （非 provenance 门禁 kind，meta 存全量 source）；
  - knowledge：kind=`domain-fact`、status=official、tenant=default、
    meta.provenance 用 `buildKnowledgeProvenance` 生成（sourceTaskId=`k5-eval-seed`、
    producerRole=`k5-pilot-seed`、producerModel=`curated`、sourceRefs=evidence locators）；
    幂等（内容相同跳过）；
- `scripts/eval/eval-k5-pilot.ts`：`[--live]` 默认离线（用内存 knowledge）输出指标表；
  `--live` 时从 PgMemoryStore 按 K3 provider 规则检索后计算同样指标；
- 退出码：domainRecallAt3 ≥ 0.9 且 knowledgeRecallAt5 ≥ 0.9 且 evidenceCoverage ≥ 0.95 → 0；
  否则 1（报告缺口明细）。

## 4. 测试

- `test/pth-catalog/pilot-eval-data.test.ts`：数据形状（sources ≥10、knowledge=24、
  queries=60、query 的 domain/expectedEntryIds 都存在、sourceId 都存在）；
- `test/pth-catalog/pilot-evaluator.test.ts`：阈值达标（离线全套 0.9/0.9/0.95）+
  确定性（两次 run 相等）+ 失败用例可解释；
- 全量 vitest + `npm run lint` 绿。

## 5. 约束

- 不改 concepts/parallel-lanes/TODO/README/schema；一条 commit 到 `lane/k5-eval`，不 merge/push；
- 评测集内容必须是**人工可复核**的真实领域问题/答案，不写虚构文档段落；返回报告与指标。
