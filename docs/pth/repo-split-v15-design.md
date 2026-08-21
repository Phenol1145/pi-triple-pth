# PTL/PTH 仓库拆分设计（v1.5）

> 状态：设计已批准；**Phase 0（ptl hub → pth 命令迁移）已完成**；Phase 1–4（filter-repo 拆仓）待执行。
> 机器清单：[repo-split-v15-manifest.json](../repo-split-v15-manifest.json)。
> 历史依据：[2026-08-08 仓库拆分 SPEC](../superpowers/specs/2026-08-08-repo-split-design.md)（本设计是其 1.5 修订版）。

## 1. 目标

把 `pi-platform` 单仓拆成：

| 仓库 | 内容 | 发布物 |
|------|------|--------|
| `pi-triple-deps` | `packages/shared` + `packages/infra` | `@away_from/shared` · `@away_from/infra` |
| `pi-triple-pth` | `src/pth` · `pth-memory` · `pth-sandbox` · `pth-console` · PTH 部署/文档/脚本 | `pth` CLI（含 web/launcher） |
| `pi-triple-ptl` | `framework` · `mailbox` · `dev-container` · PTL 扩展/文档/脚本 | `ptl` CLI |
| `pi-platform` | 旧仓 | GitHub archived |

## 2. 已裁决的关键点

1. **交互面收敛到一个包**：PTH 侧唯一交互包 = `@away_from/pth-console`；
   原 `ptl hub` 的 PTH 功能全部迁成 `pth <cmd>`，`ptl hub` 语法退役（只留迁移提示）。
2. **PTL 不再依赖 PTH 包**：PTL 调 PTH 一律经 `pth` CLI / HTTP API v1；
   `framework` 删除对 `@away_from/pth-console` 的依赖。
3. **git 历史**：`git filter-repo` 按 `repo-split-v15-manifest.json` 的 `filterRepoPaths` 拆仓，旧仓 archive 兜底。
4. **双栖模块**：`src/pth`、`pth-console`、`docker-monitor` 随 PTH 仓（保持单实现）；
   PTL 仓只保留宿主机工具。

## 3. 命令迁移映射（完整见 manifest）

| 原命令 | 新命令 |
|--------|--------|
| `ptl hub submit/run/programs` | `pth program submit / pth program run / pth program list` |
| `ptl hub request(s)/respond/observe/debug/bench/job/console/lineage/trigger` | `pth request(s)/respond/observe/debug/bench/job/console/lineage/trigger` |
| `ptl hub kernel …` | `pth kernel …` |
| `ptl hub dev <dir>` | `ptl program dev <dir>`（PTL 本地 pi 调试，不进 PTH） |
| `ptl hub deploy/status/logs/upgrade/exec` | `ptl stack deploy/status/logs/upgrade/exec`（PTL 容器运维） |

实现文件迁移：
- `packages/framework/src/bridge/{submit,run,programs,request,respond,observe,debug,bench,jobs,console,lineage,trigger,kernel}.ts`
  → `packages/pth-console/src/commands/`，成为 `pth` 子命令实现；
- `bridge/{dev,pipe}.ts` → `packages/framework/src/program-dev/`；
- `bridge/containers.ts` → `packages/framework/src/stack/`；
- `packages/pth-console/src/bridge/{client,client-types,manifest,pack,ustar}.ts` 保留为 PTH 交互包内部协议层。

## 4. 各仓目标形态

### 4.1 pi-triple-deps

- npm workspace：`packages/shared`、`packages/infra`
- 发布两个包，`main/types/exports` 沿用现有 package.json
- 独立门禁：`tsc -p packages/shared && tsc -p packages/infra && vitest packages/infra/test`
- 两个主仓的依赖改为 `"@away_from/shared": "^1.5.0"` / `"@away_from/infra": "^1.5.0"`（npm，不再 `file:`）

### 4.2 pi-triple-pth

- npm workspace：`pth-memory` → `pth-sandbox` → `pth-console`
- 根源码 `src/pth`；测试 `test/pth-*/`、`packages/*/test`
- `pth` bin 指向 `packages/pth-console/dist/cli.js`（交互/launcher/web 同包）
- 部署：`deploy/Dockerfile`、`docker-compose*.yaml`、`docker-monitor`、locks、`.env.pth.secrets.example`
- 构建序：deps 包已发布 → `pth-memory` → `pth-sandbox` → `pth-console` → 根 `tsc`
- Dockerfile.dev 从旧仓复制并裁剪为 PTH 专用 dev 镜像

### 4.3 pi-triple-ptl

- npm workspace：`framework` · `mailbox` · `dev-container`
- 扩展：`extensions/_shared`、`pit-control`、`pit-providers`；配置 `config/settings.json`、`SYSTEM.md`
- `ptl` bin 指向 `packages/framework/dist/pit.js`
- `ptl stack`（容器运维）与 `ptl program dev`（本地 pi 调试）落位后，`hub` 命名空间删除
- dev 容器镜像与脚本保留在本仓

## 5. 拆分路径与 copyBoth

- `repo-split-v15-manifest.json` 给出每个仓的 `filterRepoPaths`（可直接喂 `git filter-repo --path …`）。
- `copyBoth`：`tsconfig.base.json`、`scripts/build-docs-manifest.ts`、`scripts/check-doc-links.ts`、
  `scripts/lane-worktrees.sh` 等三仓共用工具，拆后复制而非移动。
- 三仓都要重建自己的根 `package.json / tsconfig.json / vitest.config.ts / README.md / CI`；
  旧仓保留完整历史后 archive。

## 6. 执行顺序（每 Phase 一 lane，全门禁后再进下一 Phase）

1. **Phase 0（本仓准备）✅ 已完成**：`ptl hub` → `pth`（program 程序面 + request/observe/… 同名命令）；`ptl stack`/`ptl program dev` 落位；framework 去掉 pth-console 依赖；测试随命令迁移；全量回归。
2. **Phase 1**：filter-repo 拆 `pi-triple-deps` → 发布 `shared/infra@1.5.x`。
3. **Phase 2**：filter-repo 拆 `pi-triple-pth` → 依赖切 npm 版本 → 构建/启动/任务回归。
4. **Phase 3**：filter-repo 拆 `pi-triple-ptl` → 依赖切 npm 版本 → ptl 安装/PTL 回归。
5. **Phase 4**：旧仓 archive；三仓 README/CI/文档索引独立化。

## 7. 验收标准

- 本仓 Phase 0 后：`grep -R "@away_from/pth-console" packages/framework` 为空；
  `ptl hub` 仅迁移提示；`pth` CLI 覆盖原 hub 的全部 PTH 命令；
  lint/build/docs-links/full 全绿。
- 拆仓后：三仓各自 `npm ci && npm run build && npm test` 全绿；
  PTL 安装不触发 PTH 源码下载；`pth up` 仍能从 PTH 仓拉起全栈。
- 旧仓 GitHub archive 后，历史/发布记录仍可读。
