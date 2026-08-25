/**
 * execution/rebalance-planner.ts —— N28 M5：重平衡规划（纯函数）。
 *
 * 只产出建议 moves，不直接执行；执行由 drain → reassign → verify 流程接管。
 */

export interface RebalanceRegion {
  id: string;
  weight: number;
}

export interface RebalanceMove {
  fromRegionId: string;
  toRegionId: string;
  entryId: string;
}

export function planRebalance(
  regions: RebalanceRegion[],
  membersByRegion: Record<string, string[]>,
  maxWeight: number,
): RebalanceMove[] {
  const moves: RebalanceMove[] = [];
  const overweight = regions.filter((r) => r.weight > maxWeight);
  for (const from of overweight) {
    const members = membersByRegion[from.id] ?? [];
    const excess = Math.min(members.length, from.weight - maxWeight);
    for (let i = 0; i < excess; i++) {
      const candidate = regions
        .filter((r) => r.id !== from.id)
        .sort((a, b) => a.weight - b.weight)[0];
      if (!candidate) break;
      moves.push({ fromRegionId: from.id, toRegionId: candidate.id, entryId: members[i]! });
    }
  }
  return moves;
}
