/**
 * scripts/sign-n29-acceptance.ts —— N29 refix D-5：为验收 envelope 盖上 CI/发布密钥签名。
 *
 * 输入是 `scripts/accept-n29-minimal-intake.ts --output` 生成的**未签名** envelope JSON；
 * 本脚本用 Ed25519 私钥对 canonical envelope payload（排除 signature 字段）做 detached signature，
 * 并写回：
 *  - signingAlgorithm = "ed25519"
 *  - signingKeyId     = 可选审计标识（--key-id，缺省 "ci-release"）
 *  - signature        = base64 detached signature
 *
 * 私钥只从本地文件/环境读取，不进入仓库；公钥由部署配置
 * `PTH_KNOWLEDGE_INTAKE_ACCEPTANCE_PUBLIC_KEY_PATH` 指向，启动时 `assertIntakeFullAcceptance()`
 * 会重新验签。签名算法与 canonical 序列化必须与 `src/pth/bootstrap/intake-mode-gates.ts` 保持一致。
 *
 * 用法：
 *   npx tsx scripts/sign-n29-acceptance.ts \
 *     --input docs/pth/n29-minimal-intake-acceptance.json \
 *     --output docs/pth/n29-minimal-intake-acceptance.signed.json \
 *     --private-key /run/secrets/n29-acceptance-signing.key \
 *     --key-id ci-release
 */

import { readFile, writeFile } from "node:fs/promises";
import { sign } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  ACCEPTANCE_SIGNING_ALGORITHM,
  acceptanceEnvelopeCanonicalBytes,
  type IntakeAcceptanceEnvelopeLike,
} from "../src/pth/bootstrap/intake-mode-gates.js";

function argValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const inputPath = argValue(args, "--input");
  const outputPath = argValue(args, "--output");
  const privateKeyPath = argValue(args, "--private-key") ?? process.env["N29_ACCEPTANCE_SIGNING_KEY"];
  const keyId = argValue(args, "--key-id") ?? "ci-release";

  if (!inputPath || !outputPath || !privateKeyPath) {
    process.stderr.write(
      "用法: npx tsx scripts/sign-n29-acceptance.ts --input <envelope.json> --output <signed.json>"
        + " --private-key <ed25519-private-key.pem> [--key-id <id>]\n",
    );
    process.exitCode = 2;
    return;
  }

  const raw = JSON.parse(await readFile(inputPath, "utf8")) as IntakeAcceptanceEnvelopeLike;
  if (raw.decision !== "MIN_INNER_LOOP_GO") {
    throw new Error(`sign-n29-acceptance: 只给 MIN_INNER_LOOP_GO envelope 签名（当前 ${String(raw.decision)}）`);
  }
  if (raw.signature) {
    throw new Error("sign-n29-acceptance: 输入 envelope 已经带 signature——不要重复签名");
  }

  const privateKeyPem = await readFile(privateKeyPath, "utf8");
  if (!privateKeyPem.includes("PRIVATE KEY")) {
    throw new Error("sign-n29-acceptance: 私钥文件不是 PEM private key");
  }

  const payload: IntakeAcceptanceEnvelopeLike = {
    ...raw,
    signingAlgorithm: ACCEPTANCE_SIGNING_ALGORITHM,
    signingKeyId: keyId,
  };
  const bytes = acceptanceEnvelopeCanonicalBytes(payload);
  const signature = sign(null, bytes, privateKeyPem).toString("base64");
  const signed: IntakeAcceptanceEnvelopeLike = {
    ...payload,
    signature,
  };

  const text = `${JSON.stringify(signed, null, 2)}\n`;
  await writeFile(outputPath, text, "utf8");
  process.stderr.write(`[sign-n29] signed ${outputPath} keyId=${keyId} signatureBytes=${Buffer.byteLength(signature, "utf8")}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[sign-n29] FAIL ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
