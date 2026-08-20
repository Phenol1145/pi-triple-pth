/**
 * PTL Operator Console — 壳 + Overview 只读 N30 同源代理消费。
 *
 * 安全约定：只使用 textContent / DOM createElement 渲染任何运行时值；
 * 绝不使用 innerHTML。URL fragment 中的一次性 bootstrap token 在兑换后立即清除。
 * Overview 只通过同源 /observe/* 消费 N30 观测面；浏览器不接触 N30 凭据/端点。
 * PTL Operator Console — 壳 + Work 页面（N33 Task 5 Step 6）。
 *
 * 安全约定：只使用 textContent / DOM createElement 渲染任何运行时值；
 * 绝不使用 innerHTML。URL fragment 中的一次性 bootstrap token 在兑换后立即清除。
 * 浏览器永远拿不到 PTH/N30 token——所有原生调用由服务端代理。
 *
 * Work 页契约：
 *  - 三个 mode tab（run/intake/optimize），表单由服务端字段描述驱动；
 *  - 预览 → 确认 → 提交 → 原生状态轮询；不创建任何通用 workflow 状态；
 *  - 高风险动作必须输入动作标签（action 字符串）才能确认；
 *  - 确认按钮永远不是初始焦点（焦点落在「取消」上）。
 */

const PAGES = ["overview", "work", "debug", "memory", "config"];
const N30_EMBED_URL = "/observe/?embed=1&base=/observe";

import { createDebugViewModel, DEBUG_POLL_MS } from "./debug.js";
import { createMemoryViewModel } from "./memory.js";
import { createConfigViewModel } from "./config.js";

const state = {
  csrfToken: null,
  operatorPrincipalId: null,
};

function createEl(tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function setSessionState(text) {
  const node = document.getElementById("session-state");
  if (!node) return;
  node.textContent = text;
}

function switchPage(pageId) {
  for (const id of PAGES) {
    const root = document.querySelector(`[data-page-root="${id}"]`);
    if (root) root.hidden = id !== pageId;
    const nav = document.querySelector(`[data-page="${id}"]`);
    if (nav) nav.classList.toggle("active", id === pageId);
  }
  if (pageId === "work") void ensureWorkLoaded();
  if (pageId === "debug") void ensureDebugLoaded();
  if (pageId === "memory") void ensureMemoryLoaded();
  if (pageId === "config") void ensureConfigLoaded();
}

function bindNav() {
  for (const button of document.querySelectorAll(".nav-item")) {
    button.addEventListener("click", () => {
      const pageId = button.getAttribute("data-page");
      if (pageId && PAGES.includes(pageId)) {
        history.replaceState(null, "", `/#/${pageId}`);
        switchPage(pageId);
      }
    });
  }
}

/** 带 CSRF 的同源 API 调用；401/403 时把会话状态置为未连接。 */
async function api(path, opts = {}) {
  const headers = { ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (state.csrfToken) headers["X-PTL-CSRF"] = state.csrfToken;
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401 || res.status === 403) setSessionState("未连接");
  const text = await res.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  if (!res.ok) {
    const err = new Error(payload?.error?.message ?? `HTTP ${res.status}`);
    err.status = res.status;
    err.code = payload?.error?.code;
    throw err;
  }
  return payload;
}

// ─── Work 页面 ───

const work = {
  loaded: false,
  actions: [],
  tenant: null,
  space: null,
  selectedAction: null,
  preview: null,
  pollTimer: null,
};

// ── N33 Task 6：debug 只读页（2s 权威快照轮询；无控制动作） ──

let debugVm = null;
let debugTimer = null;
let debugSelectedWorker = null;

function renderDebug() {
  if (!debugVm) return;
  const view = debugVm.view();
  const freshness = document.getElementById("debug-freshness");
  if (freshness) {
    freshness.textContent = view.freshnessState;
    freshness.className = "debug-freshness " + view.freshnessState;
  }
  const list = document.getElementById("debug-worker-list");
  const empty = document.getElementById("debug-empty");
  if (list) list.replaceChildren();
  if (empty) empty.hidden = view.workers.length !== 0;
  for (const w of view.workers) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "debug-worker-card" + (debugSelectedWorker === w.workerId ? " selected" : "");
    card.append(
      createEl("strong", w.workerId),
      createEl("span", ` — ${w.roleId}@${w.roleRevision} — ${w.workMode} — ${w.lifecycle}`),
    );
    card.addEventListener("click", () => {
      debugSelectedWorker = w.workerId;
      renderDebugDetail(w);
      renderDebug();
    });
    if (list) list.append(card);
  }
  const detail = document.getElementById("debug-worker-detail");
  if (detail && !view.workers.some((w) => w.workerId === debugSelectedWorker)) detail.hidden = true;
}

function renderDebugDetail(w) {
  const detail = document.getElementById("debug-worker-detail");
  if (!detail) return;
  detail.hidden = false;
  detail.replaceChildren(
    createEl("h2", w.workerId),
    createEl("p", `batch ${w.batchId} · task ${w.taskId} · lease ${w.leaseId} · heartbeat ${w.heartbeatAt}`),
    createEl("p", `Working Set ${w.workingSet.count} 项：${w.workingSet.ids.join(", ") || "—"}`),
    createEl("p", `工具：${w.toolNames.join(", ") || "—"} · 技能：${w.skillIds.join(", ") || "—"}`),
  );
  const regions = document.createElement("ul");
  for (const r of w.regions) {
    regions.append(createEl("li", `${r.regionId} (权重 ${r.weights})`));
  }
  detail.append(regions);
}

async function pollDebug() {
  try {
    const res = await fetch("/api/debug/workers", { credentials: "same-origin" });
    if (!res.ok) throw new Error(`debug workers HTTP ${res.status}`);
    const payload = await res.json();
    const workers = Array.isArray(payload) ? payload : Array.isArray(payload?.workers) ? payload.workers : [];
    if (debugVm) debugVm.ingest(workers, Date.now());
    const degraded = document.getElementById("debug-degraded");
    if (degraded) degraded.hidden = true;
  } catch {
    const degraded = document.getElementById("debug-degraded");
    if (degraded) degraded.hidden = false;
  }
  renderDebug();
}

async function ensureDebugLoaded() {
  if (!debugVm) {
    debugVm = createDebugViewModel();
    const bindFilter = (id, key) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("input", () => {
        debugVm.setFilter(key, el.value);
        renderDebug();
      });
    };
    bindFilter("debug-filter-worker", "workerId");
    bindFilter("debug-filter-role", "roleId");
    bindFilter("debug-filter-mode", "workMode");
    bindFilter("debug-filter-lifecycle", "lifecycle");
  }
  await pollDebug();
  if (!debugTimer) debugTimer = setInterval(() => void pollDebug(), DEBUG_POLL_MS);
}

// ── N33 Task 7：memory 只读页（双 SVG 饼图 + 分页 + 惰性 detail + 十条修订） ──

let memoryVm = null;
let memorySelectedId = null;

const MEMORY_PIE_COLORS = {
  setting: "#5b8def", wiki: "#3fa66a", skill: "#e0a33a", log: "#9a7bdf", index: "#d66a9c",
};

function renderMemoryPie(svgId, tableId, chart, label) {
  const svg = document.getElementById(svgId);
  const table = document.getElementById(tableId);
  if (!svg || !table) return;
  svg.replaceChildren();
  if (chart.empty) {
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", "100"); circle.setAttribute("cy", "100"); circle.setAttribute("r", "70");
    circle.setAttribute("fill", "#ddd");
    svg.append(circle);
    table.textContent = `${label}：0（空）`;
    return;
  }
  let angle = 0;
  const total = chart.total;
  for (const slice of chart.slices) {
    if (slice.value === 0) continue;
    const sweep = slice.ratio * Math.PI * 2;
    const x1 = 100 + Math.sin(angle) * 80;
    const y1 = 100 - Math.cos(angle) * 80;
    const x2 = 100 + Math.sin(angle + sweep) * 80;
    const y2 = 100 - Math.cos(angle + sweep) * 80;
    const large = sweep > Math.PI ? 1 : 0;
    const d = `M 100 100 L ${x1} ${y1} A 80 80 0 ${large} 1 ${x2} ${y2} Z`;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", MEMORY_PIE_COLORS[slice.type] ?? "#999");
    svg.append(path);
    angle += sweep;
  }
  table.textContent = chart.slices
    .filter((s) => s.value > 0)
    .map((s) => `${s.type}: ${s.value}（${(s.ratio * 100).toFixed(1)}%）`)
    .join("\n") || `${label}：0`;
}

function renderMemory() {
  if (!memoryVm) return;
  const view = memoryVm.view();
  renderMemoryPie("memory-pie-count", "memory-pie-count-table", view.charts.count, "count");
  renderMemoryPie("memory-pie-bytes", "memory-pie-bytes-table", view.charts.bytes, "bytes");
  const tbody = document.querySelector("#memory-list tbody");
  if (tbody) tbody.replaceChildren();
  const empty = document.getElementById("memory-empty");
  if (empty) empty.hidden = view.entries.length !== 0;
  for (const row of view.entries) {
    const tr = document.createElement("tr");
    tr.className = row.id === memorySelectedId ? "selected" : "";
    for (const key of ["id", "type", "kind", "status", "updatedAt"]) {
      const td = document.createElement("td");
      td.textContent = row[key] === undefined || row[key] === null ? "" : String(row[key]);
      tr.append(td);
    }
    tr.addEventListener("click", () => {
      memorySelectedId = row.id;
      renderMemory();
      void loadMemoryDetail(row.id);
    });
    tbody?.append(tr);
  }
  const loadMore = document.getElementById("memory-load-more");
  if (loadMore) loadMore.hidden = !view.cursor;
  const revisions = document.querySelector("#memory-revisions tbody");
  if (revisions) {
    revisions.replaceChildren();
    for (const r of view.revisions) {
      const tr = document.createElement("tr");
      for (const key of ["action", "revision", "time", "type"]) {
        const td = document.createElement("td");
        td.textContent = r[key] === undefined || r[key] === null ? "" : String(r[key]);
        tr.append(td);
      }
      revisions.append(tr);
    }
  }
  const degraded = document.getElementById("memory-degraded");
  if (degraded) degraded.hidden = !view.degraded;
}

async function loadMemoryDetail(id) {
  try {
    const res = await fetch(`/api/memory/entries/${encodeURIComponent(id)}`, { credentials: "same-origin" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const detail = await res.json();
    memoryVm.ingestDetail(detail ?? { id, tombstone: true });
    const revRes = await fetch(`/api/memory/entries/${encodeURIComponent(id)}/revisions`, { credentials: "same-origin" });
    if (revRes.ok) memoryVm.ingestRevisions(await revRes.json());
  } catch {
    memoryVm.ingestDetail({ id, tombstone: true });
    memoryVm.ingestRevisions([]);
  }
  const box = document.getElementById("memory-detail");
  if (box) {
    const detail = memoryVm.view().detail;
    box.hidden = false;
    box.replaceChildren(createEl("h2", detail?.id ?? id));
    if (detail?.tombstone) box.append(createEl("p", "条目已删除或不可读（tombstone 元数据）"));
    else {
      box.append(createEl("p", `type ${detail?.type ?? "—"} · kind ${detail?.kind ?? "—"} · status ${detail?.status ?? "—"}`));
      const pre = document.createElement("pre");
      pre.textContent = typeof detail?.content === "string"
        ? detail.content.slice(0, 4000)
        : `正文不进入只读 Memory 视图；该条目正文约 ${detail?.contentBytes ?? 0} 字节`;
      box.append(pre);
    }
  }
}

async function loadMemoryPage(reset) {
  if (!memoryVm) return;
  const f = memoryVm.view().filters;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(f)) if (value) params.set(key, value);
  if (!reset && memoryVm.view().cursor) params.set("cursor", memoryVm.view().cursor);
  params.set("limit", "20");
  try {
    const res = await fetch(`/api/memory/entries?${params.toString()}`, { credentials: "same-origin" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    memoryVm.ingestPage(await res.json());
    memoryVm.markDegraded(false);
  } catch {
    memoryVm.markDegraded(true);
  }
  renderMemory();
}

async function ensureMemoryLoaded() {
  if (!memoryVm) {
    memoryVm = createMemoryViewModel();
    for (const [id, key] of [
      ["memory-filter-type", "type"],
      ["memory-filter-kind", "kind"],
      ["memory-filter-status", "status"],
      ["memory-filter-anchor", "anchor"],
    ]) {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener("change", () => {
          memoryVm.setFilter(key, el.value);
          memorySelectedId = null;
          void loadMemoryPage(true);
        });
      }
    }
    const loadMore = document.getElementById("memory-load-more");
    if (loadMore) loadMore.addEventListener("click", () => void loadMemoryPage(false));
  }
  try {
    const res = await fetch("/api/memory/summary", { credentials: "same-origin" });
    if (res.ok) memoryVm.ingestSummary(await res.json());
  } catch {
    /* summary 失败仅标记降级，列表仍独立尝试 */
  }
  await loadMemoryPage(true);
}

// ── N33 Task 8：config 只读页（PTL/PTH/Roles 三 tab，无表单无保存） ──

let configVm = null;

function renderConfig() {
  if (!configVm) return;
  const view = configVm.view();
  for (const el of document.querySelectorAll("[data-config-panel]")) {
    el.hidden = el.getAttribute("data-config-panel") !== view.tab;
  }
  const renderTable = (selector, rows, columns) => {
    const tbody = document.querySelector(selector);
    if (!tbody) return;
    tbody.replaceChildren();
    for (const row of rows) {
      const tr = document.createElement("tr");
      for (const key of columns) {
        const td = document.createElement("td");
        const value = row[key];
        td.textContent = value === null || value === undefined ? "" : Array.isArray(value) ? value.join(", ") : String(value);
        if (value === "***") td.className = "redacted";
        tr.append(td);
      }
      tbody.append(tr);
    }
  };
  renderTable("#config-tab-ptl tbody", view.ptlConfig, ["key", "group", "source", "value"]);
  renderTable("#config-tab-pth tbody", view.pthConfig, ["key", "group", "type", "defaultValue", "effectiveValue", "source", "scope", "restartRequired"]);
  renderTable("#config-tab-roles tbody", view.roles, ["id", "parent", "revision", "family", "tags", "capabilities", "defaultReplicas", "loadPolicyRef"]);
  const degraded = document.getElementById("config-degraded");
  if (degraded) degraded.hidden = !view.degraded;
}

async function ensureConfigLoaded() {
  if (!configVm) {
    configVm = createConfigViewModel();
    for (const btn of document.querySelectorAll("[data-config-tab]")) {
      btn.addEventListener("click", () => {
        configVm.setTab(btn.getAttribute("data-config-tab"));
        renderConfig();
      });
    }
    const search = document.getElementById("config-search");
    if (search) {
      search.addEventListener("input", () => {
        configVm.setSearch(search.value);
        renderConfig();
      });
    }
    const roleFilter = document.getElementById("config-role-filter");
    if (roleFilter) {
      roleFilter.addEventListener("input", () => {
        configVm.setRoleFilter(roleFilter.value);
        renderConfig();
      });
    }
  }
  let degraded = false;
  try {
    const ptlRes = await fetch("/api/config/ptl", { credentials: "same-origin" });
    if (ptlRes.ok) configVm.ingestPtl((await ptlRes.json()).items ?? []);
    else degraded = true;
  } catch {
    degraded = true;
  }
  try {
    const pthRes = await fetch("/api/config/pth", { credentials: "same-origin" });
    if (pthRes.ok) configVm.ingestPth((await pthRes.json()).items ?? []);
    else degraded = true;
  } catch {
    degraded = true;
  }
  try {
    const rolesRes = await fetch("/api/roles", { credentials: "same-origin" });
    if (rolesRes.ok) {
      const payload = await rolesRes.json();
      configVm.ingestRoles(Array.isArray(payload) ? payload : payload?.items ?? []);
    } else degraded = true;
  } catch {
    degraded = true;
  }
  configVm.markDegraded(degraded);
  renderConfig();
}

async function ensureWorkLoaded() {
  if (work.loaded || !state.csrfToken) return;
  const root = document.getElementById("page-work");
  if (!root) return;
  try {
    const data = await api("/api/work/actions");
    work.actions = Array.isArray(data.actions) ? data.actions : [];
    work.tenant = data.tenant ?? null;
    work.space = data.space ?? null;
    work.loaded = true;
    renderWorkPage();
  } catch (err) {
    const placeholder = root.querySelector(".placeholder");
    if (placeholder) placeholder.textContent = `Work 通道不可用：${err.message}`;
  }
}

function renderWorkPage() {
  const root = document.getElementById("page-work");
  if (!root) return;
  root.replaceChildren();
  root.appendChild(createEl("h1", "Work"));
  root.appendChild(createEl("p", `操作上下文 tenant=${work.tenant} space=${work.space}（服务端盖章，不可在表单中修改）。`));

  const modes = ["run", "intake", "optimize"];
  const tabs = createEl("div");
  tabs.className = "work-tabs";
  const panels = createEl("div");
  panels.className = "work-panels";

  for (const mode of modes) {
    const actions = work.actions.filter((a) => a.mode === mode);
    const tab = createEl("button", `${mode}（${actions.length}）`);
    tab.type = "button";
    tab.className = "work-tab";
    tab.dataset.mode = mode;
    tab.addEventListener("click", () => {
      for (const t of tabs.querySelectorAll(".work-tab")) t.classList.toggle("active", t === tab);
      renderModePanel(panels, mode, actions);
    });
    tabs.appendChild(tab);
  }
  root.appendChild(tabs);
  root.appendChild(panels);
  const first = tabs.querySelector(".work-tab");
  if (first) first.click();
}

function renderModePanel(panels, mode, actions) {
  panels.replaceChildren();
  if (actions.length === 0) {
    panels.appendChild(createEl("p", `${mode} 模式没有已登记的原生动作。`));
    return;
  }
  const list = createEl("div");
  list.className = "work-action-list";
  for (const action of actions) {
    const btn = createEl("button", `${action.action} — ${action.descriptor.title}`);
    btn.type = "button";
    btn.className = "work-action-item";
    btn.addEventListener("click", () => {
      for (const b of list.querySelectorAll(".work-action-item")) b.classList.toggle("active", b === btn);
      renderActionForm(panels, action);
    });
    list.appendChild(btn);
  }
  panels.appendChild(list);
  const formHost = createEl("div");
  formHost.className = "work-form-host";
  panels.appendChild(formHost);
}

function renderActionForm(panels, action) {
  stopPolling();
  work.selectedAction = action;
  work.preview = null;
  const host = panels.querySelector(".work-form-host");
  if (!host) return;
  host.replaceChildren();

  const form = createEl("form");
  form.className = "work-form";
  form.noValidate = true;
  form.appendChild(createEl("h2", action.descriptor.title));
  if (action.descriptor.description) {
    const desc = createEl("p", action.descriptor.description);
    desc.className = "work-desc";
    form.appendChild(desc);
  }

  const inputs = new Map();
  for (const field of action.descriptor.fields ?? []) {
    const label = createEl("label", `${field.name}${field.required ? " *" : ""}`);
    label.className = "work-field";
    let control;
    if (field.type === "boolean") {
      control = createEl("input");
      control.type = "checkbox";
    } else if (field.type === "number") {
      control = createEl("input");
      control.type = "number";
      control.step = "1";
    } else if (field.type === "object" || field.type === "array") {
      control = createEl("textarea");
      control.rows = 3;
      control.placeholder = field.type === "array" ? '["a","b"]' : '{"k":"v"}';
    } else {
      control = createEl("input");
      control.type = "text";
    }
    control.name = field.name;
    if (field.description) {
      const hint = createEl("span", field.description);
      hint.className = "work-field-hint";
      label.appendChild(control);
      label.appendChild(hint);
    } else {
      label.appendChild(control);
    }
    inputs.set(field.name, { field, control });
    form.appendChild(label);
  }

  const previewBtn = createEl("button", "生成预览");
  previewBtn.type = "submit";
  previewBtn.className = "work-preview-btn";
  form.appendChild(previewBtn);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void doPreview(action, inputs, host);
  });
  host.appendChild(form);
}

function collectInput(inputs) {
  const out = {};
  for (const [name, { field, control }] of inputs) {
    const raw = field.type === "boolean" ? control.checked : control.value;
    if (field.type === "boolean") {
      if (raw) out[name] = true;
      continue;
    }
    const text = String(raw).trim();
    if (text === "") continue;
    if (field.type === "number") {
      const n = Number(text);
      if (!Number.isFinite(n)) throw new Error(`字段 ${name} 需要有限数字`);
      out[name] = n;
    } else if (field.type === "object" || field.type === "array") {
      let parsed;
      try { parsed = JSON.parse(text); } catch { throw new Error(`字段 ${name} 需要合法 JSON`); }
      out[name] = parsed;
    } else {
      out[name] = text;
    }
  }
  return out;
}

async function doPreview(action, inputs, host) {
  stopPolling();
  const old = host.querySelector(".work-preview-panel");
  if (old) old.remove();
  let input;
  try {
    input = collectInput(inputs);
  } catch (err) {
    renderError(host, err.message);
    return;
  }
  try {
    const data = await api("/api/work/preview", {
      method: "POST",
      body: JSON.stringify({ mode: action.mode, action: action.action, input }),
    });
    work.preview = data.preview;
    renderPreviewPanel(host, action, data);
  } catch (err) {
    renderError(host, `预览被拒绝：${err.message}`);
  }
}

function renderError(host, message) {
  const box = createEl("p", message);
  box.className = "work-error";
  host.appendChild(box);
}

function renderPreviewPanel(host, action, data) {
  const preview = data.preview;
  const panel = createEl("div");
  panel.className = "work-preview-panel";
  panel.appendChild(createEl("h2", "确认预览"));

  const facts = createEl("dl");
  facts.className = "work-facts";
  const addFact = (k, v) => {
    facts.appendChild(createEl("dt", k));
    facts.appendChild(createEl("dd", v));
  };
  addFact("tenant / space", `${data.tenant} / ${data.space}`);
  addFact("原生目标", preview.nativeTarget);
  addFact("可逆性", preview.impact.reversible ? "可逆" : "不可逆");
  addFact("风险", preview.impact.risk);
  addFact("影响面", preview.impact.scope);
  addFact("过期时间", `${preview.expiresAt}（过期后需重新预览）`);
  addFact("digest", preview.previewDigest);
  panel.appendChild(facts);

  const summaryTitle = createEl("h3", "归一化摘要");
  panel.appendChild(summaryTitle);
  const summary = createEl("ul");
  for (const line of preview.summary ?? []) summary.appendChild(createEl("li", line));
  panel.appendChild(summary);

  const normalized = createEl("pre", JSON.stringify(preview.normalizedInput, null, 2));
  normalized.className = "work-normalized";
  panel.appendChild(normalized);

  // ── 确认区：高风险需输入动作标签；确认按钮永远不是初始焦点 ──
  const confirmBox = createEl("div");
  confirmBox.className = "work-confirm";
  const confirmBtn = createEl("button", `确认提交 ${action.action}`);
  confirmBtn.type = "button";
  confirmBtn.className = "work-confirm-btn";
  const cancelBtn = createEl("button", "取消");
  cancelBtn.type = "button";
  cancelBtn.className = "work-cancel-btn";

  if (preview.impact.risk === "high") {
    confirmBtn.disabled = true;
    const typeLabel = createEl("label", `高风险操作：请输入动作标签 ${action.action} 以启用确认`);
    typeLabel.className = "work-field";
    const typeInput = createEl("input");
    typeInput.type = "text";
    typeInput.autocomplete = "off";
    typeInput.addEventListener("input", () => {
      confirmBtn.disabled = typeInput.value !== action.action;
    });
    typeLabel.appendChild(typeInput);
    confirmBox.appendChild(typeLabel);
  }

  confirmBtn.addEventListener("click", () => void doSubmit(host, action, preview, panel));
  cancelBtn.addEventListener("click", () => {
    panel.remove();
    work.preview = null;
  });
  confirmBox.appendChild(cancelBtn);
  confirmBox.appendChild(confirmBtn);
  panel.appendChild(confirmBox);
  host.appendChild(panel);
  // 初始焦点落在「取消」——确认按钮不能是默认焦点
  cancelBtn.focus();
}

async function doSubmit(host, action, preview, panel) {
  const idempotencyKey = crypto.randomUUID();
  try {
    const data = await api("/api/work/submit", {
      method: "POST",
      body: JSON.stringify({
        previewId: preview.previewId,
        previewDigest: preview.previewDigest,
        idempotencyKey,
      }),
    });
    panel.remove();
    renderNativeStatus(host, action, data.ref);
  } catch (err) {
    renderError(panel, `提交失败：${err.message}`);
  }
}

function stopPolling() {
  if (work.pollTimer) {
    clearInterval(work.pollTimer);
    work.pollTimer = null;
  }
}

function renderNativeStatus(host, action, ref) {
  stopPolling();
  const box = createEl("div");
  box.className = "work-status";
  box.appendChild(createEl("h2", "原生状态"));
  const refLine = createEl("p", `${ref.mode}/${ref.kind} ${ref.id}（tenant=${ref.tenantId}，submittedAt=${ref.submittedAt}）`);
  box.appendChild(refLine);
  const statusLine = createEl("p", "状态：加载中…");
  box.appendChild(statusLine);

  const evalBtn = createEl("button", "评估验收");
  evalBtn.type = "button";
  const evidenceBox = createEl("pre");
  evidenceBox.className = "work-normalized";
  evalBtn.addEventListener("click", async () => {
    try {
      const data = await api("/api/work/evaluate", {
        method: "POST",
        body: JSON.stringify({ mode: ref.mode, kind: ref.kind, id: ref.id, submittedAt: ref.submittedAt }),
      });
      const a = data.acceptance;
      evidenceBox.textContent = JSON.stringify(
        { accepted: a.accepted, evidence: a.evidence }, null, 2,
      );
    } catch (err) {
      evidenceBox.textContent = `验收查询失败：${err.message}`;
    }
  });
  box.appendChild(evalBtn);
  box.appendChild(evidenceBox);
  host.appendChild(box);

  const poll = async () => {
    try {
      const data = await api(
        `/api/work/native/${encodeURIComponent(ref.kind)}/${encodeURIComponent(ref.id)}?mode=${encodeURIComponent(ref.mode)}`,
      );
      statusLine.textContent = `状态：${data.projection.status}（observedAt=${data.projection.observedAt}）`;
    } catch (err) {
      statusLine.textContent = `状态查询失败：${err.message}`;
    }
  };
  void poll();
  work.pollTimer = setInterval(() => void poll(), 2000);
}

// ─── bootstrap ───

function renderBootstrapError(message) {
  setSessionState("未连接");
  const root = document.getElementById("page-overview");
  if (!root) return;
  const notice = createEl("p", message);
  notice.className = "placeholder";
  root.appendChild(notice);
}

function initOverview() {
  const root = document.getElementById("page-overview");
  if (!root) return;

  const placeholder = root.querySelector(".placeholder");
  if (placeholder) placeholder.remove();

  const status = createEl("div");
  status.id = "overview-degraded";
  status.className = "overview-banner";
  status.hidden = true;

  const statusText = createEl("span", "N30 不可用：只读观测数据源连接失败。");
  status.appendChild(statusText);

  const retry = createEl("button", "重试");
  retry.id = "overview-retry";
  retry.type = "button";
  retry.className = "btn";
  status.appendChild(retry);

  const iframe = document.createElement("iframe");
  iframe.id = "overview-embed";
  iframe.className = "overview-embed";
  iframe.src = N30_EMBED_URL;
  iframe.title = "N30 运行观测台";
  iframe.loading = "lazy";

  const freshness = createEl("span");
  freshness.id = "overview-freshness";
  freshness.className = "overview-freshness";

  root.appendChild(status);
  root.appendChild(iframe);
  root.appendChild(freshness);

  retry.addEventListener("click", () => {
    iframe.src = N30_EMBED_URL;
    void refreshOverview(status, freshness, iframe);
  });

  void refreshOverview(status, freshness, iframe);
}

function formatSourceFreshness(snapshot) {
  if (!snapshot || typeof snapshot.collectedAt !== "number") return "数据时间 —";
  const time = new Date(snapshot.collectedAt).toLocaleTimeString();
  const sources = Array.isArray(snapshot.sources) ? snapshot.sources : [];
  if (sources.length === 0) return `数据时间 ${time}`;
  const fresh = sources.filter((s) => s && s.state === "fresh").length;
  return `数据时间 ${time} · ${fresh}/${sources.length} 来源 fresh`;
}

async function refreshOverview(status, freshness, iframe) {
  status.hidden = true;
  freshness.textContent = "连接 N30…";
  try {
    const res = await fetch("/observe/snapshot", {
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const snapshot = await res.json();
    freshness.textContent = formatSourceFreshness(snapshot);
    status.hidden = true;
  } catch {
    status.hidden = false;
    freshness.textContent = "N30 不可用：只读观测数据源连接失败。";
    void iframe;
  }
}

async function bootstrapFromFragment() {
  bindNav();

  const match = /^#([0-9a-f]{64})$/.exec(window.location.hash);
  if (!match) {
    renderBootstrapError("缺少或无效的一次性 bootstrap token，请从 ptl operator 打印的链接重新打开。");
    return;
  }
  const token = match[1];

  let res;
  try {
    res = await fetch("/api/session/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
  } catch (err) {
    renderBootstrapError(`bootstrap 请求失败：${String(err)}`);
    return;
  }

  if (!res.ok) {
    renderBootstrapError(`bootstrap 被拒绝（HTTP ${res.status}）：一次性 token 可能已使用或过期。`);
    return;
  }

  let payload;
  try {
    payload = await res.json();
  } catch {
    renderBootstrapError("bootstrap 响应不是有效 JSON。");
    return;
  }

  state.csrfToken = payload.csrfToken ?? null;
  state.operatorPrincipalId = payload.operatorPrincipalId ?? null;

  // 兑换成功后立即清除 URL fragment 中的一次性 token
  history.replaceState(null, "", "/#/overview");
  setSessionState(`已连接：${state.operatorPrincipalId}`);
  switchPage("overview");
  initOverview();
}

bootstrapFromFragment();
