import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { TaskDispatcher } from "../../src/pth/tasking/task-dispatcher.js";
import { TaskOutcomeCommitter } from "../../src/pth/tasking/task-outcome-committer.js";
import type {
  TaskLease,
  TaskOutcome,
  TaskRepository,
  TaskRunner,
  TaskWorkItem,
  TenantScope,
} from "@away_from/pth-contracts";

const scope: TenantScope = { tenantId: "tenant-a", principalId: "worker:developer", roles: ["developer"], traceId: "trace-1" };

function leaseFor(id: string, generation = 1): TaskLease {
  return {
    taskId: id,
    leaseId: randomUUID(),
    generation,
    scope,
    roleId: "developer",
    workspace: { tenantId: scope.tenantId, workspaceId: `task:${id}`, taskId: id },
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function workFor(id: string): TaskWorkItem {
  return { taskId: id, scope, title: id, text: "x", tags: ["code"], payload: {}, assignedRole: "developer", domains: [] };
}

function okOutcome(lease: TaskLease): TaskOutcome {
  return { lease, status: "completed", result: { ok: true }, artifacts: [], traceId: scope.traceId };
}

describe("TaskDispatcher（P1-5）", () => {
  it("claim 空 → 不执行 runner", async () => {
    const runner: TaskRunner = { run: vi.fn(async () => okOutcome(leaseFor("nope"))) };
    const repository: TaskRepository = {
      claim: vi.fn(async () => []),
      recoverExpired: vi.fn(async () => 0),
      renewLease: vi.fn(async () => ({ renewed: true })),
      commit: vi.fn(async () => ({ committed: true })),
    };
    const dispatcher = new TaskDispatcher({ repository, committer: new TaskOutcomeCommitter(repository), runner });
    const result = await dispatcher.dispatchOnce(scope, "developer", []);
    expect(result.ran).toBe(0);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("commit committed:false → runner 结果不触发 observer", async () => {
    const lease = leaseFor("t1");
    const runner: TaskRunner = { run: vi.fn(async () => okOutcome(lease)) };
    const repository: TaskRepository = {
      claim: vi.fn(async () => [{ lease, work: workFor("t1") }]),
      recoverExpired: vi.fn(async () => 0),
      renewLease: vi.fn(async () => ({ renewed: true })),
      commit: vi.fn(async () => ({ committed: false })),
    };
    const observer = vi.fn();
    const dispatcher = new TaskDispatcher({
      repository,
      committer: new TaskOutcomeCommitter(repository),
      runner,
      observers: [observer],
    });
    const result = await dispatcher.dispatchOnce(scope, "developer", ["t1"]);
    expect(result.ran).toBe(1);
    expect(result.committed).toBe(0);
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(observer).not.toHaveBeenCalled();
  });

  it("runner 抛错 → 生成 terminal outcome 且不二次执行", async () => {
    const lease = leaseFor("t1");
    const runner: TaskRunner = { run: vi.fn(async () => { throw new Error("runner exploded"); }) };
    const commits: TaskOutcome[] = [];
    const repository: TaskRepository = {
      claim: vi.fn(async () => [{ lease, work: workFor("t1") }]),
      recoverExpired: vi.fn(async () => 0),
      renewLease: vi.fn(async () => ({ renewed: true })),
      commit: vi.fn(async (outcome: TaskOutcome) => {
        commits.push(outcome);
        return { committed: true };
      }),
    };
    const observer = vi.fn();
    const dispatcher = new TaskDispatcher({
      repository,
      committer: new TaskOutcomeCommitter(repository),
      runner,
      observers: [observer],
    });
    const result = await dispatcher.dispatchOnce(scope, "developer", ["t1"]);
    expect(result.ran).toBe(1);
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(commits).toHaveLength(1);
    expect(commits[0].status).toBe("rejected");
    expect(commits[0].retryable).toBe(false);
    expect(commits[0].error?.code).toBe("runner-crashed");
    expect(observer).toHaveBeenCalledTimes(1);
  });

  it("pause → 不 claim；stop 在条目间生效", async () => {
    const lease1 = leaseFor("t1");
    const lease2 = leaseFor("t2");
    const runner: TaskRunner = {
      run: vi.fn(async (input: { lease: TaskLease }) => {
        if (input.lease.taskId === "t1") dispatcher.stop();
        return okOutcome(input.lease);
      }),
    };
    const repository: TaskRepository = {
      claim: vi.fn(async () => [
        { lease: lease1, work: workFor("t1") },
        { lease: lease2, work: workFor("t2") },
      ]),
      recoverExpired: vi.fn(async () => 0),
      renewLease: vi.fn(async () => ({ renewed: true })),
      commit: vi.fn(async () => ({ committed: true })),
    };
    const dispatcher = new TaskDispatcher({ repository, committer: new TaskOutcomeCommitter(repository), runner });
    dispatcher.pause();
    expect(await dispatcher.dispatchOnce(scope, "developer", ["t1", "t2"])).toMatchObject({ ran: 0 });
    dispatcher.resume();
    const result = await dispatcher.dispatchOnce(scope, "developer", ["t1", "t2"]);
    expect(result.ran).toBe(1); // t1 后 stop，t2 不再执行
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it("stale lease（generation 0）→ 跳过且不触发 runner/observer", async () => {
    const stale = leaseFor("stale", 0);
    const runner: TaskRunner = { run: vi.fn(async () => okOutcome(stale)) };
    const repository: TaskRepository = {
      claim: vi.fn(async () => [{ lease: stale, work: workFor("stale") }]),
      recoverExpired: vi.fn(async () => 0),
      renewLease: vi.fn(async () => ({ renewed: true })),
      commit: vi.fn(async () => ({ committed: true })),
    };
    const observer = vi.fn();
    const dispatcher = new TaskDispatcher({
      repository,
      committer: new TaskOutcomeCommitter(repository),
      runner,
      observers: [observer],
    });
    const result = await dispatcher.dispatchOnce(scope, "developer", ["stale"]);
    expect(result.ran).toBe(0);
    expect(runner.run).not.toHaveBeenCalled();
    expect(observer).not.toHaveBeenCalled();
  });

  it("named observers all succeed => no 'observer failed' log", async () => {
    const lease = leaseFor("t1");
    const calls: string[] = [];
    const logs: string[] = [];
    const repository: TaskRepository = {
      claim: vi.fn(async () => [{ lease, work: workFor("t1") }]),
      recoverExpired: vi.fn(async () => 0),
      renewLease: vi.fn(async () => ({ renewed: true })),
      commit: vi.fn(async () => ({ committed: true })),
    };
    const dispatcher = new TaskDispatcher({
      repository,
      committer: new TaskOutcomeCommitter(repository),
      runner: { run: vi.fn(async () => okOutcome(lease)) },
      observers: [
        { name: "audit-observer", stage: "audit", durable: true, observe: async () => { calls.push("audit"); } },
        { name: "transcript-observer", stage: "transcript", durable: true, observe: async () => { calls.push("transcript"); } },
      ],
      logger: (m) => logs.push(m),
    });
    const result = await dispatcher.dispatchOnce(scope, "developer", ["t1"]);
    expect(result.committed).toBe(1);
    expect(calls).toEqual(["audit", "transcript"]);
    expect(logs.filter((l) => l.includes("observer failed"))).toEqual([]);
  });
});
