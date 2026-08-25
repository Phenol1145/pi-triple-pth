/**
 * config/env-file.ts —— .env / .env.pth.secrets 解析（纯函数）。
 *
 * 供 CLI runtime-secrets 与 pth-console launcher 共用，避免两处维护同一解析逻辑。
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    const value = withoutExport.slice(eq + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}
