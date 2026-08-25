/**
 * bootstrap/batch/intake.ts —— P2-9 装配段：N29 Task 6 Knowledge Intake 内环装配。
 *
 * `PTH_KNOWLEDGE_INTAKE_MODE=off`（默认）时完全不装配：零 handler、零 scanner、零 LLM 客户端，
 * 生产 drainer 的 handler 集合逐字节保持 N28 形状。draft/full 才装配，且任一前置缺失即
 * **启动期 fail closed**（宁可起不来，不要半个不可信内环在跑）。
 *
 * 首轮（M0）连接器与申报属性固定为一个 bounded HTTPS/HTML source
 * （plan §2 Global Constraints：一个 tenant / space / domain / subscription）。
 */

import { readFile } from "node:fs/promises";
import { pthConfig } from "@away_from/pth-config";
import { createLlmFn } from "@away_from/pth-kernel-interpreter";
import { createKnowledgeIntakeRepository } from "@away_from/pth-kernel-storage";
import type { SideEffectDrainerHandlers } from "@away_from/pth-kernel-storage";
import type { TrustPolicyManifest } from "@away_from/pth-contracts";
import {
  createAdversarialReviewProcessor,
  createDomainReviewProcessor,
  createIntakeExtractProcessor,
} from "../../runner/index.js";
import {
  createKnowledgeIngestor,
  createKnowledgeIntakeDueScanner,
  createKnowledgeIntakeService,
  createPolicyBoundSourceFetchBroker,
  INTAKE_STAGE_OUTBOX_KINDS,
  loadVerifiedTrustPolicy,
  type KnowledgeIntakeDueScanner,
  type TrustPolicyKeyring,
} from "../../execution/index.js";
import {
  assertIntakeFullAcceptance,
  selectIntakeStageHandlers,
  type IntakeAcceptanceEnvelopeLike,
  type IntakeMode,
} from "../intake-mode-gates.js";
import type { BatchDataWorld, BatchLogger, BatchPool } from "./context.js";

export interface KnowledgeIntakeAssembly {
  /** 生产 drainer 注册的 intake 阶段 handler（mode=off 时为空对象——drainer handler 集合不变）。 */
  stageHandlers: SideEffectDrainerHandlers;
  /** due scanner（mode=off 时 undefined——trigger 收到消息也只回 ran:false）。 */
  dueScanner: KnowledgeIntakeDueScanner | undefined;
}

export async function assembleKnowledgeIntake(input: {
  pool: BatchPool;
  dataWorld: BatchDataWorld;
  modelRouter: any;
  batchLogger: BatchLogger;
}): Promise<KnowledgeIntakeAssembly> {
  const { pool, dataWorld, modelRouter, batchLogger } = input;
  const intakeMode = pthConfig().str("PTH_KNOWLEDGE_INTAKE_MODE").trim().toLowerCase();
  const stageHandlers: SideEffectDrainerHandlers = {};
  let dueScanner: KnowledgeIntakeDueScanner | undefined;
  if (intakeMode === "draft" || intakeMode === "full") {
    const manifestPath = pthConfig().str("PTH_TRUST_POLICY_MANIFEST");
    const keyringPath = pthConfig().str("PTH_TRUST_POLICY_KEYRING");
    if (!manifestPath || !keyringPath) {
      throw new Error(
        `PTH_KNOWLEDGE_INTAKE_MODE=${intakeMode} 需要 PTH_TRUST_POLICY_MANIFEST 与 PTH_TRUST_POLICY_KEYRING`
        + "（人类签名 Trust Policy 是来源抓取与使用授权的唯一事实源）",
      );
    }
    // P0-9 修复：full 模式必须出示绑定当前 commit 的 MIN_INNER_LOOP_GO 验收 attestation；
    // 缺失/不绑定/非 GO 一律启动期 fail closed，不靠运维约定。
    if (intakeMode === "full") {
      const acceptancePath = pthConfig().str("PTH_KNOWLEDGE_INTAKE_ACCEPTANCE_PATH");
      const acceptancePublicKeyPath = pthConfig().str("PTH_KNOWLEDGE_INTAKE_ACCEPTANCE_PUBLIC_KEY_PATH");
      if (!acceptancePath) {
        throw new Error(
          "PTH_KNOWLEDGE_INTAKE_MODE=full 需要 PTH_KNOWLEDGE_INTAKE_ACCEPTANCE_PATH"
          + "（指向 decision=MIN_INNER_LOOP_GO 的验收 envelope；否则 full 不得启动）",
        );
      }
      if (!acceptancePublicKeyPath) {
        throw new Error(
          "PTH_KNOWLEDGE_INTAKE_MODE=full 需要 PTH_KNOWLEDGE_INTAKE_ACCEPTANCE_PUBLIC_KEY_PATH"
          + "（D-5：验收 envelope 必须由 CI/发布密钥签名并在启动时验签；否则 full 不得启动）",
        );
      }
      const envelope = JSON.parse(await readFile(acceptancePath, "utf8")) as IntakeAcceptanceEnvelopeLike;
      const acceptancePublicKeyPem = await readFile(acceptancePublicKeyPath, "utf8");
      assertIntakeFullAcceptance(
        envelope,
        (process.env["PTH_BUILD_COMMIT"] ?? "").trim() || undefined,
        { publicKeyPem: acceptancePublicKeyPem, requireSignature: true },
      );
    }
    // 已验签 policy 在进程启动时加载一次；轮换需重启 batch（manifest 是不可变签名事实）。
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as TrustPolicyManifest;
    const keyring = JSON.parse(await readFile(keyringPath, "utf8")) as TrustPolicyKeyring;
    const verifiedPolicy = await loadVerifiedTrustPolicy(manifest, keyring);

    const intakeRepository = createKnowledgeIntakeRepository(pool, {
      // P0-3 approach A：未带运行时 attestation 的 policy 输入由仓库用只读 keyring 自行重新验签。
      policyVerifier: (candidate) => loadVerifiedTrustPolicy(candidate, keyring),
    });
    const intakeStore = dataWorld.memory as unknown as Parameters<typeof createKnowledgeIngestor>[0]["store"];
    const intakeLlm = createLlmFn({
      modelRouter,
      onMetric: (m) => {
        try { process.send?.({ kind: "metric", metric: { ...m, kind: "llm", domain: "intake" } }); } catch { /* IPC 不可用 */ }
      },
    });
    const declaredSource = { sourceType: "bounded-html", contentType: "text/html", license: "public-domain" } as const;
    const intakeService = createKnowledgeIntakeService({
      pool,
      repository: intakeRepository,
      store: dataWorld.memory as never,
      policy: verifiedPolicy,
      broker: createPolicyBoundSourceFetchBroker({ policy: verifiedPolicy, declaredSource }),
      ingestor: createKnowledgeIngestor({ pool, store: intakeStore, intake: intakeRepository }),
      extractor: createIntakeExtractProcessor({ llm: intakeLlm }),
      domainReview: createDomainReviewProcessor({ llm: intakeLlm }),
      adversarialReview: createAdversarialReviewProcessor({ llm: intakeLlm }),
      // 四个职责分离的 principal（producer/domain/adversarial/promoter 必须互不相同）。
      principals: {
        producer: "intake:extractor",
        domainReviewer: "intake:domain-reviewer",
        adversarialReviewer: "intake:adversarial-reviewer",
        promoter: "intake:promoter",
      },
      declared: declaredSource,
    });
    // 生产 drainer 注册的阶段 handler：intake.fetch / extract / review-domain /
    // review-adversarial / promote —— 每个 handler 只处理一个 stage 并用 run CAS 提交下一步。
    // P0-9 修复：draft 只到 private draft + open plan——剔除 promote handler
    // （draft 模式下 intake.promote outbox 行没有消费者 → 若被误排会 dead-letter 而非晋升）。
    Object.assign(
      stageHandlers,
      selectIntakeStageHandlers(
        intakeMode as IntakeMode,
        intakeService.stageHandlers(),
        INTAKE_STAGE_OUTBOX_KINDS.promote,
      ),
    );
    // 变化重爬/撤销的依赖刷新 fan-out：**权威撤出已在 PG 事务内完成**（依赖边 stale +
    // 旧 official → stale），本 outbox 行只是通知。L7 组合真正的下游刷新消费者之前，
    // 这里注册一个结构化日志 sink：既不让行进 dead-letter 制造噪声，也不静默丢弃事实。
    stageHandlers[INTAKE_STAGE_OUTBOX_KINDS.dependencyRefresh] = async (payload) => {
      const p = (payload ?? {}) as Record<string, unknown>;
      const ids = Array.isArray(p.staleDependentIds) ? (p.staleDependentIds as unknown[]) : [];
      batchLogger.info(
        `[intake] dependency refresh：subscription=${String(p.subscriptionId)} reason=${String(p.reason)}`
        + ` staleDependents=${ids.length}（${ids.slice(0, 8).join(",")}）`
        + "——L7 将以真实刷新消费者替换本 sink",
      );
    };
    dueScanner = createKnowledgeIntakeDueScanner({
      repository: intakeRepository,
      logger: (m) => batchLogger.warn(m),
    });
    batchLogger.info(
      `[intake] mode=${intakeMode} 已注册阶段 handler：${Object.keys(stageHandlers).sort().join(", ")}`
      + `；policy=${verifiedPolicy.manifest.policyId}@${verifiedPolicy.manifest.version}`,
    );
  }
  return { stageHandlers, dueScanner };
}
