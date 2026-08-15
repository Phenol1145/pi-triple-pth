/**
 * 全局测试装配（2026-08-15 拆分）：内置角色 + 内置空间 + 记忆包空间查询。
 * 生产等价装配点：src/pth/kernel/assembly.ts（主进程）与 batch-process（fork 子进程）。
 * 单测文件内再调用 installDefaultRoles() 幂等无害（register 比较幂等）。
 */
import { installDefaultRoles } from "./helpers";

installDefaultRoles();
