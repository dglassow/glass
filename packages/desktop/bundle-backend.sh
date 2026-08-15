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
cp "$REPO/deploy/glassd.mjs" "$OUT/glassd.mjs"

# Keep only the darwin-arm64 node-pty prebuild — the Intel/Windows ones are dead
# weight and would be extra foreign Mach-O binaries to sign for notarization.
find "$OUT" -type d -path '*/node-pty/prebuilds/*' -maxdepth 20 | grep -v 'darwin-arm64' | xargs rm -rf 2>/dev/null || true

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

# Content-free provenance binds the staged runtime to the source commit and
# release stamp. release.sh verifies this again inside Glass.app before any
# artifact is signed or published.
SOURCE_COMMIT="$(git -C "$REPO" rev-parse HEAD)"
SOURCE_DIRTY=false
[ -z "$(git -C "$REPO" status --porcelain --untracked-files=all)" ] || SOURCE_DIRTY=true
RELEASE_VERSION="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version' "$REPO/release.json")"
node - "$OUT" "$SOURCE_COMMIT" "$SOURCE_DIRTY" "$RELEASE_VERSION" <<'JS'
const { createHash } = require("node:crypto");
const { readdirSync, readFileSync, statSync, writeFileSync } = require("node:fs");
const { join, relative } = require("node:path");
const [root, sourceCommit, dirtyText, releaseVersion] = process.argv.slice(2);
const hash = createHash("sha256");
const contentHash = createHash("sha256");
const isMachO = (data) => data.length >= 4 && new Set(["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"]).has(data.subarray(0, 4).toString("hex"));
const visit = (path) => {
  const stat = statSync(path);
  if (stat.isDirectory()) {
    for (const name of readdirSync(path).sort()) visit(join(path, name));
    return;
  }
  if (!stat.isFile() || path === join(root, "provenance.json")) return;
  const name = relative(root, path);
  const data = readFileSync(path);
  hash.update(name);
  hash.update(data);
  // Apple code signing mutates Mach-O binaries after assembly. This companion
  // digest covers every non-Mach-O runtime file and remains verifiable inside
  // the final signed app.
  if (!isMachO(data)) {
    contentHash.update(name);
    contentHash.update(data);
  }
};
visit(root);
writeFileSync(join(root, "provenance.json"), JSON.stringify({
  v: 1,
  sourceCommit,
  sourceDirty: dirtyText === "true",
  releaseVersion,
  runtimeDigest: hash.digest("hex"),
  runtimeContentDigest: contentHash.digest("hex"),
}, null, 2) + "\n", { mode: 0o600 });
JS

echo "bundle-backend: done ($(du -sh "$OUT" | cut -f1)) — node $("$OUT/node" -v)"
