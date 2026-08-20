import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import preact from "@preact/preset-vite";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const webRoot = join(packageRoot, "web-src");
const outDir = join(packageRoot, "dist", "operator-console", "public");

function mimeFor(file: string): string {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

function listFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) listFiles(full, out);
    else if (name !== "asset-manifest.json") out.push(relative(outDir, full));
  }
  return out.sort();
}

/**
 * Every Vite build artifact is listed with its digest; the loopback server
 * serves exactly these files and nothing else (fail-closed).
 */
function assetManifestPlugin(): Plugin {
  return {
    name: "operator-console-asset-manifest",
    apply: "build",
    writeBundle() {
      const manifest: Record<string, { path: string; sha256: string; mime: string }> = {};
      for (const rel of listFiles(outDir)) {
        const content = readFileSync(join(outDir, rel));
        manifest[rel] = {
          path: rel,
          sha256: createHash("sha256").update(content).digest("hex"),
          mime: mimeFor(rel),
        };
      }
      writeFileSync(
        join(outDir, "asset-manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
    },
  };
}

export default defineConfig({
  base: "/",
  root: webRoot,
  plugins: [preact(), assetManifestPlugin()],
  build: {
    outDir,
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        entryFileNames: "assets/index.js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: (assetInfo) => {
          const names = assetInfo.names ?? [];
          return names.some((name) => name.endsWith(".css"))
            ? "assets/index.css"
            : "assets/[name][extname]";
        },
      },
    },
  },
});
