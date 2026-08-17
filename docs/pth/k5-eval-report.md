# K5 双域可信评测报告（2026-08-18，F4 重建）

> 评测批契约：`docs/pth/n24-f4-contract.md`（AB-06 / AB-07 / AB-08 / 6.4 / 6.5 / 6.6）。
> 数据：source registry 12 条（每域 6，registryFingerprint + artifactHash）· domain-fact 24 条
> （每域 12）· 冻结查询 84 条（标准 60 + 每域 hard negative 6 / 多域 4 / 混淆 2）。

## 指标（生产 Catalog / 生产 ranking / DB evidence 实测）

| 指标 | 离线（内存 knowledge） | live（真实 PgMemoryStore） | 阈值 |
|---|---|---|---|
| queryCount | 84 | 84 | — |
| standardQueryCount | 60 | 60 | — |
| domainRecallAt3 | **1.0000** | **1.0000** | ≥ 0.9 |
| domainTop1 | 0.9833 | 0.9833 | 报告项 |
| knowledgeRecallAt5 | **1.0000** | **1.0000** | ≥ 0.9 |
| evidenceCoverage | **1.0000** | **1.0000** | ≥ 0.95 |
| hardNegativePassRate | **1.0000** | **1.0000** | = 1.0 |
| multiDomainResolution | **1.0000** | **1.0000** | = 1.0 |
| distractorTop3Rate | **1.0000** | **1.0000** | ≥ 0.9 |

- 离线 84/84 查询全部 pass；`--live` 为向运行中 PostgreSQL 用 `scripts/seed-k5-pilot.ts`
  落库 36 条（source meta 含 `artifactHash`/`snapshotContent`，knowledge meta 含结构化
  `evidence` 与 canonical `provenance`）后、按生产路径（resolver → `rankKnowledgeEntries`
  → top5，evidence 只读 DB `meta.evidence`）实测，84/84 pass。
- 生产 catalog 由 `DISCIPLINE_DEFINITIONS` + `DisciplineCatalogBuilder` 构建，版本不再
  `d8429659`；aliases 覆盖已合入生成数据（`discipline-alias-overrides.ts`）。

## 已知边界（非指标造假）

1. `domainTop1` 的 59/60：`ms-13` 使用“电化学稳定窗口”，resolver 别名扫描会先命中
   `chemistry` 的 zh-CN 子串，`materials-science` 位于 top3 第 2 位——domainRecallAt3
   不受影响，其余窗口题使用“稳定电压窗口”等价表述。
2. live 检索收窄 `kinds = ["domain-fact"]`：冻结查询集评估的是 domain-fact 知识，离线
   `PILOT_KNOWLEDGE` 也全为 domain-fact；收窄避免生产库中 task-insight/skill 等非评测
   条目污染 top-5（生产路径仍为同一 PgMemoryStore.retrieve + `rankKnowledgeEntries`）。
3. 当前知识条目为 curated seed；真实任务产出的 candidate 经 K4 晋升后仍按同一
   ranking 规则参与检索，评测器可随时重跑。
4. 评测覆盖域内检索、溯源、硬负例、多域组合与近义混淆；未覆盖更细粒度方法锚点
   （methodAnchors/toolAnchors 仍为空，等待生产注册）。
