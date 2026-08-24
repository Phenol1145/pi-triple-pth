/**
 * execution/weight-calibration.ts —— N28 M4：责任权重标定（纯函数）。
 *
 * 基于命中率给出建议权重；只产出建议，不自动改。
 */

export interface WeightObservation {
  regionId: string;
  hits: number;
  misses: number;
}

export interface WeightSuggestion {
  regionId: string;
  suggestedWeight: number;
  hitRate: number;
}

export function calibrateWeight(obs: WeightObservation): WeightSuggestion {
  const total = obs.hits + obs.misses;
  const hitRate = total > 0 ? obs.hits / total : 0;
  const suggestedWeight = total > 0 ? Math.round(hitRate * 100) : 0;
  return { regionId: obs.regionId, suggestedWeight, hitRate };
}
