# N28 项目结构基线

> 由 `scripts/n28-structure-snapshot.ts --update` 生成；JSON 事实源：
> `docs/pth/n28-structure-baseline.json`。
> 每次 lane 合并回 main 后，合并者先 `--check` 对照 lane 契约 §3 文件域复核漂移，
> 再以单独 docs commit `--update` 刷新本基线。

## 摘要

| 项 | 值 |
|---|---|
| src/pth 文件 | 224 |
| test 文件 | 252 |
| scripts 文件 | 20 |
| packages 文件（.ts + package.json） | 183 |
| 合计 | 679（105886 行） |
| src/pth 导入边 | 900（runtime 413 / type 487 / 包 specifier 202） |
| 根一级目录 | archive、config、deploy、docs、examples、extensions、packages、scripts、src、test、tools、toolstore |

## src/pth 分层

| 层 | 文件数 |
|---|---|
| application/ | 1 |
| bootstrap/ | 10 |
| catalog/ | 21 |
| components/ | 4 |
| config/ | 3 |
| contracts/ | 9 |
| core/ | 9 |
| execution/ | 14 |
| fallback/ | 1 |
| gateway/ | 14 |
| impls/ | 7 |
| kernel/ | 85 |
| main.ts | 1 |
| observability/ | 4 |
| programs/ | 2 |
| runner/ | 15 |
| self-modify/ | 1 |
| tasking/ | 17 |
| tools/ | 3 |
| workflow/ | 3 |

## 包清单

| 位置 | name | version |
|---|---|---|
| package.json | @away_from/pi-triple | 1.1.3 |
| packages/dev-container/package.json | @away_from/dev-container | 1.1.3 |
| packages/framework/package.json | @away_from/framework | 1.1.3 |
| packages/infra/package.json | @away_from/infra | 1.1.3 |
| packages/mailbox/package.json | @away_from/mailbox | 1.1.3 |
| packages/pth-memory/package.json | @away_from/pth-memory | 1.1.3 |
| packages/pth-sandbox/package.json | @away_from/pth-sandbox | 1.1.3 |
| packages/shared/package.json | @away_from/shared | 1.1.3 |
