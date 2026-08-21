# pi-triple-pth

Pi-Triple **PTH（Professional Task Host）** 仓库：任务派发 / kernel 执行 / sandbox / 操作控制台。

| 模块 | 位置 | 说明 |
|------|------|------|
| 运行时 | `src/pth` | PTH 主服务（HTTP API v1 + batch worker + kernel 装配） |
| 记忆包 | `packages/pth-memory` | `@away_from/pth-memory` |
| 沙箱包 | `packages/pth-sandbox` | `@away_from/pth-sandbox`（隔离 exec/kernel 宿主） |
| 交互包 | `packages/pth-console` | `@away_from/pth-console`（launcher / commands / web console） |
| 部署 | `deploy/` | Dockerfile · docker-compose · docker-monitor · runtime locks |

依赖 `@away_from/shared` 与 `@away_from/infra`（npm 包，见 [pi-triple-deps](https://github.com/Phenol1145/pi-triple-deps)）。

## 快速开始

```bash
npm install        # 需先发布 @away_from/shared@1.5.0 / @away_from/infra@1.5.0
npm run build      # pth-memory → pth-sandbox → pth-console → web → 根 tsc
npm test           # vitest（testcontainers 相关用例需要 Docker）
npm run pth -- init && npm run pth -- up   # 拉起全栈（redis/postgres/pi-platform/sandbox）
```

`pth` 可执行入口：根编译产物 `dist/cli/pth-cli.js`（`npm run build` 后可用；源码 `src/cli/pth-cli.ts`）。

## 门禁

```bash
npm run lint       # tsc + web typecheck + pth-boundaries + pth-config + docs-links
npm run build
npm test
```

## 目录边界

- PTL 产品代码不在此仓；PTL→PTH 全部经 `pth` CLI / HTTP API v1。
- `extensions/pth-tasks` 为 PTH 扩展；`toolstore` 为扩展代码库卷种子。
