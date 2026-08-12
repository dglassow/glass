#!/usr/bin/env bash
# Assemble a SELF-CONTAINED backend for the distributed desktop app: the node
# services (pnpm-deployed with a flat node_modules incl. node-pty's native
# prebuild), the launcher, and a PORTABLE official node binary. Output lands in
# src-tauri/backend/ and is bundled into Glass.app/Contents/Resources/backend/.
#
# Run before `tauri build` for a distributable app:  ./bundle-backend.sh
set -euo pipefail
cd "$(dirname "$0")"                      # packages/desktop
REPO="$(cd ../.. && pwd)"
OUT="$PWD/src-tauri/backend"
NODE_VER="v25.6.1"                        # matches dev; node-pty prebuilds are N-API (version-agnostic)
CACHE="$PWD/.node-cache"

echo "bundle-backend: pnpm deploy (hoisted) → $OUT"
rm -rf "$OUT"
# node-linker=hoisted makes a FLAT node_modules of real files (no .pnpm
# symlinks), which survives Tauri's resource copy into the .app.
( cd "$REPO" && pnpm --filter @glass/backend-bundle --node-linker=hoisted deploy --prod "$OUT" >/dev/null )
cp "$REPO/deploy/glass-backend.mjs" "$OUT/glass-backend.mjs"

# Portable node (official build links only /System + /usr/lib), cached.
NODE_TGZ="$CACHE/node-$NODE_VER-darwin-arm64.tar.gz"
if [ ! -f "$CACHE/node" ]; then
  mkdir -p "$CACHE"
  echo "bundle-backend: fetching official node $NODE_VER (portable)"
  curl -fsSL -o "$NODE_TGZ" "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-darwin-arm64.tar.gz"
  tar xzf "$NODE_TGZ" -C "$CACHE"
  cp "$CACHE/node-$NODE_VER-darwin-arm64/bin/node" "$CACHE/node"
  rm -rf "$CACHE/node-$NODE_VER-darwin-arm64" "$NODE_TGZ"
fi
cp "$CACHE/node" "$OUT/node"
chmod +x "$OUT/node"

echo "bundle-backend: done ($(du -sh "$OUT" | cut -f1)) — node $("$OUT/node" -v)"
