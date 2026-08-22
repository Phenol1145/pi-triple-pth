import { watch, type FSWatcher } from "chokidar";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Logger } from "@away_from/infra";
import type { Metrics } from "../observability/index.js";

export interface ReloadResult {
  loaded: string[];
  errors: Array<{ file: string; error: string }>;
}

export interface ResourceOverlaySnapshot {
  /** 已校验通过的 platform 卷 skills 文件（注入 additionalSkillPaths——agent-dir 基准上的覆盖层） */
  skills: string[];
  /** 已校验通过的 platform 卷 prompts 文件（注入 additionalPromptTemplatePaths） */
  prompts: string[];
}

export type ResourceCategory = "skills" | "prompts" | "config";

/**
 * L1 热更注入状态（F/WP2 Task 8）：platform 卷变更校验通过后才进入覆盖层，
 * 后续会话的 ResourceLoader 以 agent-dir 卷为基准、platform 卷为覆盖层。
 * 校验失败的变更被剔除——错误内容不进后续会话。
 */
export class ResourceOverlay {
  private validatedSkills = new Set<string>();
  private validatedPrompts = new Set<string>();

  markValidated(category: ResourceCategory, filePath: string): void {
    if (category === "skills") this.validatedSkills.add(filePath);
    else if (category === "prompts") this.validatedPrompts.add(filePath);
    // config：仅校验+记录，无 ResourceLoader 注入面（DefaultResourceLoader 无 config 覆盖层选项）
  }

  invalidate(category: ResourceCategory, filePath: string): void {
    if (category === "skills") this.validatedSkills.delete(filePath);
    else if (category === "prompts") this.validatedPrompts.delete(filePath);
  }

  getOverlayPaths(): ResourceOverlaySnapshot {
    return { skills: [...this.validatedSkills], prompts: [...this.validatedPrompts] };
  }
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
    private overlay?: ResourceOverlay,
  ) {}

  /** L1 注入源（F/WP2 Task 8）：返回当前已验证的 platform 卷覆盖层路径。 */
  getOverlayPaths(): ResourceOverlaySnapshot {
    return this.overlay?.getOverlayPaths() ?? { skills: [], prompts: [] };
  }

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

    // 注入边界（评审 WP2-R2 Important#2）：ignoreInitial:true → 启动时平台卷已存在的
    // skills/prompts 不产生 add 事件、不进入覆盖层；只有运行期发生的变更（写/改/删）才被注入。
    // 部署文件后须触发一次变更事件（或经 agent-dir 卷）才对新会话生效——勿误以为启动即全量注入。

    this.watcher.on("change", (filePath: string) => this.reloadFile(filePath));
    this.watcher.on("add", (filePath: string) => this.reloadFile(filePath));
    this.watcher.on("unlink", (filePath: string) => this.handleUnlink(filePath));

    this.heartbeatTimer = setInterval(() => {
      this.logger.debug({ event: "watcher_heartbeat" });
    }, 60_000);

    this.logger.info({ paths: watchPaths, event: "hot_reloader_started" });
  }

  stop(): void {
    this.watcher?.close();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
  }

  /**
   * 单个 platform 卷文件变更（F/WP2 Task 8）：校验通过 → 注入覆盖层（后续会话
   * ResourceLoader 生效）；校验失败 → 从覆盖层剔除（错误内容不进后续会话）。
   */
  async reloadFile(filePath: string): Promise<void> {
    this.logger.info({ file: filePath, event: "file_changed" });
    const result: ReloadResult = { loaded: [], errors: [] };
    const category = this.categoryOf(filePath);

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

      if (category === "skills" || category === "prompts") {
        this.overlay?.markValidated(category, filePath);
      }
    } catch (err) {
      result.errors.push({ file: filePath, error: String(err) });
      this.logger.error({ file: filePath, error: String(err), event: "reload_error" });
      if (category === "skills" || category === "prompts") {
        this.overlay?.invalidate(category, filePath);
      }
    }

    this.onReload(result);
  }

  /** 文件删除：从覆盖层与 last-good 记录剔除（防止残留引用注入后续会话）。 */
  private handleUnlink(filePath: string): void {
    this.logger.info({ file: filePath, event: "file_unlinked" });
    this.lastGoodHashes.delete(filePath);
    const category = this.categoryOf(filePath);
    if (category === "skills" || category === "prompts") {
      this.overlay?.invalidate(category, filePath);
    }
  }

  private categoryOf(filePath: string): ResourceCategory | null {
    for (const dir of ["skills", "prompts", "config"] as const) {
      if (filePath.startsWith(path.join(this.platformDir, dir) + path.sep)) return dir;
    }
    return null;
  }
}
