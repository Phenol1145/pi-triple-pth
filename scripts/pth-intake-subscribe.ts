#!/usr/bin/env node
/**
 * pth-intake-subscribe.ts — N29 Task 6：知识摄入订阅的 ops 入口（plan §4 / §5 Task 6 Step 4）。
 *
 * 唯一职责：
 *  1. 从只读 JSON 路径加载**已由 PTL Human Interface 签名**的 Trust Policy manifest 与公钥 keyring；
 *  2. 经生产 `loadVerifiedTrustPolicy()` 验签（Ed25519 detached signature + canonical digest +
 *     human signer + 有效期），任一不成立即非零退出；
 *  3. 调用同一 application service（`createKnowledgeIntakeSubscriptionService().subscribe()`）
 *     安装已验签 policy 的不可变审计镜像并创建 **probing** SourceSubscription。
 *
 * 硬边界（本脚本**不做**下列任何事）：
 *  - 不签发、不修改、不扩大 Trust Policy（私钥永不进入仓库/镜像/运行环境）；
 *  - 不直接 INSERT/UPDATE 任何表（只经 repository/service 官方方法）；
 *  - 不发布 Task、不入队 outbox、不触发抓取（调度真相是 `Subscription.nextCrawlAt`，
 *    抓取由 due scanner + 生产 drainer 驱动）。
 *
 * 用法（仓库根）：
 *   DATABASE_URL=… npx tsx scripts/pth-intake-subscribe.ts \
 *     --manifest config/pth-trust-policy.json \
 *     --keyring  config/pth-trust-policy-keyring.json \
 *     --space space-a --uri https://docs.example.org/guide/intro --domain mathematics \
 *     [--interval-ms 86400000] [--source-type bounded-html] [--content-type text/html] \
 *     [--license public-domain] [--next-crawl-at 2026-08-20T00:00:00.000Z] [--dry-run]
 *
 * manifest/keyring 路径也可由配置中心提供（`PTH_TRUST_POLICY_MANIFEST` /
 * `PTH_TRUST_POLICY_KEYRING`），命令行参数优先。
 *
 * 退出码：0 = 订阅就绪；非 0 = 验签/授权/安装失败（fail closed，不留半状态）。
 */

import { readFile } from "node:fs/promises";
import { pthConfig } from "@away_from/pth-config";
import { createPgPool } from "@away_from/pth-kernel-storage";
import { applySchema } from "@away_from/pth-kernel-storage";
import { createKnowledgeIntakeRepository } from "@away_from/pth-kernel-storage";
import {
  createKnowledgeIntakeSubscriptionService,
  loadVerifiedTrustPolicy,
  type TrustPolicyKeyring,
} from "../src/pth/execution/knowledge-intake/index.js";
import type { TrustPolicyManifest } from "@away_from/pth-contracts";

const USAGE = `用法：
  npx tsx scripts/pth-intake-subscribe.ts --manifest <path> --keyring <path> \\
      --space <space> --uri <https url> --domain <domainId> [选项]

必填（或由配置中心提供 manifest/keyring 路径）：
  --manifest <path>      已签名 Trust Policy manifest（JSON，只读）
  --keyring <path>       human principal -> PEM 公钥（JSON，只读；不得含私钥）
  --space <space>        订阅所属 space（必须被 manifest 授权）
  --uri <https url>      规范抓取 URI（必须被某条 allow 规则精确覆盖）
  --domain <domainId>    知识域（必须被同一规则的 domains 覆盖）

可选：
  --interval-ms <n>      重爬间隔毫秒（默认 86400000 = 24h）
  --source-type <s>      申报 sourceType（默认 bounded-html）
  --content-type <s>     申报 contentType（默认 text/html）
  --license <s>          申报 license（默认 public-domain）
  --next-crawl-at <iso>  首次 due 时刻（默认 now —— 下一次 due scan 即抓取）
  --database-url <url>   覆盖 DATABASE_URL / PTH_TEST_DATABASE_URL
  --dry-run              只验签 + 授权预检，不安装 policy 镜像、不创建订阅
  -h, --help             打印本帮助`;

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** 极简 `--key value` 解析（不引入 CLI 依赖；未知选项显式失败）。 */
function parseArgs(argv: readonly string[]): { flags: Record<string, string>; bools: Set<string> } {
  const flags: Record<string, string> = {};
  const bools = new Set<string>();
  const BOOLEAN = new Set(["dry-run", "help", "h"]);
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith("--") && token !== "-h") {
      throw new Error(`无法识别的参数：${token}`);
    }
    const name = token.replace(/^--?/, "");
    if (BOOLEAN.has(name)) {
      bools.add(name);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`选项 --${name} 缺少值`);
    }
    flags[name] = value;
    i += 1;
  }
  return { flags, bools };
}

async function readJson(path: string, label: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    throw new Error(`读取${label}失败（${path}）：${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`${label}不是合法 JSON（${path}）：${e instanceof Error ? e.message : String(e)}`);
  }
}

function assertKeyring(value: unknown, path: string): TrustPolicyKeyring {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`keyring 必须是 {principalId: PEM} 对象（${path}）`);
  }
  const out: Record<string, string> = {};
  for (const [principalId, pem] of Object.entries(value as Record<string, unknown>)) {
    if (typeof pem !== "string" || pem.trim() === "") {
      throw new Error(`keyring 项 ${principalId} 必须是非空 PEM 字符串（${path}）`);
    }
    // 纵深防御：私钥永不进入运行环境（loadVerifiedTrustPolicy 也会再拒一次）。
    if (pem.includes("PRIVATE KEY")) {
      throw new Error(`keyring 只允许公钥，检测到私钥材料：${principalId}（${path}）`);
    }
    out[principalId] = pem;
  }
  return out;
}

async function main(): Promise<number> {
  const { flags, bools } = parseArgs(process.argv.slice(2));
  if (bools.has("help") || bools.has("h")) {
    console.log(USAGE);
    return 0;
  }

  const cfg = pthConfig();
  const manifestPath = flags["manifest"] ?? cfg.str("PTH_TRUST_POLICY_MANIFEST");
  const keyringPath = flags["keyring"] ?? cfg.str("PTH_TRUST_POLICY_KEYRING");
  const space = flags["space"];
  const uri = flags["uri"];
  const domainId = flags["domain"];

  const missing = [
    manifestPath ? null : "--manifest（或 PTH_TRUST_POLICY_MANIFEST）",
    keyringPath ? null : "--keyring（或 PTH_TRUST_POLICY_KEYRING）",
    space ? null : "--space",
    uri ? null : "--uri",
    domainId ? null : "--domain",
  ].filter((m): m is string => m !== null);
  if (missing.length > 0) {
    console.error(`缺少必填参数：${missing.join("、")}\n\n${USAGE}`);
    return 2;
  }

  const intervalRaw = flags["interval-ms"];
  const recrawlIntervalMs = intervalRaw === undefined ? DEFAULT_INTERVAL_MS : Number(intervalRaw);
  if (!Number.isFinite(recrawlIntervalMs) || recrawlIntervalMs <= 0) {
    console.error(`--interval-ms 必须是正数（收到 ${String(intervalRaw)}）`);
    return 2;
  }
  const declared = {
    sourceType: flags["source-type"] ?? "bounded-html",
    contentType: flags["content-type"] ?? "text/html",
    license: flags["license"] ?? "public-domain",
  };
  const nextCrawlAt = flags["next-crawl-at"];
  if (nextCrawlAt !== undefined && !Number.isFinite(Date.parse(nextCrawlAt))) {
    console.error(`--next-crawl-at 必须是合法 ISO 时刻（收到 ${nextCrawlAt}）`);
    return 2;
  }

  // ① 验签（唯一授权事实源；脚本永不签发或修改 policy）。
  const manifest = (await readJson(manifestPath, "Trust Policy manifest")) as TrustPolicyManifest;
  const keyring = assertKeyring(await readJson(keyringPath, "keyring"), keyringPath);
  const policy = await loadVerifiedTrustPolicy(manifest, keyring);
  console.log(
    `✔ Trust Policy 已验签：${policy.manifest.policyId}@${policy.manifest.version}`
    + ` tenant=${policy.manifest.tenantId} signer=${policy.manifest.approvedBy.principalId}`
    + ` digest=${policy.manifest.digest}`,
  );

  if (bools.has("dry-run")) {
    // dry-run 也必须真的过一遍双阶段 matcher（不连库、不写任何行）。
    const service = createKnowledgeIntakeSubscriptionService({
      repository: {
        installVerifiedPolicy: async () => {
          throw new Error("dry-run 不得安装 policy 镜像");
        },
        createSubscription: async () => {
          throw new Error("dry-run 不得创建订阅");
        },
      },
      policy,
    });
    try {
      await service.subscribe({
        space: space!,
        canonicalUri: uri!,
        domainId: domainId!,
        recrawlIntervalMs,
        declared,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message.includes("dry-run 不得安装 policy 镜像")) {
        console.log(`✔ dry-run：策略授权预检通过（${uri} @ ${space} / ${domainId}），未写任何行`);
        return 0;
      }
      throw e;
    }
    throw new Error("dry-run 未按预期在安装前中止");
  }

  const databaseUrl =
    flags["database-url"] || cfg.str("PTH_TEST_DATABASE_URL") || process.env.DATABASE_URL || "";
  if (!databaseUrl) {
    console.error("缺少数据库连接串（--database-url / PTH_TEST_DATABASE_URL / DATABASE_URL）");
    return 2;
  }

  const pool = await createPgPool({ connectionString: databaseUrl, max: 2 });
  try {
    await applySchema(pool);
    // 注入验签器（P0-3 approach A）：仓库对未盖章输入自行重新验签；keyring 只读、私钥不入进程。
    const repository = createKnowledgeIntakeRepository(pool, {
      policyVerifier: (candidate) => loadVerifiedTrustPolicy(candidate, keyring),
    });
    // ② 只经官方 application service：安装已验签镜像 + 创建 probing 订阅。
    const service = createKnowledgeIntakeSubscriptionService({ repository, policy });
    const subscription = await service.subscribe({
      space: space!,
      canonicalUri: uri!,
      domainId: domainId!,
      recrawlIntervalMs,
      declared,
      ...(nextCrawlAt === undefined ? {} : { nextCrawlAt }),
    });
    console.log(
      `✔ SourceSubscription 就绪：id=${subscription.id} status=${subscription.status}`
      + ` rule=${subscription.policyRuleId} space=${subscription.space} domain=${subscription.domainId}`
      + ` nextCrawlAt=${subscription.nextCrawlAt} recrawlIntervalMs=${subscription.recrawlIntervalMs}`,
    );
    console.log("提示：抓取由 due scanner（trigger 唤醒）+ 生产 drainer 驱动；本脚本不发布任何 Task。");
    return 0;
  } finally {
    await pool.end();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`✘ intake subscribe 失败（fail closed，未创建订阅）：${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
