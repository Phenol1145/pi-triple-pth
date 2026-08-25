/**
 * execution/capability-policy.ts —— 内部命令能力策略表（TCE Phase 4）。
 *
 * 角色 `capabilities` 数组升格为唯一事实源；internal 命令（dev/write/debug/nav/
 * memory/obs/manage/tasks.* 等）按本表判定所需 capability 与批准语义。
 * 策展原则：obs 免批准（只读观测）；manage 自带 draft 语义（Command 层识别，不重复发起人工批准）；
 * 写类逐个策展（dev/write/memory.write 等需要对应写能力）。
 *
 * W4（ADR-0004）：表驱动授权退役中。方法级静态审核（PTC_CAPABILITIES + role.capabilities）
 * 已接管 dev/write/debug 等能力门控；本表仅作为兼容 shim 保留给 CommandGateway 旧路径。
 */

export interface InternalCapabilityPolicy {
  /** 角色 capabilities 中满足任一即可（未声明 = 全量兼容，向后兼容）。 */
  readonly requiredCapabilities?: readonly string[];
  /** 是否需要人类批准（agent-tool 面）；缺省 none。 */
  readonly approval?: "none" | "human";
  /** 是否自带 draft 提案语义（manage.*）——Command 层不重复发起批准。 */
  readonly draft?: boolean;
}

const EXACT_POLICY: Record<string, InternalCapabilityPolicy> = {
  // 生产核·代码/文档
  "dev.write": { requiredCapabilities: ["fs", "write", "dev"] },
  "dev.edit": { requiredCapabilities: ["fs", "write", "dev"] },
  "dev.build": { requiredCapabilities: ["dev", "c", "python", "bash"] },
  "dev.run": { requiredCapabilities: ["dev", "c", "python", "bash"] },
  "dev.save": { requiredCapabilities: ["fs", "write", "dev"] },
  "dev.list": { requiredCapabilities: ["dev", "c", "python", "bash"] },
  "write.create": { requiredCapabilities: ["fs", "write"] },
  "write.edit": { requiredCapabilities: ["fs", "write"] },
  "write.read": { requiredCapabilities: ["fs", "write"] },
  "write.list": { requiredCapabilities: ["fs", "write"] },
  "write.save": { requiredCapabilities: ["fs", "write"] },
  "write.section": { requiredCapabilities: ["fs", "write"] },
  // 调试（sandbox 会话操作）
  "debug.attach": { requiredCapabilities: ["dev", "c", "python", "bash"] },
  "debug.breakpoint": { requiredCapabilities: ["dev", "c", "python", "bash"] },
  "debug.continue": { requiredCapabilities: ["dev", "c", "python", "bash"] },
  "debug.step": { requiredCapabilities: ["dev", "c", "python", "bash"] },
  "debug.snapshot": { requiredCapabilities: ["dev", "c", "python", "bash"] },
  "debug.evaluate": { requiredCapabilities: ["dev", "c", "python", "bash"] },
  "debug.detach": { requiredCapabilities: ["dev", "c", "python", "bash"] },
  "debug.sessions": { requiredCapabilities: ["dev", "c", "python", "bash"] },
  // 导航/记忆（只读观测免批准）
  "asp.cd": { requiredCapabilities: ["nav"], approval: "none" },
  "asp.index": { requiredCapabilities: ["nav"], approval: "none" },
  "memory.index": { requiredCapabilities: ["memory"], approval: "none" },
  "memory.query": { requiredCapabilities: ["memory"], approval: "none" },
  "obs.query": { requiredCapabilities: ["obs"], approval: "none" },
  // 任务原语（组织权持有角色注入；走 CommandGateway 时按此门控）
  "tasks.delegate": { requiredCapabilities: ["tasks"] },
  "tasks.await": { requiredCapabilities: ["tasks"] },
  "tasks.answer": { requiredCapabilities: ["tasks"] },
  "tasks.resume": { requiredCapabilities: ["tasks"] },
  "tasks.penetrate": { requiredCapabilities: ["tasks"] },
};

const PREFIX_POLICY: Array<{ prefix: string; policy: InternalCapabilityPolicy }> = [
  { prefix: "manage.", policy: { requiredCapabilities: ["manage"], draft: true } },
];

export function internalCapabilityPolicy(capability: string): InternalCapabilityPolicy | undefined {
  const exact = EXACT_POLICY[capability];
  if (exact) return exact;
  for (const { prefix, policy } of PREFIX_POLICY) {
    if (capability.startsWith(prefix)) return policy;
  }
  return undefined;
}

/** 判断角色 capabilities 是否满足某 internal 命令策略（未声明 capabilities = 全量兼容）。 */
export function hasInternalCapability(
  capability: string,
  roleCapabilities: readonly string[] | undefined,
): boolean {
  const policy = internalCapabilityPolicy(capability);
  if (!policy?.requiredCapabilities) return true;
  if (!roleCapabilities) return true;
  return policy.requiredCapabilities.some((c) => roleCapabilities.includes(c));
}
