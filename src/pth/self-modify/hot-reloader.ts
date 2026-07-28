import { watch, type FSWatcher } from "chokidar";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../../shared/observability/logger.js";
import type { Metrics } from "../observability/metrics.js";

export interface ReloadResult {
  loaded: string[];
  errors: Array<{ file: string; error: string }>;
}

export class HotReloader {
  private watcher: FSWatcher | null = null;
  private lastGoodHashes = new Map<string, string>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private platformDir: string,
    private logger: Logger,
    private metrics: Metrics,
    private onReload: (result: ReloadResult) => void,
  ) {}

  start(): void {
    const watchPaths = [
      path.join(this.platformDir, "skills"),
      path.join(this.platformDir, "prompts"),
      path.join(this.platformDir, "config"),
    ];

    this.watcher = watch(watchPaths, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    });

    this.watcher.on("change", (filePath: string) => this.handleChange(filePath));
    this.watcher.on("add", (filePath: string) => this.handleChange(filePath));

    this.heartbeatTimer = setInterval(() => {
      this.logger.debug({ event: "watcher_heartbeat" });
    }, 60_000);

    this.logger.info({ paths: watchPaths, event: "hot_reloader_started" });
  }

  stop(): void {
    this.watcher?.close();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
  }

  private async handleChange(filePath: string): Promise<void> {
    this.logger.info({ file: filePath, event: "file_changed" });
    const result: ReloadResult = { loaded: [], errors: [] };

    try {
      const content = await fs.readFile(filePath, "utf-8");
      const hash = createHash("sha256").update(content).digest("hex");

      if (filePath.endsWith("SKILL.md")) {
        if (!content.includes("# ")) throw new Error("SKILL.md must contain a heading");
      }

      if (filePath.endsWith("settings.json")) {
        JSON.parse(content);
      }

      this.lastGoodHashes.set(filePath, hash);
      result.loaded.push(filePath);
      this.metrics.selfModifyTotal.inc({ layer: "1" });
    } catch (err) {
      result.errors.push({ file: filePath, error: String(err) });
      this.logger.error({ file: filePath, error: String(err), event: "reload_error" });
    }

    this.onReload(result);
  }
}
