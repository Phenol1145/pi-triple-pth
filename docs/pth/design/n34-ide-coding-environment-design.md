# N34：IDE 级任意语言编码/调试环境设计（LSP + DAP）

> 状态：**设计稿（待评审）**
> 分支：`feat/pth-exec-unified`
> 关联：`docs/adr/0004-tce-code-layer-ptc-capability-first.md`（TCE 三层——本设计是其能力族扩展）、
> `docs/adr/0005-role-four-tuple.md`（能力=工具+工具内部权限——lsp.*/debug.* 按角色卡方法级授权）、
> `pth-bench-unified-design.md`（性能评估装置——本设计的效能验证走 bench/scorecard）。
> 触发：dev.*/debug.* 目前只服务 C/asm；目标是为任意语言提供类 IDE 的编码调试环境。

---

## 0. 核心命题

**IDE 对 worker 的价值不是"编辑"（dev.write/edit 已够），而是"看见代码结构"。**

把 IDE 能力拆成三件事，对应两个行业标准协议：

| 能力 | 协议 | 与现状的差距 |
|---|---|---|
| 语言智能（补全/跳转/诊断/引用） | **LSP**（Language Server Protocol） | 全新面——但会话/资源模型可复用 debug 的 |
| 调试（断点/单步/求值/栈帧） | **DAP**（Debug Adapter Protocol） | 小——`DebugSession` 契约已按 DAP 语义对齐（types.ts 注释明载），gdb-MI 只是首个后端 |
| 执行（编译/运行） | 现有 kernel 池 | 已有任意语言先例（asm-kernel 惰性注册、exec backend 容器） |

**判断：本设计不是新架构，是把 debug.\* 已有的"协议适配 + 会话句柄 + 角色授权"模式复制到 LSP，并把 DAP 后端从 gdb-MI 泛化。**

## 1. 三侧映射（TCE 分层落位）

### 1.1 execute 侧（sandbox / language pod）

| 组件 | 现状 | 扩展 |
|---|---|---|
| 调试服务端 | `kernel-host-debug.ts`：会话 Map / 上限 4 / idle 30min 清扫 / Bearer 鉴权 | `CDebugSession`（gdb-MI）泛化为 `DapSession`——每语言一个 debug adapter 子进程（debugpy/delve/lldb-dap/vscode-js-debug），stdio JSON-RPC 桥接；会话管理/上限/清扫零改动 |
| 语言智能服务端 | 无 | 新增 `kernel-host-lsp.ts`：language server 子进程（stdio JSON-RPC）会话化包装，句柄 = `(language, workspaceRoot)`；生命周期复用 debug 会话模型（独立池、独立上限、TTL） |
| 工具链驻留 | sandbox 镜像装 gdb/cc | 语言服务器体积大（rust-analyzer 数十 MB、tsserver 上百 MB）——走 **language pod**：独立容器后端，`executor-matrix.json` 注册 `languages: [...]` + `binding.backendId`（tools-compiled/jupyter 同模式）；sandbox 镜像只带轻量首发（tsserver/Pyright 可选） |
| 执行核 | `WorkerKernel.execute(language, ...)` 路由 + toolstore 扩展注册 | 不变；LSP/DAP 是"代码智能面"，不与执行核混池 |

### 1.2 code 侧（C=Code，上下文渲染——本设计重心）

LSP 原始返回体积巨大（一次 references 可达数百行 JSON），直接喂 LLM 会烧毁上下文预算。code 侧职责是**把代码结构渲染成 LLM 可消化的紧凑上下文**：

- **渲染层**（新，`ptc/capabilities/lsp-render.ts`）：diagnostics → "3 个错误：main.c:12 未声明 x…"；documentSymbol → 缩进树 outline；references → 按文件分组的行号清单。全部走 `applyOutputMode` 既有纪律（default/value-only/errors-only/quiet）
- **观测面挂载**：diagnostics 摘要可注入 observation-strategy / agent-loop prompt，成为 agent 的标准观测（"当前文件有 N 个未决诊断"）
- **编辑回路**：LSP `didOpen/didChange/didClose` 与 dev.write/edit 联动——写文件后自动同步语言服务器，下一轮即可查诊断（edit→diagnose→fix 闭环，这是 IDE 体验的核心增量）

### 1.3 tool 侧（契约与授权——机制零新增）

- `ptc/contract.ts` 新增条目族 `lsp.*`（toolSchema + `asAction` 投影），`debug.attach` 增加 `language` 参数
- 角色卡 `capabilities.functions` 方法级声明（`lsp` 族级或 `lsp.hover` 方法级），`buildTaskCapabilityInject` 既有方法级过滤自动生效——只读角色（acceptor）天然拿不到写面
- 授权/审计走 TCE 既有链（capability 注入 + 静态审核）

## 2. 协议子集选型（刻意收窄）

### 2.1 LSP 子集（8 方法 + 3 通知）

| 方法 | 用途 | 渲染形态 |
|---|---|---|
| `initialize` / `shutdown` | 会话生命周期 | — |
| `textDocument/didOpen` `didChange` `didClose` | 文档同步（与 dev.write/edit 联动） | — |
| `textDocument/diagnostic`（或 publishDiagnostics 推送） | 诊断 | 计数 + 前 N 条紧凑清单 |
| `textDocument/documentSymbol` | 符号 outline | 缩进树（深度/条数上限） |
| `textDocument/definition` | 跳转定义 | 文件:行号 清单 |
| `textDocument/references` | 找引用 | 按文件分组清单 |
| `textDocument/hover` | 类型/文档 | 截断 500 字符 |
| `textDocument/completion` | 补全 | top-K（默认 10） |
| `textDocument/rename` | 重命名（可选，W2 后） | WorkspaceEdit 摘要 |

不做：格式化、codeAction、semanticTokens、folding（价值/带宽比低）。

### 2.2 DAP 子集 = 现有 DebugSession 契约

`attach/breakpoint/continue/step/snapshot/evaluate/detach/sessions` 八方法不动；`attach` 增加 `language`（缺省 `c` 走 gdb-MI 兼容路径）。类型层（DebugStopped/DebugStackFrame/DebugVariable）已按 DAP 语义建模，无需迁移。

## 3. 会话与资源模型

```
lsp 会话池（独立）          dap 会话池（现有 debug 池泛化）
  key=(language,tenant,       key=sessionId
       workspaceRoot)          上限 PTH_DEBUG_SESSIONS（4）
  上限 PTH_LSP_SESSIONS（8）   idle 30min detach
  idle 15min shutdown          └─ gdb-MI / debugpy / delve …
```

- **独立池、独立上限**——2026-08-25 冒烟已暴露 kernel REPL 池 24/24 打满；代码智能会话绝不混池
- **内存护栏**：language server 单进程 RSS 上限（cgroup/rlimit，pod 侧由容器限制兜底）；超限 kill + 会话作废 + 事件入 obs
- **工作区一致性**：LSP root = 任务工作区（workspaces bind mount 已打通三方）；跨任务会话不共享（隔离优先，命中率牺牲可接受）

## 4. 安全模型

- language server / debug adapter 均为**不可信代码**（读全工作区、可加载插件）——必须运行在 sandbox-untrusted profile 或独立 pod，复用 execution grant 授权链（Side B 签名）
- LSP workspace edit / rename 写文件前过 `resolveArtifact` 同款白名单（拒绝对路径/穿越）
- pod 网络面：仅南向 execution/v1.1 + 共享密钥，无其他出站

## 5. 分期计划

| 阶段 | 内容 | 验收 |
|---|---|---|
| **Phase 0：DAP 泛化** | `DapSession` 抽象 + debugpy 首发（python 调试）；gdb-MI 保留为 C 后端 | python 任务 attach→breakpoint→evaluate→detach 全链路；C 回归零变化 |
| **Phase 1：LSP 最小子集** | `kernel-host-lsp.ts` + lsp.* 能力族（§2.1 子集）+ 渲染层；首发 ts（tsserver，node 环境现成）+ python（Pyright） | ts 文件 dev.write→diagnostics 闭环；outline/definition/references 可用；输出模式生效 |
| **Phase 2：language pod** | 重工具链（rust/go/java）独立容器 + executor-matrix 注册 + 路由 | 跨语言任务按 languages 路由到 pod；资源隔离验证 |
| **Phase 3：code 侧观测增强** | diagnostics/outline 注入 agent 观测面；bench 套件对比（有/无 IDE 面的 coding 任务步数/token/成功率） | 基线报告 + 对照报告（bench baseline gate） |

每阶段独立可验收、可回滚；Phase 0/1 不依赖 pod（sandbox 内容纳）。

## 6. 与既有债务/计划的关系

- 不阻塞 D1–D5 延后事项；Phase 2 的 pod 拓扑与 container-runtime-adapter（R4/R5）有协同
- 结构重组方案 P3（src↔packages 收口）若先落地，`ptc/capabilities/` 归属随之迁移，本设计不受影响
- 性能验证依赖 bench（pth-bench-unified）；**基线采集先行**——设计评审通过后即以现网 developer 真实任务建立 coding 性能基线（无 IDE 面），供 Phase 3 对照

## 7. 风险登记

| 风险 | 等级 | 缓解 |
|---|---|---|
| language server 内存失控拖垮 sandbox | 高 | 独立池 + RSS 上限 + pod 隔离 |
| LSP 版本同步（didChange 序号）bug 导致诊断陈旧 | 中 | 写路径唯一入口（dev.write/edit 联动同步）；诊断带版本号回显 |
| 协议子集之外的能力诱惑（范围蠕变） | 中 | §2.1 白名单即契约；新增方法须改契约 + 评审 |
| adapter 质量参差（小众语言 DAP 不成熟） | 低 | 逐语言接入，失败回退"无调试面"（行为=现状） |

## 8. 非目标（Non-goals）

- 不做人类 IDE UI（operator-console 仅展示诊断摘要，不内嵌编辑器）
- 不做 LSP 全量协议、不做 semantic tokens/格式化
- 不改变 worker 的任务主循环与收敛策略（IDE 面是能力增量，不是流程改造）
