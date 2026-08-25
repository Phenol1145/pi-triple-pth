#!/usr/bin/env tsx
/**
 * scripts/check/check-tce-coverage.ts —— TCE W5：工具/能力契约覆盖静态校验。
 *
 * 规则：
 *  - 每个 PTC_TOOL_DEFS 条目必须有 PTC_CAPABILITIES 契约（含 toolSchema）；
 *  - 每个带 toolSchema 的 PTC_CAPABILITIES 条目必须在 PTC_TOOL_DEFS 中（消除双源漂移）；
 *  - 每个 AGENT_TOOLS 执行器键必须有 PTC_CAPABILITIES 契约（动作工具面全部进入能力契约）。
 *
 * 用法：npm run check:tce-coverage
 */

import { PTC_TOOL_DEFS, PTC_CAPABILITIES } from "@away_from/pth-kernel-interpreter";
import { AGENT_TOOLS } from "@away_from/pth-kernel-execution";

const issues: string[] = [];

for (const def of PTC_TOOL_DEFS) {
  const cap = PTC_CAPABILITIES[def.name];
  if (!cap) {
    issues.push(`PTC_TOOL_DEFS 条目 ${def.name} 缺少 PTC_CAPABILITIES 契约`);
  } else if (!cap.toolSchema) {
    issues.push(`PTC_TOOL_DEFS 条目 ${def.name} 的契约缺少 toolSchema`);
  }
}

for (const [name, cap] of Object.entries(PTC_CAPABILITIES)) {
  if (!cap.toolSchema) continue;
  if (!PTC_TOOL_DEFS.some((d) => d.name === name)) {
    issues.push(`PTC_CAPABILITIES 条目 ${name} 带 toolSchema 但不在 PTC_TOOL_DEFS`);
  }
}

for (const key of Object.keys(AGENT_TOOLS)) {
  if (!PTC_CAPABILITIES[key]) {
    issues.push(`AGENT_TOOLS 执行器 ${key} 缺少 PTC_CAPABILITIES 契约`);
  }
}

if (issues.length > 0) {
  console.error("❌ TCE coverage 校验失败：");
  for (const issue of issues) console.error(`  - ${issue}`);
  process.exit(1);
}

console.log(`✅ TCE coverage：${PTC_TOOL_DEFS.length} tools · ${Object.keys(PTC_CAPABILITIES).length} capabilities · ${Object.keys(AGENT_TOOLS).length} executors 全部覆盖`);
