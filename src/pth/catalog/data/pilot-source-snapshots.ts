/**
 * catalog/data/pilot-source-snapshots.ts — F4 6.4：双域 source 权威摘录快照。
 *
 * 每个 sourceId 一条 1–2 句人工可复核摘录；artifactHash = contentHashOf(snapshotContent)
 * （sha256 hex）。seed 写 source entry 的 meta.artifactHash 与 meta.snapshotContent；
 * evaluator 校验 source.artifactHash 与 snapshot 内容一致，缺失/漂移 fail-closed。
 */

import { contentHashOf } from "@away_from/pth-memory";

export interface PilotSourceSnapshot {
  sourceId: string;
  snapshotContent: string;
  artifactHash: string;
}

export function artifactHashOf(snapshotContent: string): string {
  return contentHashOf(snapshotContent);
}

function snap(sourceId: string, snapshotContent: string): PilotSourceSnapshot {
  return { sourceId, snapshotContent, artifactHash: artifactHashOf(snapshotContent) };
}

export const PILOT_SOURCE_SNAPSHOTS: PilotSourceSnapshot[] = [
  snap(
    "pl-jls",
    "The Java Language Specification defines compile-time checking of variables and types, including the rules a compiler must enforce before execution.",
  ),
  snap(
    "pl-rust-reference",
    "The Rust Reference specifies the type system and compile-time checks that the Rust compiler performs, and describes the MIR intermediate representation used for analysis.",
  ),
  snap(
    "pl-llvm-langref",
    "The LLVM Language Reference describes the structure of LLVM IR and the code generation conventions used by the LLVM compiler backend.",
  ),
  snap(
    "pl-cpp-draft",
    "The C++ working draft defines the application binary interface and the memory model, including happens-before and data race rules.",
  ),
  snap(
    "pl-python-reference",
    "The Python Language Reference describes the language's compilation phases and the relationship between the reference and the standard library.",
  ),
  snap(
    "pl-ecma262",
    "ECMA-262 defines the ECMAScript language specification, including static and runtime semantics clauses that govern program behavior.",
  ),
  snap(
    "ms-materials-project",
    "The Materials Project provides computed materials data including ionic conductivity, band gaps, phase diagrams, and interface reaction data for solid-state electrolyte screening.",
  ),
  snap(
    "ms-nomad",
    "NOMAD stores materials science datasets including ionic conductivity, activation energy, thermal stability, transport properties, and electrochemical impedance spectroscopy.",
  ),
  snap(
    "ms-icsd",
    "ICSD is the crystallographic database for inorganic crystal structures, providing records used to identify diffusion channels in solid electrolytes.",
  ),
  snap(
    "ms-aflow",
    "AFLOW provides high-throughput computed materials data including crystal prototypes, migration barriers, and elastic properties.",
  ),
  snap(
    "ms-cod",
    "The Crystallography Open Database offers open-access crystal structure records for inorganic and organic crystalline materials.",
  ),
  snap(
    "ms-mpcontribs",
    "MPContribs is the Materials Project contribution platform that aggregates community-contributed materials datasets and metadata.",
  ),
];

export function pilotSourceSnapshotBySourceId(sourceId: string): PilotSourceSnapshot | undefined {
  return PILOT_SOURCE_SNAPSHOTS.find((snapshot) => snapshot.sourceId === sourceId);
}
