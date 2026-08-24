# PTH 模块拆分设计（2026-08-15 用户裁决）

> 目标：项目长尾收敛——把「记忆域」与「沙箱域」拆为单仓内独立维护的 workspace 包；
> 长尾待办按 D 方案：先归位到各包 TODO，拆完后逐包评估。
> 形态：单仓 workspace 包（用户裁决 A）。内核契约包含在沙箱包内（用户裁决）。

## 1. 包边界

### packages/pth-memory（`@away_from/pth-memory`）——记忆域
- `memory-store-pg.ts`：PG 记忆存储（query/write/update/retrieve/get/系统文档保护）
- `memory-policy.ts`：用途层权限（prompt/config/governance/knowledge）
- `memory-visibility.ts`：空间可见性（scope/isVisible/盖章）——**space 查询以 setSpaceLookup 注入**，不 import PTH core
- `memory-index.ts`：图导航索引
- `memory-admin.ts`：归档/清理治理执行端
- `skill-format.ts`：skill 四段式格式 + 种子
- `pth-memory-lib.ts`：Python 记忆库源码（供 PyKernel 注入）
- `read-only-query.ts`：受限只读 SQL 执行器（表白名单/噪声掩码/LIMIT 封顶）
- TODO/OWNER：记忆域长尾全部归位

**不迁入**：`extensions/memory.ts` 留在 PTH core 作扩展适配层（import 记忆包 + 注入 core 的 spaceRegistry）。

### packages/pth-sandbox（`@away_from/pth-sandbox`）——沙箱域（含内核契约/运行时）
- `kernel/interpreter/types.ts`：Interpreter 契约与调试协议类型（**契约单一真相源**）
- `py-kernel.ts` / `bash-kernel.ts` / `bash-interpreter.ts`：持久内核运行时
- `compiled-kernel.ts` / `gdb-mi.ts`：编译核 / gdb 调试运行时
- `sandbox-kernel.ts` / `sandbox-compiled-kernel.ts` / `sandbox-debug-session.ts`：PTH 侧沙箱客户端
- `sandbox-bash.ts`：sandbox exec/health 协议与 bash 定义
- `kernel-pool.ts` / `kernel-host.ts` / `exec-api.ts` / `main.ts`：沙箱宿主服务
- Dockerfile.sandbox 与沙箱部署资产（随包）
- TODO/OWNER：沙箱长尾归位

依赖方向：
```
pth-memory（零 core 依赖，space 查询注入）
   ↑
pth-sandbox（import pth-memory 的 Python 记忆库）
   ↑
PTH core（import 两包；装配时 setSpaceLookup(spaceRegistry.get)）
```
无环。

## 2. 核心改造
- `src/pth/kernel/storage/index.ts`：PgMemoryStore / buildReadOnlyQuery 改为 re-export pth-memory（DataWorld 组装不变）
- `src/pth/impls/kernels/*`：PyKernel/BashKernel/编译核/gdb/sandbox 客户端改 import pth-sandbox
- `src/pth/tools/sandbox-bash.ts` 删除，消费方 import pth-sandbox
- `src/sandbox/` 删除，宿主动 pth-sandbox
- `assembly.ts` 启动时 `setSpaceLookup(spaceRegistry.get.bind(spaceRegistry))`
- 根 package.json：workspace 依赖 `@away_from/pth-memory` / `@away_from/pth-sandbox`；build 顺序 memory → sandbox → shared/infra/framework/root
- vitest alias 两包指向 src/index.ts；测试 include 加 `packages/*/test/**/*.test.ts`

## 3. 长尾归位（D 方案）
- 主 TODO 只留核心闭环；记忆相关（H3/H5/H6/H7 后续观测、skill Phase 2-4、N1b/N2/N4 记忆侧）→ packages/pth-memory/TODO.md
- 沙箱相关（内核池/编译核/gdb/perf、H8 Python 桥盖章、H9 网络边界、N5 资源环）→ packages/pth-sandbox/TODO.md
- 拆分完成后逐包评估低价值项（N11/E2/B7 等在对应包内裁决）

## 4. 验收
- 全量 vitest 195+ 文件全绿；根 `tsc --noEmit` + 两包 tsc 干净
- `npm run build` 产物含 packages/pth-memory/dist 与 packages/pth-sandbox/dist，`dist/pth/main.js` 可启动
- `madge` 确认两包不依赖 `src/pth`（pth-memory 零 core import；pth-sandbox 零 core import）
