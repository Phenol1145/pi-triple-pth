import type { ToolDefinition as PlatformToolDefinition } from "./types.js";

const BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const DEFAULT_ALLOWLIST = ["read", "bash", "edit", "write"];

export class ToolRegistry {
  private tenantAllowlists = new Map<string, string[]>();
  private customTools = new Map<string, PlatformToolDefinition[]>();
  /** SDK-level ToolDefinition (with execute()) keyed by tenant:toolName */
  private sdkDefinitions = new Map<string, any[]>();

  getAllowedTools(tenantId: string): string[] {
    const custom = (this.customTools.get(tenantId) ?? []).map((t) => t.name);
    const allowlist = this.tenantAllowlists.get(tenantId) ?? DEFAULT_ALLOWLIST;
    return [...new Set([...allowlist, ...custom])];
  }

  setTenantAllowlist(tenantId: string, tools: string[]): void {
    this.tenantAllowlists.set(tenantId, tools);
  }

  /**
   * Register a custom tool for a tenant.
   * @param sdkDef Optional SDK-level ToolDefinition with execute() — required for the tool
   *   to actually work end-to-end. Without it the tool appears in the allowlist but
   *   the agent won't know how to execute it.
   */
  registerCustomTool(tenantId: string, def: PlatformToolDefinition, sdkDef?: any): void {
    if (BUILTIN_TOOLS.includes(def.name)) {
      throw new Error(`Tool name "${def.name}" is reserved for built-in tools`);
    }
    const existing = this.customTools.get(tenantId) ?? [];
    const filtered = existing.filter((t) => t.name !== def.name);
    this.customTools.set(tenantId, [...filtered, def]);

    if (sdkDef) {
      const existingSdk = this.sdkDefinitions.get(tenantId) ?? [];
      const filteredSdk = existingSdk.filter((t: any) => t.name !== def.name);
      this.sdkDefinitions.set(tenantId, [...filteredSdk, sdkDef]);
    }
  }

  getCustomTools(tenantId: string): PlatformToolDefinition[] {
    return this.customTools.get(tenantId) ?? [];
  }

  /** Return SDK-level ToolDefinition[] for createAgentSession({ customTools }) */
  getSdkToolDefinitions(tenantId: string): any[] {
    return this.sdkDefinitions.get(tenantId) ?? [];
  }

  isBuiltin(name: string): boolean {
    return BUILTIN_TOOLS.includes(name);
  }
}
