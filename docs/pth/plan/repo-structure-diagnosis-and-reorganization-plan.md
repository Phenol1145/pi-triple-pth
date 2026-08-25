# 仓库结构诊断与重组方案（2026-08-25）

> 触发：代码审计与大型文件拆分收尾后，对仓库整体结构做一次系统盘点。
> 范围：**诊断 + 方案**——本文件不搬动任何代码文件；所有物理重组项须经评审后单独执行。
> 关联：`docs/pth/report/code-audit-2026-08-24.md`（文件级审计）、`docs/pth/module-ownership.md`、`docs/pth/architecture.md`。

## 1. 现状快照（量化）

| 区域 | 规模 | 角色 |
|---|---|---|
| `packages/pth-*`（9 个 workspace 包） | 540 TS 文件 | 内核域：contracts / config / kernel-storage / kernel-interpreter / kernel-execution / memory / sandbox / console / cli |
| `src/pth/`（21 个子目录） | 267 TS 文件 | 应用/组装层：main.ts（API Host）、bootstrap、tasking、execution、catalog、gateway 等 |
| `src/cli/` | 2 项 | pth CLI 入口（pth-cli.ts + runtime/） |
| `test/` | 31 个顶层条目 | unit/ + integration/ + 24 个 pth-\* 主题目录 + 3 个散落文件 |
| `scripts/` | 57 个文件 | CI 门禁、验收、评估、生成、种子、运维混杂，无子目录 |
| `docs/` | 双根 | 根部 5 篇散落 md + adr/ + pth/（24 篇散落 md + contract/ design/ plan/ report/） |
| 根目录 | 杂散 | tsconfig.n28.json、tsconfig.n29.json、CONTEXT.md、dist/ |

**依赖方向（已验证干净）**：`src/` → `packages/` 单向（src 全部经 `@away_from/pth-*` 包名引用，107 处 contracts、75 处 kernel-execution 等）；`packages/` 无任何回指 `src/` 的 import。`@away_from/infra`、`@away_from/shared` 是外部 npm 依赖（pi-triple-deps 仓），不在本仓。

## 2. 诊断发现

### D1：三份"结构说明书"已与现实脱节（最高优先）

1. **`docs/pth/architecture.md`**：仍描述 2026-08-16 模块化 v2 时代的布局——`src/pth/contracts/`（已迁至 `packages/pth-contracts`）、`src/pth/contracts + tasking + runner …` 八模块表。对照现实：src/pth 已无 contracts 目录，包数量从 2 个变成 9 个。
2. **`docs/pth/module-ownership.md`**：PTH 归属清单只列了 `src/pth/**` + 3 个包（memory/sandbox/console），缺 contracts/config/kernel-storage/kernel-interpreter/kernel-execution/cli 六个包。
3. **`packages/pth-kernel-execution/src/prompt-docs.ts` 的 `PROJECT_DIR_DUTY`**：这张表**会被注入每个 worker 的提示词**（项目全貌），却包含 4 个已不存在的目录——`packages/framework`、`packages/infra`、`packages/shared`（拆仓到 pi-triple-ptl/deps 后移除）、`src/shared`。worker 正拿着一张过时地图工作。

### D2：src/pth 与 packages/pth-* 的职责重叠带

包拆分（ADR-0003）把"内核域"沉到 packages，但 src/pth 仍保留同名概念域：

| 概念 | src/pth | packages |
|---|---|---|
| execution | `src/pth/execution/`（72 文件，src 侧最大） | `pth-kernel-execution`（74 文件） |
| kernel | `src/pth/kernel/`（2 文件：assembly + 兼容门面） | `pth-kernel-execution` / `pth-kernel-interpreter` |
| tasking / catalog / bootstrap / gateway | 仅 src 侧 | — |
| contracts | — | 仅 packages 侧 |

当前依赖方向干净、边界检查（check-pth-boundaries）基线为 0 违规，所以这不是腐败，而是**收口叙事缺失**：新人（和 worker）无法从文档判断"一个功能该放 src 还是 packages"。

### D3：scripts/ 无分类堆积（57 文件）

至少 6 类混在一起：`check-*`（CI 门禁 ×8）、`accept-*`/`eval-*`（验收与评估 ×12）、`build-*`/`gen-*`（生成器）、`seed-*`（数据种子）、n28/n29 一次性 harness、shell/基线 JSON。`package.json` 只引用其中约 10 个，其余靠口口相传。

### D4：test/ 双约定并存

`unit/` + `integration/` 是旧约定；24 个 `pth-*` 主题目录是新约定（镜像被测模块）；根部还散落 `ptl-kernel-bridge.test.ts`、`zz-agent-dbg.test.ts`、`helpers.ts`、`setup.ts`。`zz-agent-dbg.test.ts` 命名看是调试残留。

### D5：docs 双根与根目录杂散

- `docs/` 根部：POSITIONING.md、fracta-engine-*.md ×2、execution-surface-v1-design.md 与 `docs/pth/` 平级，归属不明（部分是跨仓基线，应留在根部；execution-surface-v1-design.md 更像 pth/design）。
- 根目录：`tsconfig.n28.json`/`tsconfig.n29.json` 仅被 `scripts/accept-n2*.ts` 引用，属验收产物而非主构建配置；`CONTEXT.md` 是领域术语表，内容与 docs/ 强相关。

### D6：`packages/pth-cli` 是纯打包壳

无 src，只有 package.json + deploy/ 拷贝 + dist 输出（由 `build-pth-cli-package.sh` 填充）。合法但反直觉——需在结构文档里显式说明，否则会被误判为"空包待删"。

### D7：deploy/Dockerfile 未跟上 9 包拆分（2026-08-25 运行验证发现，已修复）

Dockerfile 停留在 3 包时代：`npm ci` 前只拷 3 个 workspace 清单（根 package.json 的 9 个 `file:` 依赖缺目标必失败）、构建序缺 contracts/config/kernel-\*、runtime 段只拷 3 个包的 dist。8/22 的镜像是 9 包拆分（`6c65c73`，8/23）前的最后可用构建。已于 2026-08-25 修复并通过完整镜像构建验证。

### D8：运行时数据资产不进 dist（2026-08-25 运行验证发现，已修复）

tsc 不搬非 TS 文件，但两处运行时依赖相对路径资产：
1. `role-catalog-loader.ts` 读 `catalog/data/roles/*.json`（42 张角色卡）——dist 缺失导致容器 bootstrap fail-closed；
2. `execution-target-registry.ts` 读 `deploy/executor-matrix.json`——Dockerfile 未拷。

修复：新增 `scripts/copy-runtime-assets.mjs`（挂入根 `build` 脚本与 Dockerfile 构建链）+ Dockerfile runtime 段补拷 `executor-matrix.json`。教训：**凡 `import.meta.url` 相对路径读资产，必须有对应构建期拷贝步骤**；建议 P4 阶段加机械化检查（扫描 `fileURLToPath(import.meta.url)` + fs 读的组合）。

## 3. 目标结构叙事（一句话版）

> **packages/pth-\* = 可独立发布的内核域能力；src/pth = 产品组装层与运行宿主（HTTP/gateway/任务调度/装配）；src/cli = CLI 入口；scripts/test/docs 按用途单一约定分区。**

判别规则：被 ≥2 个宿主（API host、batch worker、CLI、console）复用、且不依赖 Fastify/PG 连接装配的领域逻辑 → packages；只做装配、路由、进程生命周期、环境接线 → src/pth。

## 4. 重组方案（按风险递增，P0 即可独立执行）

### P0：文档纠偏（纯文档，零代码风险）

| # | 动作 | 工作量 |
|---|---|---|
| P0-1 | 重写 `docs/pth/architecture.md`：以 9 包 + src/pth 21 目录的现实重画分层图与模块速查表 | 中 |
| P0-2 | 更新 `docs/pth/module-ownership.md`：补齐 6 个新包归属，标注 pth-cli 为打包壳 | 小 |
| P0-3 | 修正 `prompt-docs.ts` 的 `PROJECT_DIR_DUTY` / `PROJECT_FILE_DUTY`：删除 4 个不存在目录，补 pth-contracts/config/console 等现状条目 | 小 |
| P0-4 | 新增 CI 保鲜测试：遍历 `PROJECT_DIR_DUTY` 的 key 断言目录存在——防再次腐化 | 小 |

### P1：杂散归位（移动 ≤6 个文件，改引用）

| # | 动作 | 风险点 |
|---|---|---|
| P1-1 | `tsconfig.n28/n29.json` → `scripts/accept/`（同步改 accept-n28/n29 脚本引用）；或先确认 n28/n29 验收已封存后连同学验脚本一起归档 | accept 脚本路径引用 |
| P1-2 | `CONTEXT.md` 迁 `docs/`（或保留根部但在 docs/README 登记——根目录 CONTEXT.md 对 agent 工具有约定价值，建议**保留**并加一行指向） | 外部工具约定 |
| P1-3 | `test/` 根部散落文件归位：`ptl-kernel-bridge.test.ts` → 对应主题目录；`zz-agent-dbg.test.ts` 评审后删除或改名归档；`helpers.ts`/`setup.ts` 保留（vitest 配置引用） | vitest.config 引用检查 |
| P1-4 | `docs/execution-surface-v1-design.md` 评审后迁入 `docs/pth/design/`（需重跑 docs manifest） | manifest 再生成 |

### P2：scripts/ 与 test/ 分区（纯搬移 + 路径引用更新）

- `scripts/check/`（8 个 check-\* + 各自 baseline JSON）、`scripts/accept/`（accept-\* + 签名/harness）、`scripts/eval/`（eval-\*）、`scripts/gen/`（build-\*/gen-\*）、`scripts/seed/`、`scripts/ops/`（shell/monitor）。
- 同步更新：`package.json` scripts 段、CI workflow、`import-cycles.baseline.json` 类基线里的路径。
- test/ 确立单一约定：以 `pth-*` 主题目录为准，`unit/`、`integration/` 内容并入对应主题目录或改名 `test/shared/`、`test/e2e/`。

### P3：src/pth ↔ packages 收口（需专项评审，不在本方案执行）

两个候选终态，需在实施前单独裁决（建议先出 ADR）：

- **候选 A（下沉）**：`src/pth/execution`（72 文件）中属领域逻辑的部分下沉 `pth-kernel-execution`，src 侧只留装配——与 ADR-0003 方向一致，但 diff 大、需分批。
- **候选 B（正名）**：承认 src/pth/execution 是"应用执行服务层"（任务调度、w8 dispatch、批次编排），改名/文档正名，不搬代码——低成本，但重叠叙事仍在。

`src/pth/kernel/`（2 文件）无论哪个候选都建议直接收口：assembly 并入 bootstrap，兼容门面确认无引用后删除。

### P4：机械化保障

- 扩展 `check-pth-boundaries` 或新增轻量检查：scripts/test 分区约定、根目录新增文件白名单（防再杂散）。
- `check-duplication` 已在 lint 链中；本方案 P0-4 的目录保鲜测试可并入同一批。

## 5. 不做的事（Non-goals）

- 不改任何运行时行为与公开 API；不动证据 JSON（n28/n29 等 byte-identical 约束）。
- 不触及 `deploy/`、`toolstore/`、`extensions/`、`config/`（部署与扩展物归属另行评审）。
- P3 的代码搬迁不在本轮范围；本方案只交付诊断 + 路线。

## 6. 验收标准

1. P0 完成后：`architecture.md` / `module-ownership.md` / `PROJECT_DIR_DUTY` 与磁盘现实一致，目录保鲜测试进 CI。
2. P1/P2 完成后：根目录仅保留主构建配置；scripts/test 单一分类约定；`npm run lint` 与全量 vitest 绿。
3. 全程非破坏性：除明确删除项（zz-agent-dbg 评审后）外，一律 git mv + 引用修复。

## 7. 建议执行顺序

P0-3 + P0-4 最先（worker 提示词注错地图是当前唯一**影响运行时行为**的问题）→ P0-1/P0-2 → P1 → P2 → P3 评审。
