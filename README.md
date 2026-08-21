# pi-triple-pth

**Pi-Triple PTH（Professional Task Host）** —— 自然语言任务解释执行的宿主：HTTP API v1、kernel 装配、隔离 sandbox、操作控制台。

![node](https://img.shields.io/badge/node-%3E%3D22-green)
![tests](https://img.shields.io/badge/tests-2572-brightgreen)
![version](https://img.shields.io/badge/version-1.5.0-blue)

- **定位**：任务派发 → batch worker → kernel/sandbox 执行 → 产物沉淀记忆。
- **导航**：Quick Start · [模块](#模块) · [架构](#architecture) · [开发](#development) · [仓库定位](docs/POSITIONING.md) · [文档](#documentation)

## ✨ Quick Start

```bash
# 需先发布 @away_from/shared@1.5.0 / @away_from/infra@1.5.0（pi-triple-deps）
git clone https://github.com/Phenol1145/pi-triple-pth.git
cd pi-triple-pth
npm install
npm run build      # pth-memory → pth-sandbox → pth-console → web → 根 tsc
npm run pth -- init && npm run pth -- up   # redis/postgres/pi-platform/sandbox 全栈
```

`pth` 可执行入口：根编译产物 `dist/cli/pth-cli.js`（源码 `src/cli/pth-cli.ts`）。
任务派发：

```bash
pth submit "统计 memory 库 scorecard 数" --role memory-stats
pth status <taskId> && pth wait <taskId>
```

## 模块

| 模块 | 位置 | 说明 |
|------|------|------|
| 运行时 | `src/pth` | 主服务（HTTP API v1 + batch worker + kernel 装配） |
| 记忆包 | `packages/pth-memory` | `@away_from/pth-memory` |
| 沙箱包 | `packages/pth-sandbox` | `@away_from/pth-sandbox`（隔离 exec/kernel 宿主） |
| 交互包 | `packages/pth-console` | `@away_from/pth-console`（launcher / commands / web console） |
| 部署 | `deploy/` | Dockerfile · docker-compose · docker-monitor · runtime locks |

## Architecture

```
                        ┌─────────────────────────────┐
                        │         src/pth             │
                        │  Fastify 网关 · batch · kernel│
                        └──────┬──────────────┬───────┘
                 HTTP/SSE/WS     │              │ sandbox-internal
                 pth CLI / web   │              ▼
                 ┌───────────────▼───┐   ┌─────────────────┐
                 │ @away_from/shared │   │ pth-sandbox     │
                 │ @away_from/infra  │   │ exec · REPL 池  │
                 └───────────────────┘   └─────────────────┘
                     Redis · Postgres       workspaces 共享卷
```

PTL 不依赖本仓包；PTL→PTH 全部经 `pth` CLI / HTTP API v1。

## Development

```bash
npm run lint   # 4×tsc + web typecheck + pth-boundaries + pth-config + product-boundaries + docs-links
npm run build
npm test       # vitest（testcontainers 用例需 Docker；professional 垂直用例需本地工具链容器）
npm run test:e2e   # Playwright operator console
```

## Roadmap

- ✅ v1.5.0：从主仓 filter-repo 拆出；PTH-only Dockerfile/compose；`pth up` 全栈回归
- 🚧 命名演进：PTH → **FRACTA 引擎**（规划中；代码/包名/命令品牌迁移将单独立项）
- 🚧 R4–R8 container-runtime 契约实现与验收

## Documentation

- [docs/pth](./docs/pth) · [deployment](./docs/pth/deployment.md) · [configuration](./docs/pth/configuration.md) · [module-ownership](./docs/pth/module-ownership.md)
- [Phase 2 拆仓报告（主仓归档）](https://github.com/Phenol1145/pi-triple/blob/main/docs/pth/phase2-pth-split-report.md)
