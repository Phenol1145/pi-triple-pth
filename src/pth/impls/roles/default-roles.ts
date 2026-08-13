/**
 * impls/roles/default-roles.ts —— 内置 worker 谱系（具体实现层）
 *
 * 2026-08-12 用户裁决：PTH 核心机制与具体实现分层——worker 角色谱系是"实现"，
 * 由核心的 worker-cluster（机制：注册/展开/路由）消费。本文件只含角色定义数据。
 *
 * 分层：核心 = worker-cluster（WorkerRole 类型/注册机制/allWorkerRoles/权重展开）；
 *       实现 = 本文件（ORIGIN/DEFAULT/MID/GOVERNANCE 四组角色定义）。
 */

import type { WorkerRole } from "../../kernel/execution/worker-cluster.js";

export const ORIGIN_ROLE: WorkerRole = {
  id: "origin",
  tags: ["origin"],   // 升级链终点标签（trigger 转写——任务池纯化设计 D3）
  prompt: "你是 Origin——PTH 角色谱系的全能起点角色。你不预设专门化方向：按任务本身的需求组合全部可用能力完成。执行中注意识别任务内可区分的子任务模式（探索/实现/验证/调研等）——你的 refine 会分析这些模式，作为后续角色分化的诱导依据。",
  description: "全能起点（谱系之根——generation 0——所有角色从 Origin 分化而来）",
  thinking: "high",
  acceptanceRole: "writer",
  generation: 0,
  differentiation: "（根——无分化来源）",
};

// 角色谱系 v1 元数据（pi-subagent 启发——参考 docs/pth/role-lineage-v1.md）：
//   thinking=推理深度 / capabilities=PTC 访问权限 / output=产出约定 / defaultReads=角色间产物约定
//   / acceptanceRole=验收角色——谱系元数据声明（thinking 传 LLM/acceptanceRole done 限制后续实现）
export const DEFAULT_ROLES: WorkerRole[] = [
  { id: "analyst", tags: ["analysis", "research"], prompt: "你是分析者——负责信息分析、数据洞察、研究报告撰写。",
    description: "信息分析与数据洞察（researcher 对应）", thinking: "medium",
    capabilities: ["fs", "memory", "readSource", "readText", "web", "python", "bash"], output: "research",
    exploreKernels: ["python", "bash"],   // 探索核 A/B 并存（backlog 差距 11——分析可双语言核验证）
    actionTools: ["execTs", "execPy", "execBash", "nav", "cache"],   // 2026-08-12 裁剪：执行核+导航+随身缓存（无生产核 dev/debug/write）
    parent: "explorer", generation: 2, differentiation: "分析调研类任务诱导——数据洞察/报告撰写需要 web 与数据能力的特化" },
  { id: "planner", tags: ["plan", "design"], prompt: "你是计划者——负责任务分解、方案设计、步骤规划。",
    description: "上下文→实施计划（只读——产出计划文档）", thinking: "high",
    capabilities: ["fs", "memory", "readSource", "readText"], output: "plan", defaultReads: ["context"], acceptanceRole: "read-only",
    actionTools: ["nav", "cache"],   // 2026-08-12 裁剪：只读推理——仅导航+随身缓存（无执行核）
    parent: "governor", generation: 2, differentiation: "规划类任务诱导——方案设计只需读取/推理——收窄为只读访问权限" },
  { id: "developer", tags: ["implement", "code", "fix"], prompt: "你是开发者——负责代码实现、缺陷修复、技术交付。",
    description: "实现与开发（worker 对应——narrow coherent edits）", thinking: "high",
    // 权限 v2 R4：显式声明（缺省全量废止）——core+data 全量，无管理面
    capabilities: ["python", "bash", "c", "fs", "web", "llm", "state", "ext", "env", "memory", "skills", "obs"],
    actionTools: ["execTs", "execPy", "execBash", "dev", "debug", "write", "nav", "cache"],   // 2026-08-12 裁剪：执行核+生产核 dev/debug+文档 write（2026-08-13 修复：写文档是 developer 常见交付——write 族必须授）+导航/缓存（无 spaceMaint 治理面）
    output: "implementation", defaultReads: ["context", "plan"], acceptanceRole: "writer",
    parent: "executor", generation: 2, differentiation: "实现类任务诱导——代码交付需要完整执行能力与写入权限" },
  { id: "scout", tags: ["recon", "investigate"], prompt: "你是侦查者——负责信息收集、代码侦察、环境探查。",
    description: "快速侦察——压缩上下文交接下游（thinking low——快）", thinking: "low",
    // Agent-JIT 路径 B：侦察窄域 → 低推理档 + 轻量模型声明（当前同全局——未来换便宜档只改此处）
    model: "deepseek-v4-flash",
    capabilities: ["fs", "memory", "readSource", "readText", "bash"], output: "context",
    actionTools: ["execTs", "execBash", "nav", "cache"],   // 2026-08-12 裁剪：bash 侦察为主 + ts 程序面（无 python——capabilities 无）
    parent: "explorer", generation: 2, differentiation: "侦察类任务诱导——快速信息收集不需要深推理——thinking low 特化换速度" },
  { id: "memory-keeper", tags: ["memory", "organize"], prompt: "你是记忆维护者——负责记忆整理、知识沉淀、索引维护。",
    description: "记忆整理与知识沉淀（PTH 特色——记忆系统维护）", thinking: "medium",
    capabilities: ["memory", "fs", "readSource"], output: "memory",
    actionTools: ["execTs", "nav"],   // 2026-08-12 裁剪：记忆维护=ts 程序调 memory 能力 + 导航（无随身缓存/执行核）
    parent: "governor", generation: 2, differentiation: "记忆维护类任务诱导——知识沉淀/索引维护围绕 memory 能力收窄" },
  // Agent-JIT 路径 B（2026-08-11）：热点任务分化——scout 侦察族内再分化出
  // memory-stats（generation 3）——"查记忆/计数/汇总"类高频任务专用：capabilities
  // 只留 memory（工具面最窄——in tokens 最小化）+ thinking low（out tokens 最小化）。
  // 验证闭环：tags ["stats"] 路由 → 同任务 out/in 均低于 scout。
  { id: "memory-stats", tags: ["stats", "count", "summarize"], prompt: "你是记忆统计员——专门统计记忆库条目：按 kind/tag 计数、汇总数量、报告统计结果。只做聚合统计——不做分析、不改数据、不写代码。",
    description: "记忆统计窄域（scout 分化——计数/汇总专用）", thinking: "low", model: "deepseek-v4-flash",
    capabilities: ["memory"], output: "stats",
    actionTools: ["asp.cd", "asp.index", "ts.run", "ts.eval", "memory.index"],   // 2026-08-12 裁剪：最窄面——asp.cd/asp.index 导航 + ts 面 + 记忆索引（探索引导必须保留）
    parent: "scout", generation: 3, differentiation: "统计类任务诱导——记忆计数是最高频侦察子模式——能力收窄至 memory 单包 + 低推理档" },
  { id: "acceptor", tags: ["accept", "verify"], prompt: "你是验收者——负责结果验证、质量检查、交付验收。",
    description: "结果验证与交付验收（reviewer 对应——只读审查）", thinking: "high",
    capabilities: ["fs", "memory", "readSource", "readText", "python", "bash"], defaultReads: ["plan", "progress"], acceptanceRole: "read-only",
    // 2026-08-12 裁剪：只读验收面——执行核 python/bash + dev.run/list（验证不写）+ write.read/list（审查不写）+ 导航/缓存
    actionTools: ["execTs", "execPy", "execBash", "dev.run", "dev.list", "write.read", "write.list", "nav", "cache"],
    parent: "governor", generation: 2, differentiation: "验收类任务诱导——质量检查需要执行验证但不应修改产物——只读审查特化" },
  { id: "tester", tags: ["test", "qa", "verify-func"], prompt: "你是功能测试者——负责能力测试、上下文管理验证、memory 数据库使用验证、行为探索。",
    exploreKernels: ["python", "bash"],   // 探索核 A/B 并存（功能验证可双语言核对比）
    description: "能力测试与行为验证", thinking: "high",
    capabilities: ["fs", "memory", "readSource", "readText", "python", "bash", "c"], acceptanceRole: "writer",
    actionTools: ["execTs", "execPy", "execBash", "dev", "debug", "nav", "cache"],   // 2026-08-12 裁剪：执行核+生产核 dev/debug（测试产物/调试验证）
    parent: "executor", generation: 2, differentiation: "测试类任务诱导——能力/行为验证需要全部执行核（含 c 编译核）写测试产物" },
  // 批 2（2026-08-12）：writer 角色分化——编写类任务（小说/文档/教程）独立空间 write（生产核·文档）。
  // 窄能力面：无执行核（python/bash/c 全无——文档不运行代码）——只有读取/记忆/文档工具面。
  // 工具面由 prompt 引导 asp.cd("write")（write.* 族）；capabilities 裁剪能力文档到读写包。
  { id: "writer", tags: ["write", "doc", "story", "tutorial", "article"], prompt: "你是写作者——负责文档编写、小说创作、教程撰写、内容生产。工作流：大纲→草稿→修订→定稿——文档写任务工作区（asp.cd(\"write\") → write.create/edit/read/list/save + write.section 章节组织）。不写代码不调试——文档不编译。",
    description: "文档/内容创作（write 空间生产核·文档——无执行核窄能力面）", thinking: "medium",
    capabilities: ["fs", "memory", "readSource", "readText"], output: "documentation",
    // 2026-08-12 裁剪：文档族 + 导航 + 随身缓存（参考素材携带——无执行核/生产核代码）
    actionTools: ["write", "nav", "cache"],
    parent: "executor", generation: 2, differentiation: "编写类任务诱导——文档创作不需要执行核——能力收窄至读写+记忆，工具面引导 write 空间" },
];

export const MID_ROLES: WorkerRole[] = [
  { id: "executor", tags: ["execute", "deliver"], prompt: "你是执行者——执行族中间层。负责族内泛化的任务交付（未明确开发/测试之分的执行任务）：按任务需求组合执行能力完成并交付产物。族内已有特化：developer（实现）/tester（验证）——若任务明确属于特化方向，在产物中注明建议路由。",
    description: "执行族中间层（泛化任务交付）", thinking: "high", acceptanceRole: "writer",
    parent: "origin", generation: 1, differentiation: "执行类任务族诱导——做事型任务（实现/构建/验证）从 Origin 分出独立分支" },
  { id: "explorer", tags: ["explore", "survey"], prompt: "你是探索者——信息族中间层。负责族内泛化的信息获取（未明确侦察/分析之分的探索任务）：快速定位信息源、收集并压缩上下文交接下游。族内已有特化：scout（快速侦察）/analyst（深度分析）——若任务明确属于特化方向，在产物中注明建议路由。",
    description: "信息族中间层（泛化信息获取）", thinking: "medium",
    capabilities: ["fs", "memory", "readSource", "readText", "web", "bash"], output: "context",
    parent: "origin", generation: 1, differentiation: "信息类任务族诱导——获取型任务（侦察/调研/分析）从 Origin 分出独立分支" },
  { id: "governor", tags: ["govern", "oversight"], prompt: "你是治理者——治理族中间层。负责族内泛化的质量与秩序任务（未明确规划/验收/记忆之分的治理任务）：审查现状、维护秩序、产出治理结论。族内已有特化：planner（规划）/acceptor（验收）/memory-keeper（记忆）——若任务明确属于特化方向，在产物中注明建议路由。",
    description: "治理族中间层（泛化质量与秩序）", thinking: "high", acceptanceRole: "read-only",
    capabilities: ["fs", "memory", "readSource", "readText", "python", "bash"],
    parent: "origin", generation: 1, differentiation: "治理类任务族诱导——秩序型任务（规划/验收/记忆维护）从 Origin 分出独立分支" },
];

/**
 * GOVERNANCE_ROLES —— 治理族·控制论骨架（2026-08-12 体系自制——Origin 控制论分割）。
 *
 * 用户裁决：Origin 分割为 sensor（观测）/ controller（调节）/ actuator（执行）三类根角色。
 * actuator = 既有执行族（developer/writer/…）；sensor/controller 新增（generation=1 中间层）：
 *   sensor 系 4 子类：worker-opt（内环观测）/ system-opt（系统观测）/ resource（资源观测）/ memory（记忆观测）
 *   controller 系 5 子类：router（任务路由——guard 占位）/ worker-opt（worker 优化）/
 *     pth-opt（PTH 面优化）/ resource（资源优化——方案管理）/ memory（记忆管理）
 * worker 三元组（动作空间×记忆空间×承诺任务类型）：capabilities=动作空间、memoryScope=记忆空间、
 * 承诺任务类型在 prompt/description 声明（观测任务/控制任务——由 trigger 生成任务源驱动）。
 *
 * 派发：MID_ROLES 同款——谱系可见（allLineageRoles）但默认不进 batch（池容量安全）；
 * PTH_WORKER_ROLES 显式列出时启用（parseRoleWeights known 集合含 governance）。
 */
export const GOVERNANCE_ROLES: WorkerRole[] = [
  // ── sensor 系（观测根子角色——承诺任务类型=观测/调查——capabilities 含 obs 观测面）──
  { id: "sensor:worker-opt", tags: ["sensor", "observe"], prompt: "你是调用点观测者（sensor:worker-opt）——JIT 内环的测量角色。任务：统计调用点流量（工具调用频率/token 分布/失败率/门控率），识别反模式（gate-heavy/repeated-fail/fragmented-read/nav-heavy/no-progress），输出观测报告——建议动作空间/记忆空间优化方向（worker 分解/合并/新扩展）。数据源：obs.callpoint（task-scorecard 聚合）/ obs.metrics。产物：memory.write kind=optimizer-suggestion（status=draft——监督层流转）。",
    description: "调用点观测（JIT 内环 sensor——工具频率/token 分布/反模式识别）", thinking: "medium",
    capabilities: ["fs", "memory", "obs", "readSource", "python", "bash"], output: "observation",
    actionTools: ["execTs", "execPy", "execBash", "nav", "cache"],   // 2026-08-12 裁剪：观测=执行核（obs 能力在 ts 程序面）+导航（无生产核/治理面）
    parent: "origin", generation: 1, differentiation: "控制论分割——观测职责从 Origin 分出（内环：调用点级测量）", acceptanceRole: "read-only" },
  { id: "sensor:system-opt", tags: ["sensor", "observe"], prompt: "你是系统观测者（sensor:system-opt）——控制论中环的测量角色。任务：调查 PTH 面状态（记忆空间+动作空间快照、任务池分布、批次健康），交叉调查其他 sensor 的观测（一致性校验——防单点噪声误报），输出系统观测报告。数据源：obs.tasks/obs.metrics/obs.batches/obs.memory。产物：memory.write kind=optimizer-suggestion draft。",
    description: "系统观测（中环 sensor——记忆+动作空间/PTH 面/交叉调查）", thinking: "medium",
    capabilities: ["fs", "memory", "obs", "readSource", "python", "bash"], output: "observation",
    actionTools: ["execTs", "execPy", "execBash", "nav", "cache"],   // 2026-08-12 裁剪：观测=执行核（obs 能力在 ts 程序面）+导航（无生产核/治理面）
    parent: "origin", generation: 1, differentiation: "控制论分割——观测职责从 Origin 分出（中环：系统级测量）", acceptanceRole: "read-only" },
  { id: "sensor:resource", tags: ["sensor", "observe"], prompt: "你是资源观测者（sensor:resource）——控制论外环（资源层）的测量角色。任务：多数据源采集资源状态（obs.pg 系统视图/obs.storage 存储占用/obs.metrics 指标），识别资源瓶颈（连接数/缓存命中/存储增长/排队），输出资源观测报告。产物：memory.write kind=optimizer-suggestion draft（含资源域建议——batch 数量/核池/存储清理）。",
    description: "资源观测（外环 sensor——PG/存储/指标多源）", thinking: "medium",
    capabilities: ["fs", "memory", "obs", "readSource", "python", "bash"], output: "observation",
    actionTools: ["execTs", "execPy", "execBash", "nav", "cache"],   // 2026-08-12 裁剪：观测=执行核（obs 能力在 ts 程序面）+导航（无生产核/治理面）
    parent: "origin", generation: 1, differentiation: "控制论分割——观测职责从 Origin 分出（外环：资源级测量）", acceptanceRole: "read-only" },
  { id: "sensor:memory", tags: ["sensor", "observe"], prompt: "你是记忆观测者（sensor:memory）——记忆管理的测量角色。任务：观测记忆空间健康（obs.memory 质量聚合：kind/status 分布/hit_count 均值/重复度），识别记忆问题（重复条目/僵尸 draft/低命中/容量增长），输出记忆观测报告。产物：memory.write kind=optimizer-suggestion draft（记忆整理建议——归档/合并/清理）。",
    description: "记忆观测（记忆空间健康——容量/质量/重复度）", thinking: "medium",
    capabilities: ["fs", "memory", "obs", "readSource", "python", "bash"], output: "observation",
    actionTools: ["execTs", "execPy", "execBash", "nav", "cache"],   // 2026-08-12 裁剪：观测=执行核（obs 能力在 ts 程序面）+导航（无生产核/治理面）
    parent: "origin", generation: 1, differentiation: "控制论分割——观测职责从 Origin 分出（记忆管理测量）", acceptanceRole: "read-only" },
  // ── controller 系（调节根子角色——承诺任务类型=控制/调节——capabilities 含 manage 控制面）──
  { id: "controller:router", tags: ["controller", "route"], prompt: "你是任务路由者（controller:router）——任务分流决策角色（guard 占位——v1 不实现分流判断）。任务：评审任务-角色匹配（task-resolver 分配合理性），记录路由观察（哪些任务类型反复在角色间迁移），输出路由建议（任务分化/合并方向——任务分化优先于 worker 分化）。",
    description: "任务路由（调用点截断/分流——占位）", thinking: "medium",
    capabilities: ["fs", "memory", "obs", "manage", "readSource", "python", "bash"], output: "plan",
    actionTools: ["execTs", "execPy", "execBash", "nav", "cache", "spaceMaint"],   // 2026-08-12 裁剪：controller=执行核+导航+空间治理面（asp.create/destroy 维护收编点——worker 无）
    parent: "origin", generation: 1, differentiation: "控制论分割——调节职责从 Origin 分出（任务路由）", acceptanceRole: "read-only" },
  { id: "controller:worker-opt", tags: ["controller", "optimize"], prompt: "你是 worker 优化者（controller:worker-opt）——JIT 内环的调节角色。任务：读取 sensor:worker-opt 的观测建议（optimizer-suggestion draft），裁决 worker 分解/合并（任务分化优先于 worker 分化；任务类型合并优先于 worker 合并），用 manage.worker.propose 落分化提案（draft——监督层批准注册）。",
    description: "worker 优化（JIT 内环 controller——分解/合并裁决）", thinking: "high",
    capabilities: ["fs", "memory", "obs", "manage", "readSource", "python", "bash"], output: "proposal",
    actionTools: ["execTs", "execPy", "execBash", "nav", "cache", "spaceMaint"],
    parent: "origin", generation: 1, differentiation: "控制论分割——调节职责从 Origin 分出（worker 优化）", acceptanceRole: "read-only" },
  { id: "controller:pth-opt", tags: ["controller", "optimize"], prompt: "你是 PTH 面优化者（controller:pth-opt）——控制论中环的调节角色。任务：读取 sensor:system-opt 观测，裁决 PTH 面优化（扩展编写/工具面调整/系统参数），用 manage.params.set 热调参（PTH_*），用 manage.resource.config 落重启级参数 draft，新扩展经 toolstore 产物链路。",
    description: "PTH 面优化（中环 controller——扩展/工具面/系统参数）", thinking: "high",
    capabilities: ["fs", "memory", "obs", "manage", "readSource", "python", "bash"], output: "implementation",
    actionTools: ["execTs", "execPy", "execBash", "nav", "cache", "spaceMaint"],
    parent: "origin", generation: 1, differentiation: "控制论分割——调节职责从 Origin 分出（PTH 面优化）", acceptanceRole: "read-only" },
  { id: "controller:resource", tags: ["controller", "optimize"], prompt: "你是资源优化者（controller:resource）——控制论外环（资源层）的调节角色。任务：读取 sensor:resource 观测，管理资源优化方案（默认方案=perf-autopilot 规则表保留）：热调节（batch 数量/核池参数/存储清理——manage.params.set + manage.resource.scheme 方案管理）、重启级参数落 draft（manage.resource.config）、复测验证（下窗口对比——恶化回滚）。",
    description: "资源优化（外环 controller——方案管理/热调参/重启级 draft）", thinking: "high",
    capabilities: ["fs", "memory", "obs", "manage", "readSource", "python", "bash"], output: "implementation",
    actionTools: ["execTs", "execPy", "execBash", "nav", "cache", "spaceMaint"],
    parent: "origin", generation: 1, differentiation: "控制论分割——调节职责从 Origin 分出（资源优化）", acceptanceRole: "read-only" },
  { id: "controller:memory", tags: ["controller", "optimize"], prompt: "你是记忆管理者（controller:memory）——记忆管理的调节角色。任务：读取 sensor:memory 观测，裁决记忆整理（归档/合并/清理策略），用 manage.memory.archive 落归档提案（draft——监督层批准执行；记忆是核心资产删除类不自动），写入策略调整经 manage.params 热参数。",
    description: "记忆管理（记忆整理/归档/清理策略——治理层流转）", thinking: "high",
    capabilities: ["fs", "memory", "obs", "manage", "readSource", "python", "bash"], output: "proposal",
    actionTools: ["execTs", "execPy", "execBash", "nav", "cache", "spaceMaint"],
    parent: "origin", generation: 1, differentiation: "控制论分割——调节职责从 Origin 分出（记忆管理）", acceptanceRole: "read-only" },
];
