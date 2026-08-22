/**
 * contracts/knowledge-fingerprint.ts — 知识查询指纹纯函数（模块化优化 P0/P1）。
 *
 * 该模块不依赖 runner / execution，只负责确定性指纹计算：
 *  - queryFingerprint = FNV-1a 32bit（tenantId|space|roleId|domains(排序)|title|text|catalogVersion
 *    的 \n join）转 8 位 hex；同输入同 catalog 同数据版本 → 同 id；
 *  - workerId 存在时作为独立分量追加在 roleId 后；缺席时旧指纹逐字节不变。
 */

export interface KnowledgeFingerprintInput {
  tenantId: string;
  space: string;
  roleId: string;
  domains: readonly string[];
  title: string;
  text: string;
  catalogVersion: string;
  /** N28 T4：layered 路径 worker 绑定（指纹的独立分量；缺席=旧指纹逐字节不变）。 */
  workerId?: string;
}

/** FNV-1a 32-bit → 8 位 hex 指纹。 */
export function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** §1 指纹函数：tenantId|space|roleId|domains(排序)|title|text|catalogVersion 的 \n join。 */
export function computeKnowledgeQueryFingerprint(input: KnowledgeFingerprintInput): string {
  const domains = [...input.domains].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const base = [
    input.tenantId,
    input.space,
    input.roleId,
    domains.join("\n"),
    input.title,
    input.text,
    input.catalogVersion,
  ].join("\n");
  return fnv1aHex(input.workerId !== undefined ? `${base}\nworker:${input.workerId}` : base);
}
