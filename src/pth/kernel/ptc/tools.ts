/**
 * ptc/tools.ts —— 工具契约注册表（2026-08-14 A1 Phase 3 条目 10——TOOL_SCHEMAS 生成器）。
 *
 * 35 个动作工具 schema 的单一真相源：工具面 = 能力契约的 tool_call 投影——
 * 三要素（anchor/whenToUse/effect——T8）与 PTC_CAPABILITIES 同构（ptc/contract.ts）。
 * agent-tools 的 TOOL_SCHEMAS 由 buildToolSchemas() 派生——改这里即改工具面
 * （LLM tool_calls 声明与 toolsDescription 文本同步自动更新）。
 *
 * description 组装 = 「【场景锚点：A】何时用：W。效果：E。」——与旧手写逐字节一致
 * （本文件由旧手写对象一次性提取生成 + round-trip 校验；ptc-tools 测试 golden 钉死）。
 */

export interface PtcToolDef {
  /** 点形工具名（ts.run / asp.create…） */
  name: string;
  /** 三要素（T8）：场景锚点 */
  anchor: string;
  /** 三要素（T8）：何时用 */
  whenToUse: string;
  /** 三要素（T8）：效果预告 */
  effect: string;
  /** 参数 JSON Schema（OpenAI function 格式 properties——逐字节保留旧值） */
  properties: Record<string, unknown>;
  required: string[];
}

/** 三要素 → 工具描述（与旧手写格式逐字节一致） */
export function renderToolDescription(d: PtcToolDef): string {
  return "【场景锚点：" + d.anchor + "】何时用：" + d.whenToUse + "。效果：" + d.effect + "。";
}

/** 工具契约注册表（35 条——动作工具面单一真相源；顺序即 prompt 文本顺序） */
export const PTC_TOOL_DEFS: PtcToolDef[] = [  { name: "python.run", anchor: "python 程序——python 生态/数据计算的多语句执行", whenToUse: "需要 python 库、多语句/循环、_result 值回传；ts 能做的用 ts（ts 程序内可 await python 能力）", effect: "多语句执行，_result 值回传", properties: {"code":{"type":"string","description":"python 程序（多语句；_result = 值 作为结果）"},"mode":{"type":"string","enum":["default","value-only","errors-only","quiet"]}}, required: ["code"] },
  { name: "python.eval", anchor: "python 单表达式——一行计算/查询", whenToUse: "单表达式求值；多语句用 python.run", effect: "表达式值即结果", properties: {"code":{"type":"string","description":"python 表达式（值即结果）"},"mode":{"type":"string","enum":["default","value-only","errors-only","quiet"]}}, required: ["code"] },
  { name: "bash.run", anchor: "bash 命令序列——环境操作/文件检查/管道", whenToUse: "多命令串联的环境操作与探测；产物写入不走 bash（走 dev.write/write.create）", effect: "stdout 即结果（截断 4000 字符）", properties: {"command":{"type":"string","description":"shell 命令（可多命令串联）"},"mode":{"type":"string","enum":["default","value-only","errors-only","quiet"]}}, required: ["command"] },
  { name: "bash.eval", anchor: "bash 单命令——ls/cat/grep 等简单探测", whenToUse: "单条命令快速查询；复杂脚本用 bash.run", effect: "stdout 即结果", properties: {"command":{"type":"string","description":"单条 shell 命令"},"mode":{"type":"string","enum":["default","value-only","errors-only","quiet"]}}, required: ["command"] },
  { name: "ts.run", anchor: "ts 程序（程序模式——优先）——一个程序组合多能力", whenToUse: "多步操作/变量/循环/组合能力函数（memory/llm/web/fs/python/bash）——优先写一个程序而非分步发多个动作；大内容一次取回后在程序内本地处理（切片/过滤/聚合），不重复分片读取", effect: "return 值回填 + stdout 可见", properties: {"code":{"type":"string","description":"ts 程序（顶层 await 可用；声明/多语句/控制流；return 对象作为结果）"},"mode":{"type":"string","enum":["default","value-only","errors-only","quiet"]}}, required: ["code"] },
  { name: "ts.eval", anchor: "ts 单表达式——一行查询/计算", whenToUse: "无变量无循环的单表达式（await memory.query 计数等）；多步骤用 ts.run", effect: "表达式值即结果", properties: {"code":{"type":"string","description":"ts 单表达式（顶层 await 可用；表达式的值即结果）"},"mode":{"type":"string","enum":["default","value-only","errors-only","quiet"]}}, required: ["code"] },
  { name: "done", anchor: "任务完成——提交最终产出", whenToUse: "有实际产物（实现/文件/计算结果）或明确无法完成（说明原因）时", effect: "任务结案；result 为空会被拒绝并回填引导（ASP：仅元空间可用）", properties: {"result":{"description":"最终产出对象（任意 JSON）——必填；须为实际产物（实现代码/写入的文件/计算结果），不能为空对象/空数组/空字符串"},"summary":{"type":"string","description":"完成说明"}}, required: ["result"] },
  { name: "dev.write", anchor: "写代码——实现第一步", whenToUse: "把完整实现一次写完（自动建目录），不要写几行跑一次的小步迭代", effect: "源码落任务工作区，可 build/run 验证", properties: {"path":{"type":"string","description":"工作区相对路径（如 main.c）"},"code":{"type":"string","description":"完整源码"},"mode":{"type":"string"}}, required: ["path","code"] },
  { name: "dev.edit", anchor: "改代码——编译/运行报错后精修", whenToUse: "唯一匹配替换（oldText 不匹配/多处匹配报错）；整段替换优先于零敲碎打", effect: "文件中该段被替换", properties: {"path":{"type":"string"},"oldText":{"type":"string"},"newText":{"type":"string"},"mode":{"type":"string"}}, required: ["path","oldText","newText"] },
  { name: "dev.build", anchor: "编译验证——写完代码检查语法", whenToUse: "只查语法不运行；直接要结果用 dev.run", effect: "编译产物（错误回填）", properties: {"path":{"type":"string"},"cc":{"type":"string"},"mode":{"type":"string"}}, required: ["path"] },
  { name: "dev.run", anchor: "运行验证——编译+运行一步", whenToUse: "写完代码直接拿结果；编译错误回填后 dev.edit 修，不重写整文件", effect: "运行结果（源码不变秒回缓存）", properties: {"path":{"type":"string"},"cc":{"type":"string"},"timeoutMs":{"type":"number"},"mode":{"type":"string"}}, required: ["path"] },
  { name: "dev.save", anchor: "交付保存——验证通过后", whenToUse: "保存为命名编译单元供跨任务复用；验证通过后再 save", effect: "toolstore compiled-units/<name>.c", properties: {"name":{"type":"string"},"path":{"type":"string"},"mode":{"type":"string"}}, required: ["name","path"] },
  { name: "dev.list", anchor: "查看已有编译单元——实现前先查复用", whenToUse: "新任务先 list——复用优于重写", effect: "已保存编译单元清单", properties: {"mode":{"type":"string"}}, required: [] },
  { name: "debug.attach", anchor: "调试第一步——dev.run 异常/崩溃时", whenToUse: "正常流程不需要调试，仅结果异常时", effect: "C 调试会话，返回 sessionId 句柄", properties: {"code":{"type":"string"},"path":{"type":"string"},"cc":{"type":"string"},"mode":{"type":"string"}}, required: [] },
  { name: "debug.breakpoint", anchor: "设断点——attach 后", whenToUse: "指定行停住（line 行号，condition 可选）", effect: "断点注册，命中时暂停", properties: {"sessionId":{"type":"string"},"line":{"type":"number"},"condition":{"type":"string"},"mode":{"type":"string"}}, required: ["sessionId","line"] },
  { name: "debug.continue", anchor: "继续执行——设好断点后", whenToUse: "跑到断点/退出", effect: "返回 reason + frame", properties: {"sessionId":{"type":"string"},"mode":{"type":"string"}}, required: ["sessionId"] },
  { name: "debug.step", anchor: "单步——定位具体行", whenToUse: "direction into/over/out 逐行推进", effect: "执行一步并停住", properties: {"sessionId":{"type":"string"},"direction":{"type":"string"},"mode":{"type":"string"}}, required: ["sessionId","direction"] },
  { name: "debug.snapshot", anchor: "变量全览——停住后首选", whenToUse: "断点命中后先 snapshot 再决定 evaluate 什么", effect: "全帧+顶层帧变量聚合快照", properties: {"sessionId":{"type":"string"},"mode":{"type":"string"}}, required: ["sessionId"] },
  { name: "debug.evaluate", anchor: "表达式求值——snapshot 后验证假设", whenToUse: "对具体变量/表达式求值", effect: "当前暂停位置上下文中的求值结果", properties: {"sessionId":{"type":"string"},"expr":{"type":"string"},"frameId":{"type":"number"},"mode":{"type":"string"}}, required: ["sessionId","expr"] },
  { name: "debug.detach", anchor: "释放会话——调完必调", whenToUse: "排查结束立即归还句柄（上限 4 个）", effect: "会话销毁", properties: {"sessionId":{"type":"string"},"mode":{"type":"string"}}, required: ["sessionId"] },
  { name: "debug.sessions", anchor: "查看活动会话", whenToUse: "需要确认存活会话", effect: "活动调试会话清单", properties: {"mode":{"type":"string"}}, required: [] },
  { name: "write.create", anchor: "写文档——初稿一次写完", whenToUse: "创建新文档；一次写完再 edit 修订，不要分段多次 create", effect: "工作区文档落盘", properties: {"path":{"type":"string"},"content":{"type":"string"},"mode":{"type":"string"}}, required: ["path","content"] },
  { name: "write.edit", anchor: "修订文档——改具体段落", whenToUse: "唯一匹配替换（oldText 必须唯一）", effect: "该段被替换", properties: {"path":{"type":"string"},"oldText":{"type":"string"},"newText":{"type":"string"},"mode":{"type":"string"}}, required: ["path","oldText","newText"] },
  { name: "write.read", anchor: "读文档——验证/续写前", whenToUse: "读全文（截断 6000 字符，长文档分段）", effect: "文档内容回传", properties: {"path":{"type":"string"},"mode":{"type":"string"}}, required: ["path"] },
  { name: "write.list", anchor: "看工作区已有文档——避免重复创建", whenToUse: "动笔前先查", effect: "工作区文档清单（*.md/txt/rst/adoc 递归）", properties: {"mode":{"type":"string"}}, required: [] },
  { name: "write.save", anchor: "定稿保存——跨任务复用", whenToUse: "文档定稿后存记忆单元", effect: "docs/<name>.md 记忆条目", properties: {"path":{"type":"string"},"name":{"type":"string"},"mode":{"type":"string"}}, required: ["path","name"] },
  { name: "write.section", anchor: "长文档结构整理——章节拆合", whenToUse: "op=list/split/reorder；短文档不需要", effect: "章节结构调整", properties: {"path":{"type":"string"},"op":{"type":"string"},"title":{"type":"string"},"target":{"type":"string"},"before":{"type":"string"},"mode":{"type":"string"}}, required: ["path"] },
  { name: "asp.cd", anchor: "空间切换——我的可达空间内切换注意力", whenToUse: "语言代码须在对应空间执行；done 仅元空间可用；绑定空间仅绑定 worker 类型可进入（语言执行基板全角色共享）", effect: "切换当前空间（工具面/记忆域随之切换——注意力重置）", properties: {"space":{"type":"string","description":"目标空间 id（meta/ts/python/bash/dev/write 基板或本角色绑定空间）"}}, required: ["space"] },
  { name: "asp.index", anchor: "空间地图——我的可达空间", whenToUse: "新任务/切空间前先看——本角色可进入的空间（基板 + 我的绑定空间）与生成状态；避免盲目 asp_cd 往返", effect: "空间树 + 当前空间可达函数与数据", properties: {"mode":{"type":"string","enum":["by-package","by-type"],"description":"聚合模式（缺省 by-package）"},"space":{"type":"string","description":"目标空间 id（缺省当前空间）"}}, required: [] },
  { name: "memory.index", anchor: "记忆库地图——查询/统计第一步必用", whenToUse: "避免逐条 SQL 盲查；统计任务一次就够，不要每步重复索引", effect: "顶层视图（kind 分布+热门 tag）/ tag 清单 / id 摘要+出边", properties: {"tag":{"type":"string","description":"按 tag 查关联条目"},"id":{"type":"string","description":"按条目 id 查其 tag 出边"}}, required: [] },
  { name: "cache.load", anchor: "跨空间携带数据——离开空间前先存", whenToUse: "后续步骤要反复取用的数据先载入（任何空间可引用）；来源 id/ids/tag 或 key+content", effect: "条目入随身缓存（硬容量限制，超容拒绝需先 cancel）", properties: {"id":{"type":"string","description":"记忆条目 id"},"ids":{"type":"array","items":{"type":"string"},"description":"批量条目 id"},"tag":{"type":"string","description":"按 tag 批量载入"},"key":{"type":"string","description":"自定义键（配合 content）"},"content":{"type":"string","description":"自定义内容（配合 key）"}}, required: [] },
  { name: "cache.index", anchor: "查看随身缓存", whenToUse: "确认缓存内容/占用/利用率", effect: "条目键/大小/剩余容量/利用率一览", properties: {}, required: [] },
  { name: "cache.cancel", anchor: "缓存释放", whenToUse: "腾位给更有价值的信息", effect: "条目移除", properties: {"key":{"type":"string","description":"要释放的缓存键"}}, required: ["key"] },
];

/** TOOL_SCHEMAS 派生（agent-tools 消费——工具面与能力面同一契约源） */
export function buildToolSchemas(): Record<string, { description: string; properties: Record<string, unknown>; required: string[] }> {
  const out: Record<string, { description: string; properties: Record<string, unknown>; required: string[] }> = {};
  for (const d of PTC_TOOL_DEFS) {
    out[d.name] = { description: renderToolDescription(d), properties: d.properties, required: d.required };
  }
  return out;
}
