#!/usr/bin/env bash
# Release helper for Glass, run on the Mac that builds the app.
#
#   ./release.sh ship 0.1.5     # the whole release, unattended: gate on
#                               # typecheck+tests, bump, release commit, signed
#                               # tag, backend bundle, tauri build, sign +
#                               # notarize, package, publish, push, verify the
#                               # hub is serving it
#
# `ship` never prompts: tag signing rides ssh-agent, notarization the
# glass-notary Keychain profile — so it can run from a remote session with
# nobody at the machine. It is resumable: if the release commit + tag are
# already at HEAD (a previous ship died mid-build), it skips straight to the
# build. Nothing is pushed until the artifacts are published, so a failed build
# never leaves a public tag for a release that doesn't exist.
#
# The pieces remain runnable by hand:
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
  # not `local`: the EXIT trap fires after this function returns, and under
  # set -u an out-of-scope local made cleanup itself the thing that failed
  stage="$(mktemp -d)"
  trap 'rm -rf "${stage:-}"' EXIT
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
  # -f, not -k: -k takes the key as a STRING (a path silently fails to decode);
  # </dev/null so a password-protected key fails loudly instead of prompting
  (cd packages/desktop && pnpm --silent tauri signer sign -f "$UPDATER_KEY" -p "" "$tarball" >/dev/null </dev/null)
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
  # Change notes = commit subjects since the previous release tag. They ride the
  # manifest's `notes` field; the hub pushes them with update.available and the
  # banner's "What's changed" dialog shows them on every device. The bump
  # commits themselves ("release: vX.Y.Z") are elided as noise.
  local endpoint url prev notes
  endpoint="$(json_get "$TAURI_CONF" plugins.updater.endpoints.0)"
  url="${endpoint%latest.json}Glass.app.tar.gz"
  prev="$(git tag --list 'v*' --sort=-v:refname | grep -vx "v$ver" | head -1 || true)"
  notes="$(git log --format='- %s' "${prev:+$prev..}HEAD" | grep -Ev '^- release: v[0-9]+\.[0-9]+\.[0-9]+$' || true)"
  [ -n "$notes" ] && echo "  notes: $(printf '%s\n' "$notes" | wc -l | tr -d ' ') change(s) since ${prev:-the beginning}"
  GLASS_RELEASE_NOTES="$notes" node -e '
    const { readFileSync, writeFileSync } = require("fs");
    const [dir, ver, url] = process.argv.slice(1);
    const notes = (process.env.GLASS_RELEASE_NOTES ?? "").slice(0, 16384);
    const manifest = { version: ver, pub_date: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      ...(notes ? { notes } : {}),
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

ship() {
  local ver="$1"
  [[ "$ver" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "version must be plain semver (got '$ver')"
  [ "$(git branch --show-current)" = "main" ] || die "ship only runs from main"
  git diff-index --quiet HEAD -- || die "working tree has uncommitted changes — commit or stash first"

  # Resume detection: a previous ship that died mid-build left the release
  # commit + signed tag at HEAD. Anything else under an existing tag is a
  # version-reuse mistake and refuses.
  local resuming=0
  if git rev-parse -q --verify "refs/tags/v$ver" >/dev/null; then
    [ "$(git rev-parse "v$ver^{commit}")" = "$(git rev-parse HEAD)" ] \
      || die "tag v$ver already exists and is not at HEAD — versions are never reused, pick the next one"
    check_versions "$ver"
    resuming=1
    echo "› tag v$ver already at HEAD — resuming a previous ship"
  else
    local cur
    cur="$(json_get release.json version)"
    node -e 'const p=s=>s.split(".").map(Number);const[a,b]=[p(process.argv[1]),p(process.argv[2])];for(let i=0;i<3;i++){if(a[i]!==b[i])process.exit(a[i]>b[i]?0:1)};process.exit(1)' "$ver" "$cur" \
      || die "version $ver is not greater than the current $cur — the anti-rollback floor would refuse it"
  fi

  # No prompts allowed later, so prove signing works before touching anything:
  # the tag key must be in ssh-agent, the Developer ID in the Keychain.
  printf 'probe' | ssh-keygen -Y sign -n glass-ship-probe -f "$(git config user.signingkey)" >/dev/null 2>&1 \
    || die "ssh-agent can't sign with $(git config user.signingkey) — tag signing would hang"
  security find-identity -v -p codesigning | grep -q "Developer ID Application" \
    || die "no Developer ID Application identity in the Keychain"

  echo "› typecheck + full test suite"
  pnpm --silent build
  pnpm --silent test

  if [ "$resuming" = 0 ]; then
    echo "› bump + release commit + signed tag"
    bump "$ver"
    git commit -qam "release: v$ver"
    git tag -s "v$ver" -m "Glass v$ver"
  fi

  echo "› bundling backend"
  packages/desktop/bundle-backend.sh
  echo "› tauri build"
  (cd packages/desktop && pnpm --silent tauri build)
  packages/desktop/sign-and-notarize.sh
  package

  echo "› pushing main + v$ver to origin"
  git push -q origin main "v$ver"

  # Done-when: the exact URL devices poll serves the version we just shipped.
  local endpoint served
  endpoint="$(json_get "$TAURI_CONF" plugins.updater.endpoints.0)"
  served="$(curl -fsS --max-time 30 "$endpoint" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).version))')" \
    || die "published + pushed, but $endpoint is unreachable — is the hub/tunnel up?"
  [ "$served" = "$ver" ] || die "hub serves $served, expected $ver — another publisher raced this ship?"
  echo "✓ shipped v$ver — the hub is serving it; devices will show the update banner on their next check"
}

case "${1:-}" in
  bump)    [ $# -eq 2 ] || die "usage: ./release.sh bump <version>"; bump "$2"
           echo "✓ bumped to $2 — commit, tag with 'git tag -s v$2', then build + sign-and-notarize + './release.sh package'" ;;
  package) shift; package "$@" ;;
  ship)    [ $# -eq 2 ] || die "usage: ./release.sh ship <version>"; ship "$2" ;;
  *)       die "usage: ./release.sh ship <version> | ./release.sh bump <version> | ./release.sh package [Glass.app]" ;;
esac
