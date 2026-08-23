/**
 * execution/internal-executor-registry.ts —— Execute 层 internal 命令注册表（TCE Phase 4）。
 *
 * capability → 实现；供 UnifiedExecutionDispatcher.executeInternal 消费。
 * dev/write/debug/nav 等工具体后续逐个搬迁为 internal executor（行为不变，只搬管线）。
 */
import type { ExecutionResult } from "@away_from/pth-kernel-execution";

export type InternalExecutor = (
  capability: string,
  args: Record<string, unknown>,
) => Promise<ExecutionResult>;

export class InternalExecutorRegistry {
  private readonly executors = new Map<string, InternalExecutor>();

  register(capability: string, executor: InternalExecutor): void {
    this.executors.set(capability, executor);
  }

  get(capability: string): InternalExecutor | undefined {
    return this.executors.get(capability);
  }

  has(capability: string): boolean {
    return this.executors.has(capability);
  }

  async execute(capability: string, args: Record<string, unknown>): Promise<ExecutionResult> {
    const executor = this.executors.get(capability);
    if (!executor) {
      return {
        ok: false,
        error: { message: `internal executor 未注册: ${capability}` },
        durationMs: 0,
      };
    }
    try {
      const r = await executor(capability, args);
      return { ...r, durationMs: r.durationMs ?? 0 };
    } catch (error) {
      return {
        ok: false,
        error: { message: error instanceof Error ? error.message : String(error) },
        durationMs: 0,
      };
    }
  }
}
