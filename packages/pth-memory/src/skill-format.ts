/**
 * skill-format.ts —— skill 记忆类型四段式格式（2026-08-15 B4 Phase 1）。
 *
 * W1（2026-08-15 已裁决）：skill = 四段式声明式知识条目——
 *   ① 场景锚点三要素（【场景锚点】/【何时用】/【效果】）
 *   ② Procedure（有序步骤——每步标注调用代价——W3 访问复杂度质检项）
 *   ③ Pitfalls（已知失败模式与修正——负知识结构化）
 *   ④ Verification（怎么确认成功——验收标准）
 *
 * B4-1（2026-08-14 已裁决）：skill 不可变、写后冻结；不进 JIT deopt/复测面；
 * 维护 = memory-keeper 专项（Phase 3 维护面按角色注入）。
 * 本模块只产出声明式内容与种子数据——检索面（skills.get/两级清单）属 Phase 2。
 */

export const SKILL_FORMAT_SECTIONS = ["场景锚点", "Procedure", "Pitfalls", "Verification"] as const;

/** W3 访问复杂度：Procedure 每步标注调用代价（工具调用数/基本函数语句数）——总代价超阈值需拆分 */
export interface SkillProcedureStep {
  step: string;
  cost: string;
}

export interface SkillSopSeed {
  /** skill:<id> 的 id 段（不含前缀） */
  id: string;
  /** 场景锚点三要素之一：锚点 */
  anchor: string;
  /** 场景锚点三要素之二：何时用 */
  whenToUse: string;
  /** 场景锚点三要素之三：效果 */
  effect: string;
  procedure: SkillProcedureStep[];
  pitfalls: string[];
  verification: string[];
}

/** 四段式模板（Phase 2/4 的 skill 条目化与 SKILL.md→条目 映射按此形状） */
export const SKILL_SOP_TEMPLATE = `# skill:<name>（SOP——四段式 v1）

【场景锚点】<anchor>
【何时用】<whenToUse>
【效果】<effect>

## Procedure（每步标注调用代价）
1. <step>（代价：<cost>）

## Pitfalls（已知失败模式与修正）
- <pitfall>

## Verification（怎么确认成功）
- <verification>
`;

/** 种子 → skill 条目 content（幂等：同一输入产出同一文本） */
export function buildSkillContent(seed: SkillSopSeed): string {
  const steps = seed.procedure
    .map((p, i) => `${i + 1}. ${p.step}（代价：${p.cost}）`)
    .join("\n");
  const pitfalls = seed.pitfalls.map((p) => `- ${p}`).join("\n");
  const verification = seed.verification.map((v) => `- ${v}`).join("\n");
  return `# skill:${seed.id}（SOP——四段式 v1）

【场景锚点】${seed.anchor}
【何时用】${seed.whenToUse}
【效果】${seed.effect}

## Procedure（每步标注调用代价）
${steps}

## Pitfalls（已知失败模式与修正）
${pitfalls}

## Verification（怎么确认成功）
${verification}
`;
}

/** B4-2 裁决 A：首批 3 条角色 SOP 种子（2026-08-15——从 role.prompt 提炼条目化） */
export const SEED_SKILL_SOPS: SkillSopSeed[] = [
  {
    id: "developer-sop",
    anchor: "执行 developer 角色任务——把上下文/计划变成可交付的实现",
    whenToUse: "任务标签 implement/code/fix，或任务要求代码实现、缺陷修复、技术交付",
    effect: "拿到按计划实现、经过自验、可直接验收的产物（代码/补丁/文件清单）",
    procedure: [
      { step: "读上下文与计划（plan/context）——明确改动范围与验收标准", cost: "1×memory.query（或系统注入文档）" },
      { step: "定位目标源码——fs.readSource/fs.readText 读相关模块，确认现状", cost: "1–2×fs.readSource" },
      { step: "实现最小改动——产物落任务工作区（fs.task.write），narrow coherent edits：一次一个一致修改", cost: "1–3×fs.task.write" },
      { step: "自验——按语言核跑通（ts.run/python.run/bash.run/dev.run），修到通过", cost: "2–5×执行核调用" },
      { step: "交付——done 带 result（产物清单/测试输出）；未达标不 done", cost: "1×done" },
    ],
    pitfalls: [
      "不读 plan/context 直接写——产物偏离验收标准，被 tester/acceptor 打回",
      "不运行就交付——低级错误浪费验收轮次",
      "贪大改动——违背 narrow edits：一次只做一个一致的修改",
      "忽视执行核错误信息——错误信息是免费的调试线索",
    ],
    verification: [
      "改动产物存在且路径正确（fs.task.list 可见）",
      "自验通过（执行核 ok=true，测试输出无失败）",
      "done.result 包含产物清单与验证证据",
    ],
  },
  {
    id: "scout-sop",
    anchor: "执行 scout 角色任务——快速收集信息并压缩上下文交接下游",
    whenToUse: "任务标签 recon/investigate，或任务要求环境探查、代码侦察、信息收集",
    effect: "下游角色拿到可直接使用、带来源的结构化 context，无需重复侦察",
    procedure: [
      { step: "明确侦察目标与交付物（给谁用、要什么信息）", cost: "0（内部思考）" },
      { step: "查既有资产——memory.query 先查（wiki/insight/角色文档），不重复调查", cost: "1×memory.query" },
      { step: "查能力与源码——fs.readSource 读相关实现，确定事实", cost: "1–2×fs.readSource" },
      { step: "执行侦察——bash.run（ls/cat/grep）或 web/ext 按目标收集", cost: "2–5×bash.run/web.fetchText" },
      { step: "压缩交接——结论按「事实 + 来源 + 给谁用」整理为 context，done 交付", cost: "1×done" },
    ],
    pitfalls: [
      "同一路径/同参数反复盲试——触发负结果收敛；每次换目标或换策略",
      "只传原始输出不压缩——下游注意力被稀释",
      "无来源记录——下游无法复核",
      "把侦察当任务终点——scout 的价值是压缩后的 context 交接",
    ],
    verification: [
      "context 可被下游直接消费（含关键事实与来源路径）",
      "信息来自实际查询（有命令/查询记录），无臆测",
      "已先查 memory 既有资产，未重复调查",
    ],
  },
  {
    id: "memory-keeper-sop",
    anchor: "执行 memory-keeper 角色任务——维护记忆库的整理、沉淀与索引",
    whenToUse: "任务标签 memory/organize，或任务要求知识沉淀、索引维护、归档整理",
    effect: "记忆库保持低重复、高命中、索引准确——后续任务查得到",
    procedure: [
      { step: "明确维护对象与范围（哪类条目/哪个知识域）", cost: "0（内部思考）" },
      { step: "检索现状——memory.query 按 kind/anchor 查相关条目", cost: "1×memory.query" },
      { step: "检查一致性/矛盾——把新旧条目按术语与锚点对齐，检查定义冲突、规则冲突；发现矛盾先以 draft 记录并标注冲突，不静默覆盖", cost: "1×memory.query + 0–1×memory.write（draft）" },
      { step: "检查重复率——按 kind/anchors 统计近似重复（同一事实多个条目），量化重复比例", cost: "1×memory.query" },
      { step: "使用引用降重——重复条目不复制正文：保留主条目，副条目 content 写「见主条目 <id>」+ promotedFrom 指向主条目 id，anchors 合并到主条目", cost: "1–2×memory.write" },
      { step: "索引维护——anchors 补术语/别名，保证三要素锚点质量", cost: "1×memory.write（update）" },
      { step: "验证——memory.query 复查新条目可命中、状态正确", cost: "1×memory.query" },
    ],
    pitfalls: [
      "prompt/config 层只读——role-doc/skill/trigger 等不可写（memory-policy 会拒绝）",
      "发现矛盾直接覆盖旧结论——必须先把冲突显式化（draft 记录），再裁决或标注",
      "只看重复不量化——先统计重复率再决定合并范围，避免误合并不同事实",
      "降重时复制正文——重复条目应写引用指针（见主条目 + promotedFrom），否则将来双份漂移",
      "锚点缺失或太宽——必须「描述清楚何时读」：场景 + 何时用 + 效果",
      "删除/归档不经治理通道——归档走 manage.memory.archive 提案审批",
    ],
    verification: [
      "新条目 kind/anchors/status 正确且可被 memory.query 命中",
      "无未处理的矛盾（冲突已 draft 记录或已裁决），无新增重复正文",
      "降重副条目的 promotedFrom 指向主条目 id，且按引用可回查原文",
      "命中测试：目标场景关键词能查到该条目",
    ],
  },
];

/**
 * N14 P3（2026-08-18）：分层 SOP × 4——0.17.4 四层次优化工作流标准
 * （设计 docs/pth/n14-sensor-controller-four-dims.md §4 原文条目化；W4 创建时机=「找到正路」）。
 * SOP 粒度裁决（设计内自决）：每层次一条通用 SOP——点位级差异在 Procedure 内分化。
 */
export const SEED_OPT_SOPS: SkillSopSeed[] = [
  {
    id: "opt-tool-face",
    anchor: "sensor:tool-face 观测到重复工具组合链/多步绕行",
    whenToUse: "组合链频次 ≥ 阈值（≥3 任务复现）或穿透/注册候选出现",
    effect: "组合成本外移——LLM 一次 tool call 替代 N 步组合",
    procedure: [
      { step: "读 sensor:tool-face 观测报告（候选链清单）", cost: "1×obs 查询" },
      { step: "判定固化形态：确定性→program；判断类→agent；性能/特权→builtin", cost: "1×推理" },
      { step: "走治理流提案（manage.tool.register——kind=tool-proposal draft → 对抗性审核 → 批准 → 注册）", cost: "1×manage.tool.register" },
      { step: "复测验证（组合步数下降）", cost: "1×verify 任务" },
    ],
    pitfalls: [
      "工具面预算守卫：超限先合并/退役，不硬塞（专注度命题 3）",
      "快照版本化：不在任务中途变工具面（T3 教训）",
      "候选池 ≠ 工具：未过审批的沉淀物不进列表",
    ],
    verification: [
      "复测任务同场景组合步数下降 ≥50% 或调用成功率上升；tool-reg official 可查",
    ],
  },
  {
    id: "opt-tool-single",
    anchor: "sensor:tool-single 报告某工具高失败率/误用聚类/描述缺陷",
    whenToUse: "工具级失败率 > 15%（repeated-fail 同款阈值）或 unknown-tool 幻觉集中",
    effect: "单工具调用成功率上升、误用率下降",
    procedure: [
      { step: "读观测报告定位工具与失败模式", cost: "1×obs 查询" },
      { step: "归因分类：描述误导 / 参数契约不清 / 交互摩擦（mode 误用）/ 功能缺口", cost: "1×推理" },
      { step: "对症提案：修描述三要素 / 调交互协议 / 提功能扩展（manage.tool.revise——修订 = 新版本）", cost: "1×manage.tool.revise" },
      { step: "审批生效后复测", cost: "1×verify 任务" },
    ],
    pitfalls: [
      "描述修订保持三要素（T8 标准——场景锚点/何时用/效果）",
      "工具不可变：修订 = 新版本，不就地改（B4-1）",
    ],
    verification: [
      "复测窗口该工具失败率回落至阈值下；幻觉邻近名消失",
    ],
  },
  {
    id: "opt-memory",
    anchor: "sensor:memory 报告记忆缺口/重复条目/僵尸 draft/低命中",
    whenToUse: "缺口定位（0.15 记忆缺口）或质量聚合超阈值",
    effect: "检索步数下降、命中质量上升",
    procedure: [
      { step: "读观测报告（缺口清单/重复聚类）", cost: "1×obs 查询" },
      { step: "对症：补条目（refiner 沉淀路由）/ 合并重复 / 归档僵尸 / 优检索路径", cost: "1-2×memory 操作" },
      { step: "归档/合并类走 manage.memory.archive 提案（治理流）", cost: "1×提案" },
      { step: "复测检索面（两级检索 ≤2 步达标——W3 访问复杂度）", cost: "1×verify 任务" },
    ],
    pitfalls: [
      "删除类不自动（记忆是核心资产——治理层流转）",
      "补条目先查重（N1b 矛盾检测）",
    ],
    verification: [
      "缺口场景检索 ≤2 步命中；重复聚类收敛；hit_count 均值回升",
    ],
  },
  {
    id: "opt-rule",
    anchor: "sensor:rule 报告护栏误杀/规则未生效/权限拒绝异常",
    whenToUse: "护栏 hit/kill 比异常或引导消息反复出现 ≥3 任务",
    effect: "行为约束精准化——误杀下降、越界收敛",
    procedure: [
      { step: "读观测报告（obs.guards 护栏计数/拒绝分布）", cost: "1×obs 查询" },
      { step: "归因：阈值不当 / 豁免缺失 / 规则文案不生效 / 权限过紧过松", cost: "1×推理" },
      { step: "对症：manage.params.set 热调 PTH_GUARD_* / 豁免矩阵提案 / 规则文案 stamp 提案（optimizer-suggestion 通道）", cost: "1×调节调用" },
      { step: "复测窗口对比（恶化回滚——deopt 同款）", cost: "1×verify 任务" },
    ],
    pitfalls: [
      "阈值调整走配置中心（PTH_GUARD_*——不硬编码）",
      "豁免不进代码——豁免矩阵声明式（N12）",
      "治理族不豁免（D2 裁决——阈值放宽替代豁免的先例）",
    ],
    verification: [
      "复测窗口误杀率下降且越界事件不升；护栏参数变更有 audit 留痕",
    ],
  },
];
