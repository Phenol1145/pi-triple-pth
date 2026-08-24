/**
 * execution/knowledge-intake/auto-expansion.ts —— N26 自动扩源（v1 纯函数）。
 *
 * 根据候选来源成功摄入次数决定是否晋升 trusted；并提供种子+发现并集。
 */

export function shouldPromoteToTrusted(successes: number, threshold = 3): boolean {
  return successes >= threshold;
}

export function expandCandidates(seedUrls: string[], discoveredUrls: string[]): string[] {
  return [...new Set([...seedUrls, ...discoveredUrls])];
}
