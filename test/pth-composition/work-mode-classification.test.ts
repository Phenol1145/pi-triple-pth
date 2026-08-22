import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import { createPgPool } from "@away_from/pth-kernel-storage";
import { applySchema } from "@away_from/pth-kernel-storage";
import { PgTaskStore } from "@away_from/pth-kernel-storage";
import { TaskControlService } from "../../src/pth/tasking/task-control-service.js";
import { PgTaskQueries } from "../../src/pth/tasking/task-queries.js";
import { createPgTaskRepository } from "../../src/pth/tasking/adapters/pg-task-repository.js";
import { checkTaskRouting, routeTaskRole } from "@away_from/pth-kernel-execution";
import { resolveTemplateTask } from "@away_from/pth-kernel-interpreter";
import { installDefaultRoles } from "../helpers.js";
import {
  createCrossModeWork,
  type CrossModeWorkPublisher,
  type CrossModeWorkRequest,
  type TenantScope,
  type WorkMode,
} from "@away_from/pth-contracts";

// ── 纯权威矩阵：跨模式必须新 workId + 完整 causation + 四条固定 handoff ──────────

function okPublisher(newWorkId = "work-intake-1"): CrossModeWorkPublisher {
  return {
    async publish(input) {
      return { workId: newWorkId, received: input };
    },
  } as CrossModeWorkPublisher;
}

function request(over: Partial<CrossModeWorkRequest> = {}): CrossModeWorkRequest {
  return {
    fromWorkId: "task-run-1",
    fromMode: "run",
    toMode: "intake",
    objective: "collect missing source",
    authorityPolicyRef: "authority:intake-v1",
    budgetPolicyRef: "budget:intake-v1",
    causationId: "turn-9",
    ...over,
  };
}

describe("work-mode classification: 跨模式权威矩阵（纯）", () => {
  it("四条固定 handoff 全部允许，且发布载荷带 parentWorkId + causationId", async () => {
    const cases: Array<[WorkMode, WorkMode]> = [
      ["run", "intake"],
      ["run", "optimize"],
      ["intake", "optimize"],
      ["optimize", "intake"],
    ];
    for (const [fromMode, toMode] of cases) {
      let received: Record<string, unknown> | undefined;
      const publisher: CrossModeWorkPublisher = {
        async publish(input) {
          received = input as unknown as Record<string, unknown>;
          return { workId: `new-${fromMode}-${toMode}` };
        },
      };
      const result = await createCrossModeWork(
        request({ fromWorkId: `work-${fromMode}-1`, fromMode, toMode }),
        publisher,
      );
      expect(result.workId).toBe(`new-${fromMode}-${toMode}`);
      expect(result.workId).not.toBe(`work-${fromMode}-1`);
      expect(result.workMode).toBe(toMode);
      expect(result.parentWorkId).toBe(`work-${fromMode}-1`);
      expect(result.causationId).toBe("turn-9");
      expect(received).toMatchObject({
        workMode: toMode,
        parentWorkId: `work-${fromMode}-1`,
        causationId: "turn-9",
        authorityPolicyRef: "authority:intake-v1",
        budgetPolicyRef: "budget:intake-v1",
      });
    }
  });

  it("同 mode 重入与未授权 handoff（intake→run / optimize→run）一律拒绝", async () => {
    let published = 0;
    const publisher: CrossModeWorkPublisher = {
      async publish() {
        published++;
        return { workId: "should-not-publish" };
      },
    };
    await expect(createCrossModeWork(request({ toMode: "run" }), publisher)).rejects.toThrow(/new work mode/i);
    await expect(
      createCrossModeWork(request({ fromMode: "intake", toMode: "run" }), publisher),
    ).rejects.toThrow(/handoff intake->run is not allowed/i);
    await expect(
      createCrossModeWork(request({ fromMode: "optimize", toMode: "run" }), publisher),
    ).rejects.toThrow(/handoff optimize->run is not allowed/i);
    expect(published).toBe(0);
  });

  it("publisher 返回原 workId → 拒绝（跨模式必须产生新 workId）", async () => {
    await expect(
      createCrossModeWork(request(), okPublisher("task-run-1")),
    ).rejects.toThrow(/new work id/i);
  });

  it("template 分类：普通模板 run；系统/优化模板 memory-sweep 固定 optimize", () => {
    const recon = resolveTemplateTask({ template: "recon-doc", params: { url: "https://example.com/doc" } });
    expect(recon.ok && recon.workMode).toBe("run");
    const sweep = resolveTemplateTask({ template: "memory-sweep" });
    expect(sweep.ok && sweep.workMode).toBe("optimize");
  });
});

// ── 真实 PG 权威矩阵：客户端不能自报 mode；delegate 继承；reader 盖章；Intake 固定 intake ──

async function hasDocker(): Promise<boolean> {
  if (process.env.PTH_TEST_NO_DOCKER === "1") return false;
  try {
    await getContainerRuntimeClient();
    return true;
  } catch {
    return false;
  }
}

const dockerAvailable = await hasDocker();
const pg = dockerAvailable ? describe : describe.skip;

const scopeA: TenantScope = { tenantId: "tenant-a", principalId: "tenant:tenant-a:tenant-agent", roles: ["tenant-agent"], traceId: "trace-a" };

pg("work-mode classification: PG 权威矩阵", () => {
  let container: PostgreSqlContainer;
  let pool: Awaited<ReturnType<typeof createPgPool>>;
  let service: TaskControlService;
  let routedService: TaskControlService;
  let store: PgTaskStore;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = await createPgPool({ connectionString: container.getConnectionUri() });
    await applySchema(pool);
    installDefaultRoles();
    store = new PgTaskStore(pool);
    service = new TaskControlService({ store, pool, queries: new PgTaskQueries(pool) });
    const routedStore = new PgTaskStore(pool, { validate: checkTaskRouting, assign: routeTaskRole });
    routedService = new TaskControlService({ store: routedStore, pool, queries: new PgTaskQueries(pool) });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  it("客户端不能自报 mode：gateway/用户 publish 恒为 run（body optimize/intake 被忽略）", async () => {
    for (const forged of ["intake", "optimize"] as const) {
      const task = await service.publish(
        { title: `forged-${forged}`, text: "x", createdBy: "body", tags: ["code"], workMode: forged },
        scopeA,
      );
      expect(task.workMode).toBe("run");
      const row = await pool.query("SELECT work_mode FROM tasks WHERE id = $1", [task.id]);
      expect(row.rows[0].work_mode).toBe("run");
    }
  });

  it("trusted code-owned publish 可写 intake/optimize；claim reader 盖章 workMode", async () => {
    const trustedStore = new PgTaskStore(pool, { validate: checkTaskRouting, assign: routeTaskRole });
    const intakeTask = await trustedStore.publish({ title: "intake trusted", text: "x", createdBy: "system", tags: ["code"], workMode: "intake", tenantId: "tenant-a" });
    const optimizeTask = await trustedStore.publish({ title: "optimize trusted", text: "x", createdBy: "system", tags: ["code"], workMode: "optimize", tenantId: "tenant-a" });
    expect(intakeTask.workMode).toBe("intake");
    expect(optimizeTask.workMode).toBe("optimize");
    expect(intakeTask.assigned_role).toBe("developer");
    expect(optimizeTask.assigned_role).toBe("developer");

    const repo = createPgTaskRepository(pool);
    const claimed = await repo.claim(
      { tenantId: "tenant-a", principalId: "worker:developer", roles: ["developer"], traceId: "claim-mode" },
      "developer",
      [intakeTask.id, optimizeTask.id],
    );
    expect(claimed.map((c) => c.work.workMode).sort()).toEqual(["intake", "optimize"]);
  });

  it("delegate 继承父 mode：intake 父 → intake 子；optimize 父 → optimize 子", async () => {
    await pool.query(
      `INSERT INTO tasks (id, tenant_id, title, text, created_by, assigned_role, status, work_mode)
       VALUES ('parent-intake','tenant-a','p','x','worker:developer','developer','claimed','intake'),
              ('parent-optimize','tenant-a','p','x','worker:developer','developer','claimed','optimize')`,
    );
    const caller = (taskId: string) => ({
      taskId,
      roleId: "developer",
      tenantId: "tenant-a",
      delivery: { path: ["developer"], lineageId: taskId },
    });
    const intakeChild = await routedService.delegate({ to: "coder", title: "intake child", text: "x" }, caller("parent-intake"), scopeA);
    const optimizeChild = await routedService.delegate({ to: "coder", title: "optimize child", text: "x" }, caller("parent-optimize"), scopeA);
    const rows = await pool.query("SELECT id, work_mode FROM tasks WHERE id = ANY($1::text[])", [[intakeChild.taskId, optimizeChild.taskId]]);
    const byId = new Map(rows.rows.map((r: { id: string; work_mode: string }) => [r.id, r.work_mode]));
    expect(byId.get(intakeChild.taskId)).toBe("intake");
    expect(byId.get(optimizeChild.taskId)).toBe("optimize");
  });

  it("IntakeRun 固定 intake：due run 返回 workMode=intake", async () => {
    // 直接落一个 due subscription（租户/空间/domain 均最小可用），复用 schema 与仓库逻辑。
    const { createKnowledgeIntakeRepository } = await import("@away_from/pth-kernel-storage");
    const repo = createKnowledgeIntakeRepository(pool);
    await pool.query(
      `INSERT INTO knowledge_trust_policies
         (tenant_id, policy_id, policy_version, policy_digest, spaces, valid_from, valid_until,
          approved_by_principal_id, approved_by_issuer, approval_method, approval_key_id, approval_signature, manifest)
       VALUES ('tenant-a','policy-intake','v1','digest','["space-a"]',now(),now()+interval '1 day',
          'human:alice','ptl-human-interface','signed-manifest','human:alice','sig','{}'::jsonb)`,
    );
    await pool.query(
      `INSERT INTO knowledge_source_subscriptions
         (tenant_id, id, space, canonical_uri, domain_id, status, policy_id, policy_version, policy_digest,
          policy_rule_id, recrawl_interval_ms, next_crawl_at)
       VALUES ('tenant-a','sub-intake','space-a','https://docs.example.org/guide/a','mathematics','active',
          'policy-intake','v1','digest','rule-1',60000, now() - interval '1 minute')`,
    );
    const runs = await repo.createDueRuns(new Date(), 10, { tenantId: "tenant-a" });
    expect(runs).toHaveLength(1);
    expect(runs[0].workMode).toBe("intake");
  });
});
