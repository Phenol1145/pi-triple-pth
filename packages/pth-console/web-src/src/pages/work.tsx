import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { apiFetch, ApiError } from "../api";
import {
  Badge,
  Button,
  Card,
  ErrorState,
  PageHeader,
  Skeleton,
  Tabs,
} from "../ui";
import { toast } from "../toast";
import "./work.css";

type WorkMode = "run" | "intake" | "optimize";

interface FormField {
  name: string;
  type: "string" | "number" | "boolean" | "enum" | "object" | "array";
  required: boolean;
  description?: string;
  schema?: Readonly<Record<string, unknown>>;
}

interface ActionDescriptor {
  title: string;
  description?: string;
  fields: readonly FormField[];
}

interface ActionListing {
  mode: WorkMode;
  action: string;
  nativeKind: string;
  descriptor: ActionDescriptor;
}

interface PreviewSummary {
  readonly summary: readonly string[];
  readonly impact: { scope: string; reversible: boolean; risk: string };
  readonly nativeTarget: string;
  readonly expiresAt: string;
}

interface PreviewResponse {
  preview: {
    previewId: string;
    previewDigest: string;
    mode: WorkMode;
    action: string;
    normalizedInput: Record<string, unknown>;
  } & PreviewSummary;
  tenant: string;
  space: string;
}

interface AcceptanceResponse {
  acceptance: {
    accepted: boolean;
    ref?: { id: string; kind: string; mode: WorkMode };
    evidence?: { status?: string; observedAt?: string };
  };
}

type Step = "form" | "preview" | "submitted";

export default function WorkPage() {
  const [actions, setActions] = useState<ActionListing[]>([]);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [errorCode, setErrorCode] = useState("http-0");
  const [mode, setMode] = useState<WorkMode>("run");
  const [action, setAction] = useState<string>("");
  const [input, setInput] = useState<Record<string, string>>({});
  const [step, setStep] = useState<Step>("form");
  const [preview, setPreview] = useState<PreviewResponse["preview"] | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [acceptance, setAcceptance] = useState<AcceptanceResponse["acceptance"] | null>(null);
  const [evaluating, setEvaluating] = useState(false);
  const [submittedRef, setSubmittedRef] = useState<{ mode: WorkMode; kind: string; id: string } | null>(null);

  const modeActions = useMemo(
    () => actions.filter((item) => item.mode === mode),
    [actions, mode],
  );
  const selected = modeActions.find((item) => item.action === action) ?? modeActions[0];
  const fields = selected?.descriptor.fields ?? [];

  const loadActions = useCallback(async () => {
    setLoadState("loading");
    try {
      const payload = await apiFetch<{ actions: ActionListing[] }>("/api/v1/work/actions");
      setActions(payload.actions ?? []);
      setLoadState("ready");
    } catch (error) {
      setErrorCode(error instanceof ApiError ? error.code : "unknown-error");
      setLoadState("error");
    }
  }, []);

  useEffect(() => {
    void loadActions();
  }, [loadActions]);

  useEffect(() => {
    setAction(modeActions[0]?.action ?? "");
    setInput({});
    setStep("form");
    setPreview(null);
    setAcceptance(null);
  }, [mode, modeActions]);

  const updateField = (name: string, value: string) => {
    setInput((prev) => ({ ...prev, [name]: value }));
  };

  const normalizedInput = () => {
    const value: Record<string, unknown> = {};
    for (const field of fields) {
      const raw = input[field.name];
      if (field.type === "array") {
        value[field.name] = typeof raw === "string" && raw.trim() !== ""
          ? raw.split(",").map((part) => part.trim()).filter(Boolean)
          : [];
      } else if (field.type === "number") {
        const number = Number(raw);
        value[field.name] = Number.isFinite(number) ? number : 0;
      } else if (field.type === "boolean") {
        value[field.name] = raw === "true";
      } else {
        value[field.name] = raw ?? "";
      }
    }
    return value;
  };

  const submitPreview = async () => {
    if (!selected) return;
    setPreviewing(true);
    try {
      const response = await apiFetch<PreviewResponse>("/api/v1/work/preview", {
        method: "POST",
        body: { mode, action: selected.action, input: normalizedInput() },
      });
      setPreview(response.preview);
      setAcceptance(null);
      setStep("preview");
    } catch (error) {
      toast.error(error instanceof ApiError ? `预览失败：${error.code}` : "预览失败");
    } finally {
      setPreviewing(false);
    }
  };

  const submitWork = async () => {
    if (!preview) return;
    setSubmitting(true);
    try {
      const response = await apiFetch<{ ref: { mode: WorkMode; kind: string; id: string; submittedAt: string } }>(
        "/api/v1/work/submit",
        {
          method: "POST",
          body: {
            previewId: preview.previewId,
            previewDigest: preview.previewDigest,
            idempotencyKey: crypto.randomUUID(),
          },
        },
      );
      setSubmittedRef(response.ref);
      setStep("submitted");
      toast.success("原生任务已提交，可重试同预览幂等提交。");
      await evaluateWork(response.ref);
    } catch (error) {
      toast.error(error instanceof ApiError ? `提交失败：${error.code}` : "提交失败");
    } finally {
      setSubmitting(false);
    }
  };

  const evaluateWork = async (ref = submittedRef) => {
    if (!ref) return;
    setEvaluating(true);
    try {
      const response = await apiFetch<AcceptanceResponse>("/api/v1/work/evaluate", {
        method: "POST",
        body: {
          mode: ref.mode,
          kind: ref.kind,
          id: ref.id,
          submittedAt: new Date().toISOString(),
        },
      });
      setAcceptance(response.acceptance);
    } catch (error) {
      toast.error(error instanceof ApiError ? `状态检查失败：${error.code}` : "状态检查失败");
    } finally {
      setEvaluating(false);
    }
  };

  const highRisk = preview?.impact.risk !== "low";

  return (
    <section class="page page-work" data-page-root="work">
      <PageHeader title="Work" description="run / intake / optimize 原生动作：预览 → 确认 → 提交。" />
      {loadState === "loading" ? <Skeleton variant="card" /> : null}
      {loadState === "error" ? (
        <ErrorState
          title="Work 通道不可用"
          description={`稳定错误码：${errorCode}`}
          action={<Button onClick={() => void loadActions()}>重试</Button>}
        />
      ) : null}
      {loadState === "ready" && modeActions.length === 0 ? (
        <ErrorState
          title="没有可用的原生动作"
          description="work channel 未装配或未登记动作。"
        />
      ) : null}
      {loadState === "ready" && modeActions.length > 0 ? (
        <div class="work-layout">
          <Tabs
            ariaLabel="Work mode"
            items={["run", "intake", "optimize"].map((item) => ({
              id: item,
              label: item,
              count: actions.filter((entry) => entry.mode === item).length,
            }))}
            value={mode}
            onChange={(value) => setMode(value as WorkMode)}
          />
          <Card title={selected?.descriptor.title ?? "原生动作"}>
            {selected?.descriptor.description ? (
              <p class="work-description">{selected.descriptor.description}</p>
            ) : null}
            {step === "form" ? (
              <form
                class="work-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitPreview();
                }}
              >
                {fields.map((field) => (
                  <label class="work-field" key={field.name}>
                    <span class="work-field__label">
                      {field.name}
                      {field.required ? <Badge tone="danger">必填</Badge> : <Badge>可选</Badge>}
                    </span>
                    {field.description ? (
                      <span class="work-field__description">{field.description}</span>
                    ) : null}
                    {field.type === "array" ? (
                      <input
                        class="work-input"
                        value={input[field.name] ?? ""}
                        placeholder="逗号分隔"
                        onInput={(event) =>
                          updateField(field.name, (event.target as HTMLInputElement).value)
                        }
                      />
                    ) : (
                      <textarea
                        class="work-textarea"
                        rows={field.name === "text" ? 6 : 3}
                        value={input[field.name] ?? ""}
                        onInput={(event) =>
                          updateField(field.name, (event.target as HTMLTextAreaElement).value)
                        }
                      />
                    )}
                  </label>
                ))}
                <div class="work-actions">
                  <Button type="submit" variant="primary" loading={previewing}>
                    生成预览
                  </Button>
                </div>
              </form>
            ) : null}
            {step === "preview" && preview ? (
              <div class="work-preview">
                <dl class="work-facts">
                  <div>
                    <dt>原生目标</dt>
                    <dd>{preview.nativeTarget}</dd>
                  </div>
                  <div>
                    <dt>影响</dt>
                    <dd>
                      {preview.impact.scope} · {preview.impact.reversible ? "可逆" : "不可逆"} ·{" "}
                      <Badge tone={highRisk ? "danger" : "success"}>
                        {preview.impact.risk}
                      </Badge>
                    </dd>
                  </div>
                  <div>
                    <dt>预览有效期</dt>
                    <dd>{new Date(preview.expiresAt).toLocaleString()}</dd>
                  </div>
                </dl>
                <ul class="work-summary">
                  {preview.summary.map((line, index) => (
                    <li key={index}>{line}</li>
                  ))}
                </ul>
                {highRisk ? (
                  <label class="work-confirm">
                    <span>高风险动作：输入动作标签确认</span>
                    <input
                      class="work-input"
                      value={confirmation}
                      onInput={(event) =>
                        setConfirmation((event.target as HTMLInputElement).value)
                      }
                    />
                  </label>
                ) : null}
                <div class="work-actions">
                  <Button onClick={() => setStep("form")}>返回编辑</Button>
                  <Button
                    variant="primary"
                    disabled={highRisk && confirmation !== "确认"}
                    loading={submitting}
                    onClick={() => void submitWork()}
                  >
                    {highRisk ? "确认并提交" : "提交"}
                  </Button>
                </div>
              </div>
            ) : null}
            {step === "submitted" ? (
              <div class="work-submitted">
                <Badge tone={acceptance?.accepted ? "success" : "info"}>
                  {acceptance?.accepted ? "已接受" : acceptance ? "处理中" : "等待状态检查"}
                </Badge>
                {acceptance?.evidence?.status ? (
                  <p>原生状态：{acceptance.evidence.status}</p>
                ) : null}
                <Button loading={evaluating} onClick={() => void evaluateWork()}>
                  重新检查
                </Button>
              </div>
            ) : null}
          </Card>
        </div>
      ) : null}
    </section>
  );
}
