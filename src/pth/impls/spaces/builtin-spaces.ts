/**
 * impls/spaces/builtin-spaces.ts —— 内置动作空间（具体实现层）
 *
 * 2026-08-12 用户裁决：PTH 核心机制与具体实现分层——内置空间定义是"实现"，
 * 由核心注册表 space-registry 装配（space-registry.ts 末尾 import 本文件触发注册）。
 *
 * 分层：核心 = space-registry（SpaceRegistry 注册表/门控反查/治理校验）；
 *       实现 = 本文件（meta/ts/python/bash/dev/write 六内置空间定义）。
 *
 * 函数式注册（registry 参数注入——2026-08-12 修复：顶层副作用触发 ESM 循环
 * TDZ——spaceRegistry 赋值在 esbuild CJS 转换中被延迟；由核心装配点调用本函数）。
 *
 * 替换点：未来"无内置空间"发行版 = 移除装配调用 + 改由扩展/装配注入。
 */
import type { SpaceRegistry } from "../../kernel/execution/space-registry.js";

/** 注册内置空间（核心装配点调用——参数注入避免循环依赖） */
export function registerBuiltinSpaces(registry: SpaceRegistry): void {
registry.register({ id: "meta", kind: "meta", description: "元空间——纯协议层（无执行核；done 唯一使用场所）", builtin: true });
registry.register({ id: "ts", kind: "action", execTool: "ts", parent: "meta", skeleton: "node:vm + stripTypes + preflight（import 拒绝/await 包装/超时双保险）", description: "TypeScript 程序空间（能力包注入：memory/llm/web/fs/state/ext…；元命令 ts.run/ts.eval）", builtin: true });
registry.register({ id: "python", kind: "action", execTool: "python", parent: "meta", skeleton: "PyKernel 持久 REPL（共享 globals/_result 通道/超时 kill 重启；元命令 python.run/python.eval）", description: "Python 持久 REPL 空间（sandbox 执行）", builtin: true });
registry.register({ id: "bash", kind: "action", execTool: "bash", parent: "meta", skeleton: "BashKernel 持久会话（元命令 bash.run/bash.eval）", description: "Bash 持久会话空间（sandbox 执行）", builtin: true });
// 生产核·代码产物（2026-08-11 用户裁决：探索核/生产核分立——编译类语言无探索核，C 的一切归 dev 空间；
// 原 c 空间（c_execute 空壳）撤销——C 产物编写/构建/运行/调试/单元管理全在 dev 空间）
registry.register({ id: "dev", kind: "action", execTool: "dev", extraTools: ["debug"], parent: "meta", skeleton: "生产核·代码产物（dev.write/edit/build/run/save/list + debug.* 调试会话——产物代码写任务工作区，sandbox 编译/调试）", description: "代码产物开发生产空间（编译类语言唯一入口）", builtin: true,
  // 空间治理 v2（批 3）：dev 是唯一可建子空间的内置空间——"把不确定的代码放进自制隔离子空间执行，用完注销"；
  // childParams = 子空间凭据必填参量表单（能力面 execTool/extraTools 收窄 + 记忆域 memoryScope 分配）
  allowChildren: true, maxDepth: 2,
  childParams: [
    { name: "execTool", required: true, description: "子空间语言执行工具名（能力面收窄——须为已注册语言族：ts/python/bash/dev/write）" },
    { name: "memoryScope", required: true, description: "记忆域标注（子空间记忆域名——缺省继承父空间；实际可见性过滤按空间 id 树）" },
    { name: "extraTools", description: "工具族收窄（父空间 extraTools 的子集——dev 下仅可挂 debug 族）" },
    { name: "description", required: true, description: "子空间说明" },
  ],
});
// 生产核·文档产物（2026-08-12 批 2：编写类任务独立空间——代码/文档两空间分立。
// 工具面 create/edit/read/list/save + section 章节组织（章节走文档内工具——非子空间）；
// 无 build/debug——文档不编译；allowChildren=false 章节不建子空间）
registry.register({ id: "write", kind: "action", execTool: "write", parent: "meta", skeleton: "生产核·文档产物（write.create/edit/read/list/save + write.section 章节组织——大纲→草稿→修订→定稿；文档写任务工作区，章节用 write.section 管理）", description: "文档产物生产空间（编写类任务唯一入口）", builtin: true });

}
