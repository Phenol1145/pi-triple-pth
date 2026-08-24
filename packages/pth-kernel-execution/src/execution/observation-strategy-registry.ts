/**
 * observation-strategy-registry.ts —— 观察策略注册表。
 *
 * 声明式策略可以进 worker 热路径；脚本策略由外部异步队列/Execute 层调度，
 * 本注册表只登记元数据，不在热路径求值。
 */

import {
  assertValidObservationStrategySpec,
  evaluateObservationStrategy,
  type ActivityFactor,
  type ObservationStrategySpec,
} from "./observation-strategy.js";

export interface ObservationStrategyRegistration {
  readonly spec: ObservationStrategySpec;
  /** active = 可在热路径同步求值；async = 脚本策略，需异步调度。 */
  readonly mode: "active" | "async";
}

export class ObservationStrategyRegistry {
  private readonly strategies = new Map<string, ObservationStrategyRegistration>();

  register(spec: ObservationStrategySpec): void {
    assertValidObservationStrategySpec(spec);
    if (this.strategies.has(spec.id)) {
      throw new Error(`observation strategy already registered: ${spec.id}`);
    }
    this.strategies.set(spec.id, { spec, mode: spec.scriptRef ? "async" : "active" });
  }

  get(id: string): ObservationStrategyRegistration | undefined {
    return this.strategies.get(id);
  }

  has(id: string): boolean {
    return this.strategies.has(id);
  }

  list(): readonly ObservationStrategyRegistration[] {
    return [...this.strategies.values()];
  }

  listHotPathSafe(): readonly ObservationStrategyRegistration[] {
    return this.list().filter((r) => r.mode === "active");
  }

  /** 仅允许 active 策略在热路径求值；async 策略抛错，由调用方转异步队列。 */
  evaluate(id: string, samples: readonly unknown[], opts: { now?: number } = {}): ActivityFactor {
    const reg = this.strategies.get(id);
    if (!reg) throw new Error(`unknown observation strategy: ${id}`);
    if (reg.mode !== "active") {
      throw new Error(`observation strategy ${id} is async and cannot be evaluated in hot path`);
    }
    return evaluateObservationStrategy(reg.spec, samples, opts);
  }
}
