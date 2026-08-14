#!/usr/bin/env bash
# Release helper for Glass. Two steps, run on the Mac that builds the app:
#
#   ./release.sh bump 0.1.5     # sync the version into every release-stamped file
#   (commit, sign the tag, build: bundle-backend.sh && tauri build && sign-and-notarize.sh)
#   ./release.sh package        # tarball + sign + manifest + publish to ~/.glass/updates
#
# `package` exists because the by-hand version shipped broken twice: plain macOS
# tar embeds AppleDouble (._*) sidecar entries that Tauri's Rust unpacker chokes
# on, and Apple tar *hides* them again on `tar tzf`, so the defect is invisible
# to casual inspection. Every guard in here corresponds to a real failure:
#   - COPYFILE_DISABLE + raw-stream ._ check   (v0.1.3/v0.1.4 bricked updates)
#   - version cross-check across all stamps    (stale Cargo version once
#     poisoned the anti-rollback reconcile)
#   - minisign verify against the app's pubkey (catches signing with the wrong key)
#
# No instance config lives here: the artifact URL is derived from the updater
# endpoint already baked into tauri.conf.json (the documented exception).
set -euo pipefail
cd "$(dirname "$0")"

TAURI_CONF=packages/desktop/src-tauri/tauri.conf.json
CARGO_TOML=packages/desktop/src-tauri/Cargo.toml
UPDATER_KEY="${GLASS_UPDATER_KEY:-$HOME/.glass/updater.key}"
UPDATES_DIR="${GLASS_UPDATES_DIR:-$HOME/.glass/updates}"

die() { echo "release.sh: $*" >&2; exit 1; }

json_get() { node -e 'const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=process.argv[2].split(".").reduce((a,k)=>a?.[k],o);if(v==null)process.exit(1);console.log(v)' "$1" "$2"; }

bump() {
  local ver="$1"
  [[ "$ver" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "version must be plain semver (got '$ver')"
  # Rewrite the version field in each JSON without disturbing formatting.
  local f
  for f in release.json "$TAURI_CONF"; do
    node -e '
      const fs=require("fs"),[file,ver]=process.argv.slice(1);
      const src=fs.readFileSync(file,"utf8");
      const out=src.replace(/^(\s*"version":\s*")[0-9.]+(")/m, `$1${ver}$2`);
      if(out===src) { console.error(`no version field rewritten in ${file}`); process.exit(1); }
      fs.writeFileSync(file,out);' "$f" "$ver"
  done
  sed -i '' -E "1,/^version = \"[0-9.]+\"$/ s/^version = \"[0-9.]+\"$/version = \"$ver\"/" "$CARGO_TOML"
  # Keep Cargo.lock's glass-desktop entry in sync — a stale lock version once
  # poisoned the anti-rollback reconcile on every device.
  if command -v cargo >/dev/null; then
    (cd packages/desktop/src-tauri && cargo update --workspace --quiet)
  else
    echo "WARNING: cargo not found — run 'cargo update --workspace' in packages/desktop/src-tauri before committing" >&2
  fi
  check_versions "$ver"
  echo "✓ bumped to $ver — commit, tag with 'git tag -s v$ver', then build + sign-and-notarize + './release.sh package'"
}

# Every place the version is stamped must agree, including the built app if present.
check_versions() {
  local ver="$1" got f
  for f in release.json "$TAURI_CONF"; do
    got="$(json_get "$f" version)"
    [ "$got" = "$ver" ] || die "$f says $got, expected $ver"
  done
  got="$(sed -nE 's/^version = "([0-9.]+)"$/\1/p' "$CARGO_TOML" | head -1)"
  [ "$got" = "$ver" ] || die "$CARGO_TOML says $got, expected $ver"
  echo "  version stamps agree: $ver"
}

package() {
  local app="${1:-packages/desktop/src-tauri/target/release/bundle/macos/Glass.app}"
  [ -d "$app" ] || die "no app at $app — build and sign it first"
  [ -f "$UPDATER_KEY" ] || die "no updater key at $UPDATER_KEY"

  local ver
  ver="$(json_get "$TAURI_CONF" version)"
  check_versions "$ver"
  local built
  built="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$app/Contents/Info.plist")"
  [ "$built" = "$ver" ] || die "built app is $built but the repo says $ver — rebuild before packaging"

  echo "› verifying the app is signed + notarized"
  codesign --verify --deep --strict "$app" || die "codesign verify failed — run sign-and-notarize.sh first"
  xcrun stapler validate "$app" >/dev/null || die "no notarization staple — run sign-and-notarize.sh first"

  echo "› building the update tarball (no Apple metadata)"
  local stage
  stage="$(mktemp -d)"
  trap 'rm -rf "$stage"' EXIT
  local tarball="$stage/Glass.app.tar.gz"
  COPYFILE_DISABLE=1 tar --no-mac-metadata --no-xattrs -czf "$tarball" -C "$(dirname "$app")" "$(basename "$app")"

  # Apple tar hides ._ entries on listing, so inspect the raw stream instead.
  python3 - "$tarball" <<'PY'
import sys, tarfile
bad = [m.name for m in tarfile.open(sys.argv[1]) if m.name.split("/")[-1].startswith("._")]
if bad:
    sys.exit(f"AppleDouble entries in tarball (updater would brick): {bad[:5]} … {len(bad)} total")
print(f"  raw stream clean: 0 AppleDouble entries")
PY

  echo "› signing with the updater key"
  (cd packages/desktop && pnpm --silent tauri signer sign -k "$UPDATER_KEY" "$tarball" >/dev/null)
  [ -f "$tarball.sig" ] || die "tauri signer produced no .sig"

  # Cross-check the signature against the exact pubkey shipped inside the app —
  # a signature from any other key would verify locally but fail on every device.
  node - "$tarball" "$(json_get "$TAURI_CONF" plugins.updater.pubkey)" <<'JS'
const { readFileSync } = require("fs");
const { createHash, verify, createPublicKey } = require("crypto");
const [file, pubB64] = process.argv.slice(2);
const parse = (b64) => { const [, data] = Buffer.from(b64, "base64").toString().trim().split("\n"); return Buffer.from(data, "base64"); };
const pk = parse(pubB64), sig = parse(readFileSync(file + ".sig", "utf8").trim());
if (pk.subarray(0, 2).toString() !== "Ed" || sig.subarray(0, 2).toString() !== "ED") throw new Error("unexpected minisign algorithm");
if (!pk.subarray(2, 10).equals(sig.subarray(2, 10))) throw new Error("signature key id does not match the app's pinned pubkey");
const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pk.subarray(10, 42)]);
const digest = createHash("blake2b512").update(readFileSync(file)).digest();
if (!verify(null, digest, createPublicKey({ key: spki, format: "der", type: "spki" }), sig.subarray(10, 74)))
  throw new Error("signature does not verify against the app's pinned pubkey");
console.log("  minisign signature verifies against the app's pinned pubkey");
JS

  echo "› writing latest.json"
  local endpoint url
  endpoint="$(json_get "$TAURI_CONF" plugins.updater.endpoints.0)"
  url="${endpoint%latest.json}Glass.app.tar.gz"
  node -e '
    const { readFileSync, writeFileSync } = require("fs");
    const [dir, ver, url] = process.argv.slice(1);
    const manifest = { version: ver, pub_date: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      platforms: { "darwin-aarch64": { signature: readFileSync(`${dir}/Glass.app.tar.gz.sig`, "utf8").trim(), url } } };
    writeFileSync(`${dir}/latest.json`, JSON.stringify(manifest, null, 2) + "\n");' "$stage" "$ver" "$url"

  echo "› publishing to $UPDATES_DIR"
  mkdir -p "$UPDATES_DIR"
  if [ -f "$UPDATES_DIR/latest.json" ]; then
    local backup="$UPDATES_DIR-prev-$(json_get "$UPDATES_DIR/latest.json" version)"
    rm -rf "$backup" && mkdir -p "$backup"
    mv "$UPDATES_DIR"/Glass.app.tar.gz "$UPDATES_DIR"/Glass.app.tar.gz.sig "$UPDATES_DIR"/latest.json "$backup/" 2>/dev/null || true
    echo "  previous artifacts moved to $backup"
  fi
  mv "$stage/Glass.app.tar.gz" "$stage/Glass.app.tar.gz.sig" "$stage/latest.json" "$UPDATES_DIR/"
  echo "✓ v$ver published — devices will see it at $url"
}

case "${1:-}" in
  bump)    [ $# -eq 2 ] || die "usage: ./release.sh bump <version>"; bump "$2" ;;
  package) shift; package "$@" ;;
  *)       die "usage: ./release.sh bump <version> | ./release.sh package [Glass.app]" ;;
esac
