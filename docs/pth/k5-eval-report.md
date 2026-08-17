# K5 双域冻结评测报告（2026-08-18）

> 评测批契约：`docs/pth/n23-k5-eval-design.md`；实现 commit `75ea7e8`（已合并 main）。
> 数据：source registry 12 条（每域 6）· domain-fact 24 条（每域 12）· 冻结查询 60 条
> （每域 30，authoritative 查询带 expectedEntryIds）。

## 指标

| 指标 | 离线（内存 knowledge） | live（真实 PgMemoryStore） | 阈值 |
|---|---|---|---|
| queryCount | 60 | 60 | — |
| domainRecallAt3 | **1.0000** | **1.0000** | ≥ 0.9 |
| domainTop1 | 0.9833 | 0.9833 | 报告项 |
| knowledgeRecallAt5 | **1.0000** | **1.0000** | ≥ 0.9 |
| evidenceCoverage | **1.0000** | **1.0000** | ≥ 0.95 |

- 60/60 查询全部 pass；`--live` 为向运行中 PostgreSQL 用 `scripts/seed-k5-pilot.ts` 落库
  36 条后、按 K3 同规则（resolver + anchors/ancestors relevance + top5）实测。

## 已知边界（非指标造假）

1. `domainTop1` 的 59/60：`ms-13` 使用“电化学稳定窗口”，resolver 别名扫描会先命中
   `chemistry` 的 zh-CN 子串，`materials-science` 位于 top3 第 2 位——domainRecallAt3
   不受影响，其余窗口题使用“稳定电压窗口”等价表述。
2. 当前知识条目为 curated seed；真实任务产出的 candidate 经 K4 晋升后仍按同一
   anchors/relevance 规则参与检索，评测器可随时重跑。
3. 评测覆盖域内检索与溯源；未覆盖跨域组合（如 materials-science × artificial-intelligence）。
