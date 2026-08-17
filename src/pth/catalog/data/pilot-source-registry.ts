/**
 * catalog/data/pilot-source-registry.ts — N23 K5 评测批：双域 source registry。
 *
 * F4 6.4：
 *  - registryFingerprint = sha256(uri|version|authority)（version 缺省按空串参与，原 contentHash 改名）；
 *  - artifactHash 来自 pilot-source-snapshots.ts（sha256(snapshotContent)），必填；
 *  - seed 写 source entry 的 meta.artifactHash 与 meta.snapshotContent；evaluator 校验一致性。
 */

import { createHash } from "node:crypto";
import { pilotSourceSnapshotBySourceId } from "./pilot-source-snapshots.js";

export interface PilotKnowledgeSource {
  id: string;
  domain: string; // domain id
  authority: string;
  uri: string;
  version?: string;
  retrievedAt: string; // ISO 日期
  license?: string;
  registryFingerprint: string; // sha256(uri|version|authority)
  artifactHash: string; // sha256(snapshotContent)，来自 pilot-source-snapshots
}

export function registryFingerprintOf(uri: string, version: string | undefined, authority: string): string {
  return createHash("sha256").update(`${uri}|${version ?? ""}|${authority}`).digest("hex");
}

function source(args: Omit<PilotKnowledgeSource, "registryFingerprint" | "artifactHash">): PilotKnowledgeSource {
  const snapshot = pilotSourceSnapshotBySourceId(args.id);
  if (!snapshot) {
    throw new Error(`pilot source registry: missing snapshot for source ${args.id}`);
  }
  return {
    ...args,
    registryFingerprint: registryFingerprintOf(args.uri, args.version, args.authority),
    artifactHash: snapshot.artifactHash,
  };
}

export const PILOT_SOURCES: PilotKnowledgeSource[] = [
  source({
    id: "pl-jls",
    domain: "programming-languages",
    authority: "Oracle",
    uri: "https://docs.oracle.com/javase/specs/jls/se23/html/index.html",
    version: "Java SE 23",
    retrievedAt: "2026-08-18",
    license: "Oracle Binary Code License Agreement / GFTC",
  }),
  source({
    id: "pl-rust-reference",
    domain: "programming-languages",
    authority: "Rust Project",
    uri: "https://doc.rust-lang.org/reference/",
    version: "stable",
    retrievedAt: "2026-08-18",
    license: "MIT OR Apache-2.0",
  }),
  source({
    id: "pl-llvm-langref",
    domain: "programming-languages",
    authority: "LLVM Project",
    uri: "https://llvm.org/docs/LangRef.html",
    version: "LLVM 21",
    retrievedAt: "2026-08-18",
    license: "Apache-2.0 WITH LLVM-exception",
  }),
  source({
    id: "pl-cpp-draft",
    domain: "programming-languages",
    authority: "C++ Standards Committee (WG21)",
    uri: "https://eel.is/c++draft/",
    version: "N5001 working draft",
    retrievedAt: "2026-08-18",
    license: "ISO/IEC 14882 working draft",
  }),
  source({
    id: "pl-python-reference",
    domain: "programming-languages",
    authority: "Python Software Foundation",
    uri: "https://docs.python.org/3/reference/index.html",
    version: "3.13",
    retrievedAt: "2026-08-18",
    license: "PSF-2.0",
  }),
  source({
    id: "pl-ecma262",
    domain: "programming-languages",
    authority: "Ecma International",
    uri: "https://tc39.es/ecma262/",
    version: "ECMAScript 2025",
    retrievedAt: "2026-08-18",
    license: "Ecma International",
  }),
  source({
    id: "ms-materials-project",
    domain: "materials-science",
    authority: "Lawrence Berkeley National Laboratory",
    uri: "https://materialsproject.org/",
    version: "2026-08",
    retrievedAt: "2026-08-18",
    license: "CC-BY-4.0",
  }),
  source({
    id: "ms-nomad",
    domain: "materials-science",
    authority: "NOMAD Laboratory / Fritz Haber Institute",
    uri: "https://nomad-lab.eu/",
    version: "2026-08",
    retrievedAt: "2026-08-18",
    license: "CC-BY-4.0 / ODbL",
  }),
  source({
    id: "ms-icsd",
    domain: "materials-science",
    authority: "FIZ Karlsruhe",
    uri: "https://icsd.products.fiz-karlsruhe.de/",
    version: "2026-08",
    retrievedAt: "2026-08-18",
    license: "Proprietary",
  }),
  source({
    id: "ms-aflow",
    domain: "materials-science",
    authority: "Duke University",
    uri: "https://aflow.org/",
    version: "2026-08",
    retrievedAt: "2026-08-18",
    license: "CC-BY-4.0",
  }),
  source({
    id: "ms-cod",
    domain: "materials-science",
    authority: "Crystallography Open Database",
    uri: "https://www.crystallography.net/cod/",
    version: "2026-08",
    retrievedAt: "2026-08-18",
    license: "CC0",
  }),
  source({
    id: "ms-mpcontribs",
    domain: "materials-science",
    authority: "Materials Project",
    uri: "https://mpcontribs.org/",
    version: "2026-08",
    retrievedAt: "2026-08-18",
    license: "CC-BY-4.0",
  }),
];
