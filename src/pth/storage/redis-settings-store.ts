import type { Redis } from "ioredis";
import type { SettingsStore } from "../kernel/storage/session/interfaces.js";
import type { Settings } from "../kernel/storage/session/types.js";

export class RedisSettingsStore implements SettingsStore {
  constructor(private redis: Redis) {}

  private key(tenant: string, project?: string): string {
    return project ? `settings:${tenant}:${project}` : `settings:${tenant}`;
  }

  async get(tenant: string, project?: string): Promise<Settings> {
    const raw = await this.redis.get(this.key(tenant, project));
    return raw ? (JSON.parse(raw) as Settings) : {};
  }

  async set(tenant: string, settings: Partial<Settings>, project?: string): Promise<void> {
    const current = await this.get(tenant, project);
    const merged = { ...current, ...settings };
    await this.redis.set(this.key(tenant, project), JSON.stringify(merged));
  }
}
