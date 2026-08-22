#!/bin/bash
# build-pth-cli-package.sh —— 从根 dist 裁剪 @away_from/pth-cli 发布面。
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PKG="$ROOT/packages/pth-cli"
rm -rf "$PKG/dist" "$PKG/deploy"
mkdir -p "$PKG/dist/pth" "$PKG/dist/cli"
cp -R "$ROOT/dist/cli" "$PKG/dist/"
for d in tools services config contracts; do cp -R "$ROOT/dist/pth/$d" "$PKG/dist/pth/"; done
mkdir -p "$PKG/dist/pth/execution/backends"
for f in local-exec-cli local-exec-server; do
  [ -f "$ROOT/dist/pth/execution/$f.js" ] && cp "$ROOT/dist/pth/execution/$f.js" "$PKG/dist/pth/execution/"
  [ -f "$ROOT/dist/pth/execution/$f.d.ts" ] && cp "$ROOT/dist/pth/execution/$f.d.ts" "$PKG/dist/pth/execution/"
done
cp "$ROOT/dist/pth/execution/backends/local-spawn-backend.js" "$PKG/dist/pth/execution/backends/" 2>/dev/null || true
cp "$ROOT/dist/pth/execution/backends/local-spawn-backend.d.ts" "$PKG/dist/pth/execution/backends/" 2>/dev/null || true
mkdir -p "$PKG/deploy"
rsync -a --exclude '.env.pth.secrets' --exclude '.env.pth.secrets.example' "$ROOT/deploy/" "$PKG/deploy/"
echo "pth-cli package prepared: $PKG"
