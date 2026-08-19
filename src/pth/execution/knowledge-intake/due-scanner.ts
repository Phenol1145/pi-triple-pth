/**
 * knowledge-intake/due-scanner.ts — N29 Task 6：PG due subscription scanner。
 *
 * 唯一职责（plan §2 Global Constraints / §5 Task 6 Step 4）：
 *  - Trigger 只唤醒本 scanner；`Subscription.nextCrawlAt` 是唯一调度真相；
 *  - scanner **只**调用 `repository.createDueRuns(now, limit)`（L3 的单事务实现：
 *    `FOR UPDATE SKIP LOCKED` 选 due subscription → 建 run → 推进 next_crawl_at →
 *    同事务 enqueue `intake.fetch`），自己不写任何表、不发布任何 Task；
 *  - 建完 run 即返回；真正的阶段推进由生产 drainer 消费 outbox 完成。
 *
 * 幂等（plan §2.4 G2「两个 scanner 对同一 due window 只建一个 Run」）：
 *  1. 第一道防线是 `FOR UPDATE SKIP LOCKED`——并发 scanner 看不到同一 subscription；
 *  2. 第二道防线是部分唯一索引 `uq_knowledge_intake_runs_open_subscription`
 *     （同 subscription 同时只允许一个未终结 run）；
 *  3. 本 scanner 把第二道防线的唯一键冲突（以及并发导致的序列化失败）
 *     **优雅吸收**为「本轮没有建出新 run」——整个 due-scan 事务已回滚，
 *     既不留 run 也不留 outbox，另一个 scanner 的那一条仍然有效。
 *
 * 进程重启后的恢复不依赖内存态：PG 里的 `nextCrawlAt`、过期 run lease 与
 * pending/expired outbox 行本身就是恢复点。
 */

import type { DueScanOptions, IntakeRun, KnowledgeIntakeRepository } from "../../contracts/index.js";

/** due scan 默认批量（一次唤醒最多建多少个 run）。 */
export const DUE_SCAN_DEFAULT_LIMIT = 25;

/**
 * 可优雅吸收的并发 SQLSTATE：
 *  - 23505 unique_violation：唯一开放 run 索引挡住了重复 run（对手 scanner 已建）；
 *  - 40001 serialization_failure / 40P01 deadlock_detected：并发 due-scan 事务冲突。
 * 其余错误一律上抛（配置/schema/连接问题不得被当成"没有 due"静默吞掉）。
 */
const BENIGN_CONCURRENCY_SQLSTATES = new Set(["23505", "40001", "40P01"]);

function sqlStateOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

export interface KnowledgeIntakeDueScannerDeps {
  /** 只需要 due 扫描这一个写路径（scanner 不得触达其他仓库方法）。 */
  readonly repository: Pick<KnowledgeIntakeRepository, "createDueRuns">;
  /** 单次唤醒的建 run 上限（缺省 25）。 */
  readonly limit?: number;
  /** 注入时钟（缺省系统时钟）。 */
  readonly clock?: () => Date;
  /** 只扫单一 tenant（缺省 = 系统级跨 tenant 扫描）。 */
  readonly tenantId?: string;
  /** 下一阶段 outbox kind 覆盖（缺省仓库默认 `intake.fetch`）。 */
  readonly outboxKind?: string;
  readonly logger?: (message: string) => void;
}

export interface KnowledgeIntakeDueScanner {
  /**
   * 唤醒一次：返回本轮新建的 run（可能为空）。
   * 并发冲突被吸收为空结果；其它错误上抛给调用方（batch drainer / trigger）。
   */
  scanOnce(now?: Date): Promise<readonly IntakeRun[]>;
  /** 本 scanner 生效的 due scan 选项（便于装配层自检）。 */
  readonly options: Readonly<Required<Pick<KnowledgeIntakeDueScannerDeps, "limit">> & DueScanOptions>;
}

export function createKnowledgeIntakeDueScanner(
  deps: KnowledgeIntakeDueScannerDeps,
): KnowledgeIntakeDueScanner {
  const limit = deps.limit ?? DUE_SCAN_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error(`due scanner limit must be a positive safe integer (got ${String(deps.limit)})`);
  }
  const clock = deps.clock ?? (() => new Date());
  const scanOptions: DueScanOptions = {
    ...(deps.tenantId === undefined ? {} : { tenantId: deps.tenantId }),
    ...(deps.outboxKind === undefined ? {} : { outboxKind: deps.outboxKind }),
  };

  return {
    options: Object.freeze({ limit, ...scanOptions }),
    async scanOnce(now?: Date): Promise<readonly IntakeRun[]> {
      const at = now ?? clock();
      try {
        return await deps.repository.createDueRuns(at, limit, scanOptions);
      } catch (error) {
        const state = sqlStateOf(error);
        if (state !== undefined && BENIGN_CONCURRENCY_SQLSTATES.has(state)) {
          // 事务已整体回滚：没有 run、没有 outbox；另一个 scanner 的那一条仍然有效。
          deps.logger?.(
            `intake due scanner: concurrent due scan collapsed (sqlstate ${state})——`
            + `open-run uniqueness held, no duplicate run created`,
          );
          return [];
        }
        throw error;
      }
    },
  };
}
