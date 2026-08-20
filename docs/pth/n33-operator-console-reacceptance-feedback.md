# N33 PTL 五页操作台再次验收反馈报告

> - 日期：2026-08-20
> - 复验对象：`main@48bd5541450bdd9f14ccdf5ba05d37d62109e103`
> - 设计：[n33-v13-ptl-operator-console-design.md](./n33-v13-ptl-operator-console-design.md)
> - 实施计划：[2026-08-19-v13-ptl-operator-console.md](../superpowers/plans/2026-08-19-v13-ptl-operator-console.md)
> - N30 依赖状态：[n30-runtime-observatory-report.md](./n30-runtime-observatory-report.md)
> - 取证方式：源码审查、真实 loopback HTTP 探针、生产 DTO 投影探针、幂等反例、focused/full/lint/build 与官方 acceptance driver
> - 工作树说明：复验测试产生了 `.chem-work-test-*`、`.lean-work-test-*` 未跟踪临时目录；本报告未清理或修改这些目录，也未修改实现代码

## 1. 结论

**独立复验结论：NOT ACCEPTED / NO-GO。**

当前实现已具备五页页面骨架、loopback server、短期 Session/CSRF、三 WorkMode preview/confirm、N30
只读代理、PTH inspection facade 及较完整的 focused 测试，但仍存在四个可直接复现的 P0 阻断：

1. Console server 不提供 `app.js` 的三个静态模块依赖，真实浏览器无法完成启动；
2. PTH 上游错误正文会经 PTL Console 原样回传浏览器，可能泄露 token、secret 或内部诊断内容；
3. Debug、Memory、Config 页面消费的 DTO 与真实 PTH inspection DTO 不一致，关键数据会丢失或加载失败；
4. `run/task.publish` 的模糊重试没有贯穿 PTH 创建边界的幂等键，可能产生重复真实任务。

此外，N33 的权威依赖 N30 GO envelope；当前仓库没有 N30 GO envelope，既有 N30 报告仍为 NO-GO。
因此，即使局部 happy path 和 focused 套件绿色，也不能将 N33 认定为可用或允许部署。

## 2. 新鲜门禁证据

| 门禁 | 结果 | 证据边界 |
|---|---|---|
| 官方 N33 acceptance driver | **NO-GO，exit 1** | 绑定当前 HEAD；运行时记录 dirty tree、focused/full 环境不可用、sandbox lint 非零、N30 envelope 缺失 |
| N33 evaluator 双跑 | **PASS，byte-identical** | 输出确定；但 evaluator 是源码标记检查，没有启动真实浏览器/模块图 |
| N33 focused | **21 files，168/168 passed，0 skip** | 沙箱外真实 PostgreSQL 环境；证明现有局部合同通过 |
| `npm run lint` | **exit 0** | 沙箱外重跑；TypeScript、PTH boundaries、PTH config 均通过 |
| `npm run build` | **exit 0** | 六个 Operator Console asset 均复制成功 |
| Full regression | **3019 tests：3009 passed / 1 failed / 9 skipped，exit 1** | 唯一失败是 Assembly Engineer x86-64 垂直切片 |
| 失败文件单独复跑 | **14/14 passed，exit 0** | 表明全量失败可能是并发/环境不稳定，但不能替代一次完整全绿证据 |

Full regression 的 9 个 skip 是既有 `sandbox-security` 冻结项。本轮没有获得一次完整、同提交、无额外失败的
full green；不能将单文件复跑成功外推为 full gate 已通过。

官方 driver 运行时工作树含测试残留，之后部分目录被测试自行清理、又产生新的专业工具临时目录。该差异不改变
下述 P0 动态反例，也意味着重新验收前必须在不删除用户文件的前提下明确这些目录的所有权与清理策略。

## 3. P0 验收阻断

### P0-1：真实浏览器无法加载 ES module 图

[app.js](../../packages/framework/web/operator-console/app.js) `:23-25` 静态导入：

```js
import { createDebugViewModel, DEBUG_POLL_MS } from "./debug.js";
import { createMemoryViewModel } from "./memory.js";
import { createConfigViewModel } from "./config.js";
```

但 [server.ts](../../packages/framework/src/operator-console/server.ts) `:91-96` 的 asset 白名单只有：

```text
index.html
styles.css
app.js
```

server 在 `:191-199` 也只预载该白名单。真实 loopback HTTP 探针结果：

```text
/          200
/app.js    200
/debug.js  401
/memory.js 401
/config.js 401
```

因此浏览器会在执行 `app.js` 前的 module fetch 阶段失败，Overview、Work、Debug、Memory、Config 五页均不能
完成初始化。Build 虽然复制了六个 asset，但 server 并没有提供其中三个模块。

[operator-console-browser.test.ts](../../test/pth-composition/operator-console-browser.test.ts) `:1-19`
明确是 pure-DOM approximation，直接读取源码文件，不经过 server/module fetch；现有 server 测试也只断言三个
白名单文件，所以当前 focused 绿色属于测试盲区。

**关闭条件：** server 必须从同一冻结 asset manifest 提供完整 module graph；真实 HTTP/browser 测试必须从 `/`
启动，捕获 module request，并断言五页完成 bootstrap，而不是直接把源码注入 DOM。

### P0-2：上游错误正文可泄露到浏览器

[client.ts](../../packages/framework/src/bridge/client.ts) `:396-407` 的 `throwError()` 会读取 PTH 响应正文并
拼入异常：

```ts
throw new Error(`${prefix}: HTTP ${res.status}${body ? " — " + body : ""}`);
```

[server.ts](../../packages/framework/src/operator-console/server.ts) `:398-405` 随后把 `err.message` 原样写入
浏览器 JSON。使用返回 secret sentinel 的 fake PTH 进行 loopback 探针，结果为：

```json
{
  "status": 502,
  "leaked": true,
  "body": "HTTP 500 — pth-secret-sentinel-XYZ"
}
```

这违反实施计划中“Browser receives neither PTH/N30 service tokens nor environment secrets”的冻结边界。

**关闭条件：** PTL server 只返回稳定 error code、request/correlation id 和脱敏摘要；上游正文仅进入受控服务端
日志并经过 secret scrubber。加入包含 token、URL credential、DB URL、专业软件凭据的逐项泄露测试。

### P0-3：生产 DTO 与三个页面的 ViewModel 不兼容

#### Debug

PTH Worker Inspection 在
[system-inspection-facade.ts](../../src/pth/application/observation/system-inspection-facade.ts) `:433-460`
返回：

- `role: { roleId, revision }`
- `currentTaskId`
- `regionIds` / `regionWeights`
- 结构化 `workingSet: { entryIds, skillIndexIds, activeSkillIds, counts, usage, omitted }`

[debug.js](../../packages/framework/web/operator-console/debug.js) `:49-74` 却读取平铺的 `roleId`、
`roleRevision`、`taskId`、`regions[]` 和数组形 `workingSet[]`。将真实生产 DTO 直接送入 ViewModel 后，
`roleId/taskId` 变为 null，regions 与 Working Set 均为空。

现有 Debug 集成测试使用平铺的 fake `{items:[...]}`，与生产 DTO 不同，因此没有发现组合错误。

#### Memory

- 生产分页返回 `nextCursor`，见
  [system-inspection-facade.ts](../../src/pth/application/observation/system-inspection-facade.ts) `:298-303`；
  [memory.js](../../packages/framework/web/operator-console/memory.js) `:63-66` 却读取 `page.cursor`，分页会提前终止；
- 生产条目字段是 `memoryType`，[app.js](../../packages/framework/web/operator-console/app.js) `:247`
  渲染 `type`，类型列为空；
- Revision route 在 [routes-observe.ts](../../src/pth/gateway/routes-observe.ts) `:367-381` 返回
  `{entryId,revisions}`，页面在 [app.js](../../packages/framework/web/operator-console/app.js) `:284-285`
  将整个对象传给只接受数组的 `ingestRevisions()`，revision 永远为空；
- detail endpoint 返回 `MemoryListItem`，不含页面在 `app.js:297-300` 需要的 `content/meta/evidence`，所以正文详情
  无法满足设计。

#### Config / Role

PTH `/observe/config` 与 `/observe/roles` 在
[routes-observe.ts](../../src/pth/gateway/routes-observe.ts) `:409-429` 返回直接数组；页面在
[app.js](../../packages/framework/web/operator-console/app.js) `:419-427` 预期 `{items}`。roles 的 fallback 还会
对同一个 `Response` 调用第二次 `json()`，导致 body-used 异常。真实 Role DTO 使用 `roleId`，ViewModel 使用 `id`，
即使绕过响应包装问题也会显示 `unknown`。

**关闭条件：** 定义单一 browser-facing DTO adapter，并让测试从真实 PTH route 响应经过 PTL server 再进入
真实 ViewModel；禁止测试单独发明 flat/wrapped fake shape。Memory detail 要么扩展安全有界 DTO，要么收窄 UI 承诺。

### P0-4：Task 发布的模糊重试会创建重复任务

[preview-store.ts](../../packages/framework/src/operator-console/preview-store.ts) `:478-503` 在幂等 ledger 为
`submitting` 时允许重新调用 native submit；`run` adapter 在
[run-actions.ts](../../packages/framework/src/operator-console/actions/run-actions.ts) `:119-128` 只把 preview id/digest
放进 payload。[PthClient.publishTask](../../packages/framework/src/bridge/client.ts) `:412-426` 没有传递 PTH 原生
idempotency key，PTH route 每次请求会创建新 task id。

模拟“第一次请求已经创建 task-1，但响应丢失”后，用同一 PTL idempotency key 重试，结果：

```json
{
  "calls": 2,
  "firstAcceptedTask": "task-1",
  "retryReturnedTask": "task-2"
}
```

现有测试让 fake adapter 第二次主动返回相同 ref，只证明 fake 自身幂等，未证明生产 PTH 创建边界幂等。

**关闭条件：** 为 Task publish 增加 tenant-scoped 原生 idempotency key 和唯一约束；首次提交与结果引用必须可在
响应丢失后查询/重放。加入“服务端 commit 后断连”的真实 route/repository 回归。

## 4. P1 高优先级缺口

### P1-1：Memory revision 查询没有条目可见性谓词

[system-inspection-facade.ts](../../src/pth/application/observation/system-inspection-facade.ts) `:619-644` 的 revision
SQL 只按 `tenant_id + entry_id` 查询，没有复用条目的 status/space visibility。若同租户其他空间的 private entry id
可被猜中，调用者可能看到 revision、status、createdBy、reason 等元数据。

**关闭条件：** revision 历史必须先通过与 detail 相同的 tenant/status/space 可见性门，或 join 当前 entry 并施加统一
谓词；加入 sibling space、ancestor/child、private/public、archived/draft 的矩阵测试。

### P1-2：Worker Debug 即使修 DTO 仍缺真实责任区/Working Set

[system-inspection-facade.ts](../../src/pth/application/observation/system-inspection-facade.ts) `:449-460` 对 replica
固定返回空 `regionIds/regionWeights/workingSet/toolNames/skillIds`。因此当前 inspection facade 尚不能实现用户要求的
“指定 Worker 观察其记忆区、Skill、Tool 和运行状态”。

**关闭条件：** 从 N28 的 authoritative Directory/Working Set/ledger snapshot 读取有界 projection，并绑定 workerId、
role revision、task/lease generation 和 collectedAt；不可从 prompt 或调试日志反推。

### P1-3：Config 页面覆盖面和身份派生不足

PTL config endpoint 只暴露少数硬编码 shell 字段，尚未覆盖设计要求的模板、模型、路径、来源、可重启性及全部
Role 配置。`ptl operator` CLI 也没有把 tenant/space 显式交给 Console server，server 回落 `default/ts` 时可能与
PTH token 的真实 scope 不一致。

**关闭条件：** 由服务端认证上下文派生 tenant/space，不接受浏览器自报；建立可枚举的脱敏 config descriptor，明确
source、effective value、restart requirement 和 secret mask。

### P1-4：Evaluator 只证明源码标记存在

[eval-n33-operator-console.ts](../../scripts/eval-n33-operator-console.ts) 主要检查文件内容/标记与 focused 数量，没有
启动 Console server、加载浏览器模块、访问真实 PTH DTO 或执行断连重试。因此在本轮四个 P0 全部存在时仍输出
PASS/byte-identical。

**关闭条件：** evaluator 的分母必须来自真实公共探针：完整 module graph、五页导航、PTH/N30 独立降级、DTO
端到端投影、secret sabotage、native idempotency、freshness/reconcile。任何探针未执行必须 INCOMPLETE，不能默认 0。

## 5. C0–C4 独立复核矩阵

| Gate | 自动/局部证据 | 独立复核 | 说明 |
|---|---|---|---|
| **C0 安全外壳** | focused PASS | **FAIL** | Session/CSRF/Host/Origin 基础存在；完整 module graph 401，错误正文泄露。 |
| **C1 Overview** | N30 proxy 局部 PASS | **PARTIAL / BLOCKED** | 同源只读代理存在；缺 N30 GO envelope，既有 N30 报告为 NO-GO。 |
| **C2 Debug/Memory/Config** | route/VM 单测 PASS | **FAIL** | 生产 DTO 与页面模型不兼容；Worker Working Set 为空；revision 可见性不足。 |
| **C3 Run/Intake/Optimize** | happy path PASS | **PARTIAL / FAIL** | preview/confirm 与 native adapters 存在；Task 模糊重试可重复创建。 |
| **C4 权威验收** | evaluator PASS | **FAIL** | 官方 driver NO-GO；full 未形成一次全绿；N30 authority 缺失；browser gate 不真实。 |

## 6. 已确认可保留的正向成果

以下实现具有局部价值，不需要推倒重来：

- server 绑定 loopback，具备 Bootstrap token→短期 Session、Host/Origin 与 CSRF 基础保护；
- 浏览器不直接持有 PTH/N30 token，N30 仍保持 GET/SSE-only 同源代理方向；
- Work preview/confirm、风险提示和 allowlisted run/intake/optimize adapters 已形成明确边界；
- PTH inspection SQL 的 Memory list/detail/summary 已使用 tenant/status/space 谓词；
- N33 focused 168 项、lint 和 build 全部通过；
- N30 故障与 PTH 写通道的独立降级设计仍然合理；
- vanilla HTML/CSS/ES module 与无新增前端运行时依赖的技术选择保持成立。

这些成果说明方案可以通过局部修缮继续推进，但不能抵消浏览器不可启动、secret 泄露和 native 幂等缺失。

## 7. 建议修复顺序

### 第一层：恢复可启动与安全边界

1. 以同一 asset manifest 构建、复制并服务完整 ES module graph；
2. 所有 PTH/N30 错误经结构化脱敏映射，不向浏览器回传 upstream body；
3. 用真实浏览器从 `/` 加载，完成五页导航、断网降级、XSS 与 secret sabotage。

### 第二层：统一 DTO 与只读可见性

1. 建立唯一 Browser DTO adapter，删除测试自造 DTO；
2. 修正 Worker role/task/region/Working Set、Memory cursor/type/revisions/detail、Config/Role arrays；
3. 为 Memory revision 加统一 tenant/status/space visibility；
4. 补齐 authoritative Worker Responsibility/Working Set projection。

### 第三层：关闭写路径重复与身份漂移

1. Task publish 落 tenant-scoped native idempotency key；
2. 覆盖“commit 成功、响应丢失、客户端重试”的真实测试；
3. tenant/space 只从服务端认证上下文派生；
4. 对 run/intake/optimize 各自验证 preview digest、native ref 和状态投影一致。

### 第四层：重建权威验收证据

1. 先关闭 N30 NO-GO 并生成绑定当前实现的 N30 GO envelope；
2. evaluator 改为消费真实 browser/HTTP/DTO/idempotency 探针，而不是源码标记；
3. 在 clean implementation commit 依次执行 evaluator 双跑、N33 focused、真实浏览器、full、lint、build；
4. full 必须形成一次完整绿色结果，只有冻结 skip manifest；
5. acceptance driver 绑定同一 commit、同一合同与全部 gate，之后才允许写 N33 GO 报告。

## 8. 重新验收条件

重新验收必须同时满足：

1. `/` 加载后所有 module request 为 200，五页在真实浏览器中可导航；
2. PTH/N30 token、响应正文 secret、DB URL、专业软件凭据的泄露计数为 0；
3. Debug/Memory/Config 端到端使用真实 PTH DTO，不存在 test-only shape；
4. Memory revision 遵守 tenant/status/space visibility；
5. Worker 页面能展示 authoritative responsibility 与 Working Set 有界投影；
6. Task commit-after-disconnect 重试只产生一个 native task；
7. N30 authority envelope 为 GO；
8. evaluator 双跑字节一致且全部真实探针实际执行；
9. N33 focused、真实浏览器、full regression、lint、build 全绿，只有冻结 skip；
10. implementation tree clean，报告/envelope 绑定准确 evaluated commit。

在这些条件满足之前，独立复核状态保持 **NOT ACCEPTED / NO-GO**，不得将当前 evaluator PASS 或 focused
168/168 外推为 Operator Console 可用。修复完成后必须生成新的权威 acceptance envelope；本报告不覆盖或改写
任何历史产物。
