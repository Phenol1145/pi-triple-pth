/**
 * role-vocabulary.ts —— Role Catalog W0：角色词汇表收敛。
 *
 * 第一期枚举当前角色已使用的 capabilities / actionTools 词汇，作为 role-definition/v1
 * 卡片的登记闸。后续 W1 装载器与 check:role-conservation 改读本表。
 */

export const ROLE_CAPABILITY_VOCABULARY: ReadonlySet<string> = new Set([
  "bash", "c",
  "debug.attach", "debug.breakpoint", "debug.continue", "debug.detach", "debug.evaluate",
  "debug.sessions", "debug.snapshot", "debug.step",
  "dev.build", "dev.edit", "dev.list", "dev.run", "dev.save", "dev.write",
  "env", "ext", "fs", "llm", "manage", "memory", "net.fetch", "net.search", "net.extract", "obs", "python", "readSource", "readText",
  "skills", "state", "tools", "web",
  "write.create", "write.edit", "write.list", "write.read", "write.save", "write.section",
]);

export const ROLE_ACTION_TOOL_VOCABULARY: ReadonlySet<string> = new Set([
  "cache", "debug", "dev", "dev.list", "dev.run", "execBash", "execPy", "execTs", "nav",
  "write", "write.list", "write.read",
]);
