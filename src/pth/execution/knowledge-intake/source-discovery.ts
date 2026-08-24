/**
 * execution/knowledge-intake/source-discovery.ts —— N26 来源发现外环（v1 骨架）。
 *
 * 提供来源注册表与候选发现入口；生产化时接真实爬取/索引发现。
 */

export type SourceTrust = "seed" | "candidate" | "trusted";

export interface KnowledgeSource {
  id: string;
  url: string;
  kind: string;
  trust: SourceTrust;
  enabled: boolean;
}

export class SourceDiscovery {
  private readonly sources = new Map<string, KnowledgeSource>();

  register(source: KnowledgeSource): void {
    this.sources.set(source.id, source);
  }

  list(): KnowledgeSource[] {
    return [...this.sources.values()];
  }

  discoverCandidates(seedUrls: string[]): KnowledgeSource[] {
    const now = Date.now();
    return seedUrls.map((url, i) => ({
      id: `candidate-${now}-${i}`,
      url,
      kind: "web",
      trust: "candidate",
      enabled: true,
    }));
  }
}
