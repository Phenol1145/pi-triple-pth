/**
 * catalog/extensions/extension-context.ts — 目录贡献装载上下文（模块化 v2 P3-3）。
 *
 * 只提供贡献元数据与宿主实现挂载点，不接触 ExtRegistry 的 legacy eval 路径。
 */

export interface ExtensionContributionContext {
  extensionId: string;
  /** 宿主实现是否存在（roles/spaces/observers/capabilityPolicies 的挂载点） */
  hasRoles: boolean;
  hasSpaces: boolean;
  hasObservers: boolean;
  hasCapabilityPolicies: boolean;
}
