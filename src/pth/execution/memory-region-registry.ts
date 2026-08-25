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

export interface RegionRepository {
  save(region: MemoryRegion): void;
  get(regionId: string): MemoryRegion | undefined;
  list(tenantId?: string): MemoryRegion[];
  delete(regionId: string): boolean;
}

export interface RegionMemberRepository {
  add(regionId: string, entryId: string): boolean;
  list(regionId: string): string[];
  remove(regionId: string, entryId: string): boolean;
}

export class InMemoryRegionRepository implements RegionRepository {
  private readonly regions = new Map<string, MemoryRegion>();
  save(region: MemoryRegion): void { this.regions.set(region.id, region); }
  get(regionId: string): MemoryRegion | undefined { return this.regions.get(regionId); }
  list(tenantId?: string): MemoryRegion[] {
    const all = [...this.regions.values()];
    return tenantId ? all.filter((r) => r.tenantId === tenantId) : all;
  }
  delete(regionId: string): boolean { return this.regions.delete(regionId); }
}

export class InMemoryRegionMemberRepository implements RegionMemberRepository {
  private readonly members = new Map<string, Set<string>>();
  add(regionId: string, entryId: string): boolean {
    if (!this.members.has(regionId)) this.members.set(regionId, new Set());
    this.members.get(regionId)!.add(entryId);
    return true;
  }
  list(regionId: string): string[] { return [...(this.members.get(regionId) ?? [])]; }
  remove(regionId: string, entryId: string): boolean { return this.members.get(regionId)?.delete(entryId) ?? false; }
}

export class MemoryRegionRegistry {
  private readonly memoryRegion = new InMemoryRegionRepository();
  private readonly memoryMember = new InMemoryRegionMemberRepository();
  private readonly regions: RegionRepository;
  private readonly members: RegionMemberRepository;

  constructor(deps?: { regions?: RegionRepository; members?: RegionMemberRepository }) {
    this.regions = deps?.regions ?? this.memoryRegion;
    this.members = deps?.members ?? this.memoryMember;
  }

  register(region: MemoryRegion): void {
    this.regions.save(region);
  }

  list(tenantId?: string): MemoryRegion[] {
    return this.regions.list(tenantId);
  }

  addMember(regionId: string, entryId: string): boolean {
    if (!this.regions.get(regionId)) return false;
    return this.members.add(regionId, entryId);
  }

  membersOf(regionId: string): string[] {
    return this.members.list(regionId);
  }

  removeMember(regionId: string, entryId: string): boolean {
    return this.members.remove(regionId, entryId);
  }
}
