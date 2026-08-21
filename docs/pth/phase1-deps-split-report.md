# Phase 1 拆仓报告：pi-triple-deps

> 日期：2026-08-21 · 状态：✅ 本地拆仓 + 打包完成（未 npm publish / 未创建 GitHub 远端）
> 设计依据：[repo-split-v15-design.md](./repo-split-v15-design.md)

## 1. 产物

- 本地仓库：`/Users/anzhize/pi-triple-deps`（git filter-repo 2.47.0 按路径历史拆分）
- 拆分历史：主仓 1,468 个 commit 按 `packages/shared` / `packages/infra` 过滤保留
- deps 仓当前 HEAD：`5a4ddd3`（root scaffold + 版本 bump）

## 2. 仓库形态

```
pi-triple-deps
├── packages/shared     @away_from/shared@1.5.0
├── packages/infra      @away_from/infra@1.5.0
├── test/unit           8 个纯 deps 单测
├── vitest.config.ts    alias 直连 src（无需先 build）
└── tsconfig.base.json  与主仓同源
```

## 3. 验证

- `npm install` ✅
- `npm run lint` ✅（两包 tsc --noEmit）
- `npm run build` ✅
- `npm test` ✅：11 files / 72 tests / 0 fail
- `npm run pack:tgz` ✅

### tgz sha256

| 文件 | sha256 |
|------|--------|
| `dist-tgz/away_from-shared-1.5.0.tgz` | `aad8d7622d6331a78ff8f0a6e57f3ca63c15e243ea7f7833dad98198ff448017` |
| `dist-tgz/away_from-infra-1.5.0.tgz` | `0e3e1a94d32f6c5af7b9bc301c1d967318d8b228487977435b47a98078dba1e8` |

## 4. 发布命令（待用户执行）

```bash
cd /Users/anzhize/pi-triple-deps

# GitHub（需先在 github.com 创建 pi-triple-deps 空仓库）
git remote add origin git@github.com:Phenol1145/pi-triple-deps.git
git push -u origin main

# npm（需 npm login；registry 目前未登录）
npm publish packages/shared --access public
npm publish packages/infra --access public
```

## 5. 拆分时修正

- `test/unit/multi-mode.test.ts` 实际依赖 `packages/framework/src/commands.js`（PTL 侧），
  已从 deps 拆分清单移除（`scripts/build-repo-split-manifest.ts` 同步修正），留在 PTL 仓测试集。
