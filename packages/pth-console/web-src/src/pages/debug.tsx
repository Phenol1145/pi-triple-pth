import { useCallback, useEffect, useState } from "preact/hooks";
import { apiFetch } from "../api";
import { useLoadState } from "../hooks/useLoadState";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  PageHeader,
  Skeleton,
  Table,
  type BadgeTone,
} from "../ui";
import "./debug.css";

interface WorkerRow {
  workerId: string;
  batchId: string;
  roleId: string;
  roleRevision: string;
  lifecycle: string;
  workMode: string | null;
  taskId: string | null;
  leaseId: string | null;
  heartbeatAt: string | null;
  regions: Array<{ regionId: string; weights: number | null }>;
  workingSet: string[] | { ids: string[] };
  toolNames: string[];
  skillIds: string[];
}

function lifecycleTone(lifecycle: string): BadgeTone {
  if (lifecycle === "busy") return "info";
  if (lifecycle === "idle") return "success";
  if (lifecycle === "paused" || lifecycle === "draining") return "warning";
  if (lifecycle === "stopped") return "danger";
  return "neutral";
}

export default function DebugPage() {
  const [workers, setWorkers] = useState<WorkerRow[]>([]);
  const [roleFilter, setRoleFilter] = useState("");
  const [modeFilter, setModeFilter] = useState("all");
  const [lifecycleFilter, setLifecycleFilter] = useState("all");
  const { loadState, errorCode, run } = useLoadState();

  const load = useCallback(async () => {
    await run(async () => {
      const payload = await apiFetch<{ workers: WorkerRow[] }>("/api/v1/debug/workers");
      setWorkers(payload.workers ?? []);
    });
  }, [run]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = workers.filter((worker) => {
    if (roleFilter && !worker.roleId.includes(roleFilter)) return false;
    if (modeFilter !== "all" && (worker.workMode ?? "none") !== modeFilter) return false;
    if (lifecycleFilter !== "all" && worker.lifecycle !== lifecycleFilter) return false;
    return true;
  });

  return (
    <section class="page page-debug" data-page-root="debug">
      <PageHeader
        title="Debug"
        description="Worker 副本与 Working Set 只读投影。"
        actions={<Button onClick={() => void load()}>刷新</Button>}
      />
      {loadState === "loading" ? <Skeleton variant="table" /> : null}
      {loadState === "error" ? (
        <ErrorState
          title="Debug 数据加载失败"
          description={`稳定错误码：${errorCode}`}
          action={<Button onClick={() => void load()}>重试</Button>}
        />
      ) : null}
      {loadState === "ready" ? (
        <div class="debug-layout">
          <div class="debug-filters">
            <input
              class="debug-filter-input"
              value={roleFilter}
              placeholder="按角色过滤"
              onInput={(event) => setRoleFilter((event.target as HTMLInputElement).value)}
            />
            <select
              class="debug-filter-input"
              value={modeFilter}
              onChange={(event) => setModeFilter((event.target as HTMLSelectElement).value)}
            >
              <option value="all">全部 WorkMode</option>
              {["run", "intake", "optimize"].map((item) => (
                <option value={item} key={item}>{item}</option>
              ))}
            </select>
            <select
              class="debug-filter-input"
              value={lifecycleFilter}
              onChange={(event) => setLifecycleFilter((event.target as HTMLSelectElement).value)}
            >
              <option value="all">全部生命周期</option>
              {["idle", "busy", "paused", "draining", "stopped"].map((item) => (
                <option value={item} key={item}>{item}</option>
              ))}
            </select>
          </div>
          {visible.length === 0 ? (
            <Card>
              <EmptyState title="没有匹配的 Worker" description="调整过滤条件后重试。" />
            </Card>
          ) : (
            <Card padding="none">
              <Table
                columns={[
                  {
                    key: "workerId",
                    label: "Worker",
                    render: (row) => (
                      <div class="debug-worker">
                        <strong>{row.workerId}</strong>
                        <span>{row.batchId}</span>
                      </div>
                    ),
                  },
                  { key: "roleId", label: "角色" },
                  {
                    key: "lifecycle",
                    label: "生命周期",
                    render: (row) => (
                      <Badge tone={lifecycleTone(row.lifecycle)}>{row.lifecycle}</Badge>
                    ),
                  },
                  {
                    key: "workMode",
                    label: "WorkMode",
                    render: (row) => <Badge>{row.workMode ?? "none"}</Badge>,
                  },
                  { key: "taskId", label: "任务" },
                  {
                    key: "regions",
                    label: "责任区",
                    render: (row) =>
                      row.regions.length === 0
                        ? "—"
                        : row.regions.map((region) => (
                            <Badge key={region.regionId}>{region.regionId}</Badge>
                          )),
                  },
                  {
                    key: "workingSet",
                    label: "Working Set",
                    render: (row) => {
                      const ids = Array.isArray(row.workingSet)
                        ? row.workingSet
                        : (row.workingSet?.ids ?? []);
                      return ids.length === 0
                        ? "—"
                        : ids.map((id) => <Badge key={id}>{id}</Badge>);
                    },
                  },
                ]}
                rows={visible as Array<WorkerRow & Record<string, unknown>>}
                rowKey={(row) => row.workerId}
              />
            </Card>
          )}
        </div>
      ) : null}
    </section>
  );
}
