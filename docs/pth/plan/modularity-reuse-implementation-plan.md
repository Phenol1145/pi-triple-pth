# 模块化与复用优化实施计划（基于 2026-08-22 审计）

> 依据：`docs/pth/report/modularity-reuse-audit.md`
> 目标：消除已发现的静态运行时环，收敛成体系重复，降低 PTH 引擎内部认知成本。
> 原则：每阶段独立可合入、全量门禁通过后再进下一阶段；不改变 PTL/PTH 产品边界。

## 阶段总览

| 阶段 | 内容 | 优先级 | 状态 |
|---|---|---|---|
| Phase 0 | 增加 import 环检测 CI 门禁 | P0 | 已完成 |
| Phase 1 | 拆掉 `execution ↔ runner` 静态运行时环 | P0 | 已完成 |
| Phase 2 | 快速复用优化（CLI helper / runtime adapter / memory lib / 文档修复） | P1 | 已完成 |
| Phase 3 | 需要决策的收敛项（_shared 去重 / 双 UI 栈 / kernel 再拆分） | P2 | 已完成 |

> 后续执行入口：本计划 Phase 0–3 的收尾与 N28/N29 复验、kernel 子包拆分、发布统一在
> [`docs/pth/plan/modularity-and-feasibility-followup-implementation-plan.md`](./modularity-and-feasibility-followup-implementation-plan.md)
> 的 Phase A–E 中推进。截至 2026-08-23，Phase A–D 已完成，Phase E 全量验收/文档/发布收尾中。

---

## Phase 0：循环依赖门禁

### 目标
让“新增循环依赖”在 CI/lint 阶段直接失败，防止 P0 修完后回潮。

### 任务
1. 新增 `scripts/check-import-cycles.ts`
   - 扫描 `src/pth/**`、`packages/*/src/**`、`src/cli/**` 的 git 跟踪 TS/TSX 文件
   - 解析静态 `import/export from` 与动态 `import()`，分别建图
   - 检测 SCC：
     - `static-runtime`（静态非 type import）必须为 0
     - `static-all` 与 `dynamic` 环输出 warning 或单独报告，不阻塞（当前仍有 type/dynamic 环）
   - 支持 `--update` 只读输出基线（便于后续逐步收紧）
2. `package.json` 增加 `"check:import-cycles": "tsx scripts/check-import-cycles.ts"`
3. `lint` 脚本追加 `npm run check:import-cycles`
4. 补充 `test/pth-architecture/import-cycles.test.ts`，调用同一扫描函数，断言 static-runtime SCC = 0

### 验收
- `npm run check:import-cycles` 当前能稳定输出：static-runtime = 1（Phase 1 前）、static-all = 2、dynamic = 若干
- `npm run lint` 在 Phase 0 单独合入时允许“已知 1 个 static-runtime 环”通过（用基线文件记录），Phase 1 后收紧为 0

### 风险
- 扫描器正则可能误报/漏报；需先用现有代码校准基线，再启用门禁。

---

## Phase 1：拆掉 `execution ↔ runner` 静态运行时环

### 目标
消除审计发现的唯一 static-runtime SCC：

```
execution/index.ts
  → execution/knowledge-broker.ts
    → runner/index.ts
      → runner/cognitive-working-set.ts
        → execution/index.ts
```

### 根因
- `execution/knowledge-broker.ts` 反向 import `runner/index` 获取 `computeKnowledgeQueryFingerprint`
- `runner/cognitive-working-set.ts` 正向 import `execution/index`

### 方案
1. 新增 `src/pth/contracts/knowledge-fingerprint.ts`
   - 纯函数模块，不依赖 `runner` / `execution`
   - 导出：
     - `fnv1aHex(input: string): string`
     - `computeKnowledgeQueryFingerprint(input: KnowledgeFingerprintInput): string`
     - `interface KnowledgeFingerprintInput`（`tenantId/space/roleId/domains/title/text/catalogVersion/workerId?`）
   - 把 `runner/knowledge-context.ts` 中的 `fnv1aHex` 与 `computeKnowledgeQueryFingerprint` 实现迁移至此
2. 更新 `src/pth/execution/knowledge-broker.ts`
   - 删除 `import { computeKnowledgeQueryFingerprint } from "../runner/index.js"`
   - 改为 `import { computeKnowledgeQueryFingerprint } from "../contracts/knowledge-fingerprint.js"`
3. 更新 `src/pth/runner/knowledge-context.ts`
   - 保留对外导出 `computeKnowledgeQueryFingerprint` / `fnv1aHex`（re-export），避免破坏既有调用方
   - 内部实现改为从 contracts 导入
4. 运行 `check:import-cycles`，确认 static-runtime SCC = 0
5. 把 Phase 0 基线收紧为 0

### 验收
- `npm run check:import-cycles`：static-runtime = 0
- `npm run lint` / `npm run build` / `npx vitest run` 全绿
- 相关测试：`test/pth-execution/knowledge-broker*`、`test/pth-runner/*`、`test/pth-contracts/*`

### 风险
- `KnowledgeContextInput` 与新的 `KnowledgeFingerprintInput` 可能字段不一致；需保留原语义，必要时用结构兼容类型。

---

## Phase 2：快速复用优化（P1）

### 2a. CLI `requireClient()` 收敛

#### 现状
`packages/pth-console/src/commands/` 下 10+ 个文件重复：

```ts
const client = PthClient.fromConfig();
if (!client) { console.error(...); process.exit(1); }
```

#### 方案
1. 新增 `packages/pth-console/src/commands/client.ts`
   - 导出 `requireClient(): PthClient`
   - 可选导出 `withClient<T>(fn: (client: PthClient) => Promise<T>): Promise<T>` 统一错误处理
2. 更新 `bench/debug/jobs/kernel/observe/programs/request/run/submit/trigger` 等命令文件
   - 删除本地重复块，改 import `requireClient`
3. 保留原有报错文案与 exit code，避免 CLI 行为变化

#### 验收
- 全量测试通过
- `grep -rn "未配置 PTH 连接" packages/pth-console/src/commands` 只剩 `client.ts` 一处

### 2b. Professional runtime adapter 公共脚手架

#### 现状
6 个 adapter 重复：
- `running` Map + cancelled state
- `finish` / `fail` 结果组装
- `artifacts / diagnostics / outputBytes` 收集
- `put()` artifact 写入
- `sha256hex` / trace 组装

#### 方案
1. 新增 `src/pth/execution/adapters/job-runner.ts`
   - 导出 `createJobRunContext<TValue>(deps)`，封装：
     - `startedAt / traceId / artifacts / diagnostics / outputBytes / state`
     - `finish(status, error, value?, outputHashSource?)`
     - `fail(code, message)`
     - `put(kind, bytes, mediaType)`
   - 入参：`clock / artifactPort / request / runtime / runtimeVersion`
2. 逐个重构 6 个 adapter：
   - `assembly-runtime-adapter.ts`
   - `lean4-runtime-adapter.ts`
   - `wolfram-runtime-adapter.ts`
   - `computational-chemistry-adapter.ts`
   - `jupyter-runtime-adapter.ts`
   - `u8-runtime-adapter.ts`
   - 只保留各 adapter 特有的 spec 校验、命令构造、probe、诊断解析
3. 保持对外 `createXxxRuntimeAdapter` 签名与行为不变

#### 验收
- 相关 adapter 测试全绿
- `npm run lint` 通过
- 重复窗口数量显著下降（可在 audit 脚本中对比）

### 2c. `PTH_MEMORY_LIB_B64` 下沉到共享层

#### 现状
`pth-sandbox` 依赖 `pth-memory` 仅为了 `PTH_MEMORY_LIB_B64`，造成执行层反向依赖存储层。

#### 方案
1. 把 `PTH_MEMORY_LIB_PY` / `PTH_MEMORY_LIB_B64` 从 `packages/pth-memory/src/pth-memory-lib.ts` 移到 `packages/shared/src/python/pth-memory-lib.ts`（deps 仓）
   - 该文件当前无内部依赖，可安全移动
2. `packages/pth-memory/src/pth-memory-lib.ts` 改为 re-export：
   ```ts
   export { PTH_MEMORY_LIB_PY, PTH_MEMORY_LIB_B64 } from "@away_from/shared";
   ```
3. `packages/pth-sandbox/src/py-kernel.ts` 改为从 `@away_from/shared` 导入
4. 发布顺序：`@away_from/shared` → `@away_from/pth-memory` → `@away_from/pth-sandbox`

#### 验收
- `pth-sandbox/package.json` 移除 `@away_from/pth-memory` 依赖
- `pth-memory` 对外 API 不变
- 沙箱相关测试全绿

### 2d. 文档修复

#### 方案
1. 修复 `docs/pth/module-ownership.md` 中失效的 `docs/product-shape.md` 引用
   - 若该文档已不存在，改为引用当前三仓 README / `docs/fracta-engine-execution-topology.md`
2. 保持 `npm run check:docs-links` 通过

#### 验收
- `npm run check:docs-links` ✅
- 文档内不再有指向不存在文件的相对链接

---

## Phase 3：需要决策的收敛项（P2）

### 3a. `_shared` 与 `@away_from/shared` 去重

#### 背景
- `ptl/extensions/_shared/presence.ts` 与 `deps/packages/shared/src/presence.ts` 完全一致
- `version-check` 有三份相似实现
- 扩展运行环境目前不依赖 npm 包，直接复制是“能跑但双份维护”

#### 候选方案
1. **保持复制 + 增加同步守卫测试**（推荐，成本最低）
   - 在 ptl 或 deps 增加测试，断言 `_shared/presence.ts` 与 `shared/presence.ts` 内容一致
   - 对 `version-check` 增加字段级一致性测试
2. **发布 `@away_from/extension-shared` 小包**，让 pit-control 依赖
   - 需要确认 pi 扩展运行时是否支持 npm 依赖，需先验证
3. **把扩展改为只依赖 `@away_from/shared`**，删除 `_shared`
   - 若扩展宿主不安装 deps 包，则不可行

#### 决策点
需要确认：pi 扩展运行环境能否安装/解析 `@away_from/shared`？

### 3b. Operator console 双 UI 栈去留

#### 背景
- `web-src/`：Preact + Vite 新操作台（生产构建产物 `dist/operator-console/public`）
- `web/operator-console/`：legacy 静态 JS，仍被测试和 `server-assets` fallback 使用

#### 候选方案
1. **完成 Preact 迁移并删除 legacy**（推荐）
   - 把 legacy 的 view-model 测试迁移到新 UI 或 server API 测试
   - 删除 `web/operator-console/*` 与 `server-assets` 的 legacy fallback
2. **明确 legacy 为 test-only**，冻结修改
   - 在代码注释和文档标注，生产永不使用；后续再迁移

#### 决策点
需要确认：legacy 中是否还有新 Preact UI 未覆盖的能力？

### 3c. `src/pth/kernel` 进一步拆分 / barrel 纪律

#### 背景
- `kernel` 87 文件 / 16.2k LOC，是最大的认知负担
- `src/pth` 仍有 220 条跨模块深路径导入（25.8%）

#### 候选方案
1. **先加强 barrel 纪律**（推荐，低风险）
   - 扩展 `check-pth-boundaries.ts`，把 `application/gateway` 对 `kernel/storage/*`、`tasking/*` 私有文件的深路径也纳入违规检查
   - 逐步把 gateway 改为只依赖各模块 `index.ts`
2. **再评估拆分 kernel 子包**
   - 候选：`kernel-storage` / `kernel-execution` / `kernel-interpreter` 独立成 `packages/`
   - 工作量较大，需单独设计

#### 决策点
需要确认：是否本轮就启动 kernel 子包拆分，还是先只做 barrel 纪律？

---

## 依赖关系

```
Phase 0（环检测门禁）
   ↓
Phase 1（拆 execution↔runner 环）— 依赖 Phase 0 基线
   ↓
Phase 2a/2b/2c/2d（可并行，互不阻塞）
   ↓
Phase 3（需用户决策后启动）
```

## 全局验收

- `npm run lint` 全绿（含新增 `check:import-cycles`）
- `npm run build` 全绿
- `npx vitest run` 默认全量绿（2670 基线，0 failed，58 skipped）
- 三仓文档链接检查通过
- 审计文档 `modularity-reuse-audit.md` 随实施进度更新状态

## 非目标

- 不改变 PTL/PTH 产品边界
- 不重写 professional runtime 语义
- 不强制迁移 legacy UI（除非 Phase 3 决策）
- 不在本计划内拆分整个 `src/pth` 为多仓库
