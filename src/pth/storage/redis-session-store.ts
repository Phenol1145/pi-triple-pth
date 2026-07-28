import type { Redis } from "ioredis";
import type { SessionStore } from "./interfaces.js";
import type { SessionMeta, SessionEntry, Snapshot, VersionSnapshotRecord } from "./types.js";

export class RedisSessionStore implements SessionStore {
  constructor(private redis: Redis) {}

  private metaKey(tenant: string, sessionId: string): string {
    return `session:${tenant}:${sessionId}:meta`;
  }

  private entryKey(tenant: string, sessionId: string, seq: number): string {
    return `session:${tenant}:${sessionId}:entry:${seq}`;
  }

  private snapshotKey(tenant: string, sessionId: string, seq: number): string {
    return `session:${tenant}:${sessionId}:snapshot:${seq}`;
  }

  private vsnapshotKey(tenant: string, sessionId: string, seq: number): string {
    return `session:${tenant}:${sessionId}:vsnapshot:${seq}`;
  }

  private indexKey(tenant: string): string {
    return `session-index:${tenant}`;
  }

  async appendEntry(tenant: string, sessionId: string, entry: SessionEntry): Promise<void> {
    const key = this.entryKey(tenant, sessionId, entry.seq);
    await this.redis.set(key, JSON.stringify(entry));
    // Read meta, update, re-SET (avoids WRONGTYPE from mixing string/hash ops)
    const raw = await this.redis.get(this.metaKey(tenant, sessionId));
    if (raw) {
      const meta: SessionMeta = JSON.parse(raw);
      meta.entryCount = (meta.entryCount ?? 0) + 1;
      meta.lastEntrySeq = entry.seq;
      meta.updatedAt = new Date().toISOString();
      await this.redis.set(this.metaKey(tenant, sessionId), JSON.stringify(meta));
    }
  }

  async getEntries(tenant: string, sessionId: string, fromSeq: number = 1): Promise<SessionEntry[]> {
    const meta = await this.getMeta(tenant, sessionId);
    if (!meta) return [];
    const keys: string[] = [];
    for (let seq = fromSeq; seq <= meta.lastEntrySeq; seq++) {
      keys.push(this.entryKey(tenant, sessionId, seq));
    }
    if (keys.length === 0) return [];
    const values = await this.redis.mget(...keys);
    return values
      .filter((v): v is string => v !== null)
      .map((v) => JSON.parse(v) as SessionEntry);
  }

  async getMeta(tenant: string, sessionId: string): Promise<SessionMeta | null> {
    const raw = await this.redis.get(this.metaKey(tenant, sessionId));
    if (!raw) return null;
    return JSON.parse(raw) as SessionMeta;
  }

  async saveMeta(tenant: string, sessionId: string, meta: SessionMeta): Promise<void> {
    await this.redis.set(this.metaKey(tenant, sessionId), JSON.stringify(meta));
    await this.redis.zadd(this.indexKey(tenant), Date.now(), JSON.stringify({ sessionId, project: meta.project }));
  }

  async saveSnapshot(tenant: string, sessionId: string, snapshot: Snapshot): Promise<void> {
    await this.redis.set(this.snapshotKey(tenant, sessionId, snapshot.seq), JSON.stringify(snapshot));
  }

  async getLatestSnapshot(tenant: string, sessionId: string): Promise<Snapshot | null> {
    const meta = await this.getMeta(tenant, sessionId);
    if (!meta) return null;
    for (let seq = meta.lastEntrySeq; seq >= 0; seq--) {
      const raw = await this.redis.get(this.snapshotKey(tenant, sessionId, seq));
      if (raw) return JSON.parse(raw) as Snapshot;
    }
    return null;
  }

  async listSessions(tenant: string, project?: string): Promise<SessionMeta[]> {
    const members = await this.redis.zrange(this.indexKey(tenant), 0, -1);
    const results: SessionMeta[] = [];
    for (const member of members) {
      const { sessionId, project: proj } = JSON.parse(member);
      if (project && proj !== project) continue;
      const meta = await this.getMeta(tenant, sessionId);
      if (meta) results.push(meta);
    }
    return results;
  }

  async saveVersionSnapshot(tenant: string, sessionId: string, record: VersionSnapshotRecord): Promise<void> {
    await this.redis.set(this.vsnapshotKey(tenant, sessionId, record.seq), JSON.stringify(record));
  }

  async getLatestVersionSnapshot(tenant: string, sessionId: string): Promise<VersionSnapshotRecord | null> {
    const meta = await this.getMeta(tenant, sessionId);
    if (!meta) return null;
    for (let seq = meta.lastEntrySeq; seq >= 0; seq--) {
      const raw = await this.redis.get(this.vsnapshotKey(tenant, sessionId, seq));
      if (raw) return JSON.parse(raw) as VersionSnapshotRecord;
    }
    return null;
  }

  async deleteSession(tenant: string, sessionId: string): Promise<void> {
    const meta = await this.getMeta(tenant, sessionId);
    if (!meta) return;
    const keys: string[] = [this.metaKey(tenant, sessionId)];
    for (let seq = 1; seq <= meta.lastEntrySeq; seq++) {
      keys.push(this.entryKey(tenant, sessionId, seq));
    }
    await this.redis.del(...keys);
    await this.redis.zrem(this.indexKey(tenant), JSON.stringify({ sessionId, project: meta.project }));
  }
}
