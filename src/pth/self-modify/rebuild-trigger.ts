import fs from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../../shared/observability/logger.js";
import type { AuditWriter } from "../observability/audit.js";

export class RebuildTrigger {
  private lastTrigger = 0;
  private readonly COOLDOWN_MS = 600_000;

  constructor(
    private platformDir: string,
    private logger: Logger,
    private audit: AuditWriter,
  ) {}

  async requestRebuild(tenantId: string, commitHash: string): Promise<{ ok: boolean; reason?: string }> {
    const now = Date.now();
    if (now - this.lastTrigger < this.COOLDOWN_MS) {
      const remaining = Math.ceil((this.COOLDOWN_MS - (now - this.lastTrigger)) / 60_000);
      return { ok: false, reason: `Cooldown active, ${remaining}min remaining` };
    }

    const intentPath = path.join(this.platformDir, ".rebuild-request");
    await fs.writeFile(intentPath, JSON.stringify({
      requestedAt: new Date().toISOString(),
      commitHash,
      requestedBy: tenantId,
    }));

    this.lastTrigger = now;
    this.logger.info({ commitHash, tenantId, event: "rebuild_requested" });
    await this.audit.querySelfModify(tenantId, "3", ["src/"], commitHash);

    return { ok: true };
  }
}
