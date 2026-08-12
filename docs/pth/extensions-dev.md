# PTH 扩展开发指南（2026-08-12 SDK 完善版）

toolstore 扩展体系——给 worker 生态补充能力（工具/能力/事件/角色）。本文是扩展作者指南。

## 目录结构

```
toolstore/extensions/<id>/
  plugin.json    # 清单（id/name/version/description/contracts/activation/compat）
  index.js       # 实现（工厂函数——JS 环境，推荐 .js；.ts 兼容但无类型检查收益）
```

## 快速开始（最小扩展）

```js
/// <reference path="../sdk.d.ts" />
// @ts-check
module.exports = /** @type {PthExtFactory} */ async function factory(ctx) {
  return {
    tools: {
      "hello.greet": async (args) => {
        const name = String(args?.name ?? "world");
        return { ok: true, result: `Hello, ${name}!` };
      },
    },
    capabilities: {},
  };
};
```

```json
{ "id": "hello-greet", "name": "Hello Greet", "version": "1.0.0",
  "description": "问候工具示例", "contracts": { "tools": ["hello.greet"] },
  "activation": { "onStartup": true }, "compat": { "pluginApi": ">=0.6.0" } }
```

## 铁律（eval 环境约束）

1. **入口运行于 JS 环境**（`new Function` eval 重放）——**禁止 TS 语法**：
   `as 断言 / interface / 类型标注（const x: number）` 会直接语法错误。
   类型检查通过 `// @ts-check` + JSDoc 注释实现（运行期被剥离）。
2. **不要裸 `import` node 模块**（`new Function` 无 require）——用 SDK 标准通道
   （`ctx.exec / ctx.http / ctx.db / ctx.memory / ctx.fs / ctx.llm / ctx.c`）。
   需要动态加载时用 `await import("node:xxx")`（合法）。
3. **工厂必须 async**（返回 Promise——`PthExtFactory` 类型只接受 Promise 返回）。
4. plugin.json 的 contracts.tools 必须与 index.js 实现的工具名**一一对应**
   （`npm run ext:check` 强制校验）。

## SDK 标准通道（ctx）

| 通道 | 签名 | 说明 |
|---|---|---|
| `ctx.exec` | `(command, args[], opts?) → {ok, stdout?, stderr?, error?, code?}` | 子进程执行（超时 15s/输出上限 4MB；可配 execAllowlist 白名单） |
| `ctx.http.get` | `(url, opts?) → {ok, status?, text?, bytes?, contentType?, error?}` | 只读获取（仅 https / http localhost；512KB 默认上限） |
| `ctx.db.query` | `(table, opts?) → {ok, rows?, error?}` | 只读 SQL（白名单 tasks/memory_entries/transcripts；键值对过滤防注入） |
| `ctx.memory` | `query(sql) / write(kind, content, opts?)` | 记忆库 |
| `ctx.fs` | `readText(name) / writeText?(name, content)` | toolstore 文件（路径受限） |
| `ctx.llm` | `complete(opts)` | LLM 补全 |
| `ctx.c` | `execute(code, opts?) / executeUnit?(name)` | C 执行核 |
| `ctx.log` | `(msg)` | batch 日志通道 |

工具返回值约定：`{ ok: true, result }` 成功 / `{ ok: false, error }` 失败——
错误消息 ≤200 字符（截断）。

## 类型与检查

- **类型面**：`toolstore/extensions/sdk.d.ts`（PthExtContext/PthExtFactoryResult/PthExtFactory）——
  扩展里 `/// <reference path="../sdk.d.ts" />` + `// @ts-check` 获得类型提示与检查。
- **验证工具**：`npm run ext:check`（或 `npx tsx scripts/ext-check.ts [扩展id...]`）——
  ① manifest 校验 ② tsc checkJs 类型检查 ③ 真实装载冒烟（tools 空参调用不炸）
  ④ manifest contracts 与实现对齐。
- **装载失败必现**：ExtRegistry 默认 onError 记 `console.error`（不静默）；
  语法错误带扩展 id + TS 语法误用提示。

## 装载机制

- 装载：`ExtRegistry.loadAll()`——扫描 `extensions/*/` → plugin.json 校验 → index.js eval →
  factory(ctx) → contracts 注册（tools/capabilities 代码库式；roles 注册谱系）。
- 多 batch：每 batch 进程独立装载（隔离）。
- 权限：ExtContext 受限（与任务代码同源白名单）——执行核命令不直接暴露。
- 入口探测：`index.js` 优先（checkJs 友好），`index.ts` 向后兼容（纯 JS 内容）。

## 常见错误

| 现象 | 原因 |
|---|---|
| `Unexpected identifier 'as'` | index.js 里写了 TS 断言——JS 环境不支持 |
| `error TS1065` | PthExtFactory 只接受 Promise 返回——工厂必须 async |
| 装载静默失败 | 旧版本无 onError——升级后默认 console.error |
| `plugin.json 声明工具 X 未实现` | contracts 与实现不对齐——ext:check 强制校验 |
