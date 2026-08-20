import { useCallback, useEffect, useState } from "preact/hooks";
import { apiFetch, ApiError } from "../api";
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
import "./overview.css";

interface SourceRow {
  source: string;
  state: string;
  [key: string]: unknown;
}

interface AlertItem {
  id?: string;
  severity?: string;
  title?: string;
  message?: string;
  [key: string]: unknown;
}

interface SnapshotSummary {
  running?: number;
  completed?: number;
  total?: number;
  alerts?: AlertItem[];
}

interface IntervalRow {
  id: string;
  kind?: string;
  status?: string;
  startAt?: string | number | null;
  endAt?: string | number | null;
  [key: string]: unknown;
}

interface Snapshot {
  snapshotId?: string;
  collectedAt?: number;
  summary?: SnapshotSummary;
  intervals?: IntervalRow[];
  samples?: unknown[];
  sources?: SourceRow[];
}

type LoadState = "loading" | "ready" | "error";

function stateTone(state: string): BadgeTone {
  if (state === "fresh" || state === "healthy") return "success";
  if (state === "stale" || state === "degraded") return "warning";
  if (state === "disconnected" || state === "failure") return "danger";
  return "neutral";
}

function alertTone(severity: string | undefined): BadgeTone {
  if (severity === "critical" || severity === "danger") return "danger";
  if (severity === "warning") return "warning";
  if (severity === "info") return "info";
  return "neutral";
}

function formatTime(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleTimeString();
}

export default function OverviewPage() {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [errorCode, setErrorCode] = useState("http-0");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

  const load = useCallback(async () => {
    setLoadState("loading");
    try {
      setSnapshot(await apiFetch<Snapshot>("/observe/snapshot"));
      setLoadState("ready");
    } catch (error) {
      setErrorCode(error instanceof ApiError ? error.code : "unknown-error");
      setLoadState("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const summary = snapshot?.summary;
  const sources = snapshot?.sources ?? [];
  const intervals = snapshot?.intervals ?? [];
  const alerts = summary?.alerts ?? [];
  const samples = snapshot?.samples ?? [];

  return (
    <section class="page page-overview" data-page-root="overview">
      <PageHeader
        title="Overview"
        description="N30 只读运行观测面：来源状态、运行区间与告警。"
        actions={<Button onClick={() => void load()}>刷新</Button>}
      />
      {loadState === "loading" ? <Skeleton variant="card" /> : null}
      {loadState === "error" ? (
        <ErrorState
          title="Overview 数据加载失败"
          description={`稳定错误码：${errorCode}`}
          action={<Button onClick={() => void load()}>重试</Button>}
        />
      ) : null}
      {loadState === "ready" && snapshot ? (
        <div class="overview-grid">
          <Card title="运行状态">
            <div class="overview-metrics">
              <span class="overview-metric">
                <strong>{summary?.running ?? 0}</strong> 运行中
              </span>
              <span class="overview-metric">
                <strong>{summary?.completed ?? 0}</strong> 已完成
              </span>
              <span class="overview-metric">
                <strong>{summary?.total ?? intervals.length}</strong> 区间
              </span>
              <span class="overview-metric">
                <strong>{samples.length}</strong> 样本
              </span>
            </div>
            <p class="overview-meta">
              快照 {snapshot.snapshotId ?? "unknown"} · 采集于{" "}
              {formatTime(snapshot.collectedAt)}
            </p>
          </Card>
          <Card title="告警">
            {alerts.length === 0 ? (
              <EmptyState title="无告警" description="当前没有激活的告警。" />
            ) : (
              <ul class="overview-alerts">
                {alerts.map((alert, index) => (
                  <li class="overview-alert" key={alert.id ?? `${index}`}>
                    <Badge tone={alertTone(alert.severity)}>
                      {alert.severity ?? "alert"}
                    </Badge>
                    <span>{alert.title ?? alert.message ?? "未知告警"}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="来源状态">
            {sources.length === 0 ? (
              <EmptyState title="无来源" description="N30 未报告任何数据源。" />
            ) : (
              <Table
                columns={[
                  { key: "source", label: "来源" },
                  {
                    key: "state",
                    label: "状态",
                    render: (row) => (
                      <Badge tone={stateTone(String(row.state))}>
                        {String(row.state)}
                      </Badge>
                    ),
                  },
                ]}
                rows={sources as Array<SourceRow & Record<string, unknown>>}
                rowKey={(row, index) => String(row.source ?? index)}
              />
            )}
          </Card>
          <Card title="运行区间">
            {intervals.length === 0 ? (
              <EmptyState title="无运行区间" description="当前窗口没有区间数据。" />
            ) : (
              <Table
                columns={[
                  { key: "kind", label: "类型" },
                  { key: "id", label: "ID" },
                  {
                    key: "status",
                    label: "状态",
                    render: (row) => <Badge>{String(row.status)}</Badge>,
                  },
                  {
                    key: "startAt",
                    label: "开始",
                    render: (row) => formatTime(row.startAt),
                  },
                  {
                    key: "endAt",
                    label: "结束",
                    render: (row) => formatTime(row.endAt),
                  },
                ]}
                rows={intervals as Array<IntervalRow & Record<string, unknown>>}
                rowKey={(row) => String(row.id)}
              />
            )}
          </Card>
        </div>
      ) : null}
    </section>
  );
}
