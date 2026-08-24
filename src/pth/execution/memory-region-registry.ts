/**
 * execution/memory-region-registry.ts —— N28 生产化 M2：MemoryRegion 责任区骨架（内存实现）。
 *
 * Region 只存引用/成员，不复制正文；责任区不扩大权限。
 */

export interface MemoryRegion {
  id: string;
  tenantId: string;
  selector: Record<string, unknown>;
  ownerRoleId: string;
  weight: number;
}

export class MemoryRegionRegistry {
  private readonly regions = new Map<string, MemoryRegion>();
  private readonly members = new Map<string, Set<string>>();

  register(region: MemoryRegion): void {
    this.regions.set(region.id, region);
    if (!this.members.has(region.id)) this.members.set(region.id, new Set());
  }

  list(tenantId?: string): MemoryRegion[] {
    const all = [...this.regions.values()];
    return tenantId ? all.filter((r) => r.tenantId === tenantId) : all;
  }

  addMember(regionId: string, entryId: string): boolean {
    const region = this.regions.get(regionId);
    if (!region) return false;
    const set = this.members.get(regionId)!;
    set.add(entryId);
    return true;
  }

  membersOf(regionId: string): string[] {
    return [...(this.members.get(regionId) ?? [])];
  }

  removeMember(regionId: string, entryId: string): boolean {
    return this.members.get(regionId)?.delete(entryId) ?? false;
  }
}
