#!/usr/bin/env bash
# Deep-sign Glass.app with the owner's Developer ID (inside-out: the bundled
# node + node-pty's native binaries, then the app), then notarize + staple a
# distributable .dmg. Notarization uses the `glass-notary` Keychain profile, so
# NO secret appears in any command here.
#
# Prereqs: Developer ID Application cert in the login Keychain; the glass-notary
# notarytool profile (xcrun notarytool store-credentials …). Run after building:
#   ./bundle-backend.sh && (GLASS_HOME=<repo> tauri build) && ./sign-and-notarize.sh
set -euo pipefail
cd "$(dirname "$0")"
APP="${1:-src-tauri/target/release/bundle/macos/Glass.app}"
OUTDMG="${2:-$PWD/Glass.dmg}"
# Developer ID from env, else the first one in the login Keychain — so no
# account-specific name is hard-coded in the repo.
ID="${APPLE_SIGNING_IDENTITY:-$(security find-identity -v -p codesigning | awk -F'"' '/Developer ID Application/{print $2; exit}')}"
ENT="$PWD/entitlements.plist"
PROFILE="${GLASS_NOTARY_PROFILE:-glass-notary}"

[ -d "$APP" ] || { echo "no app at $APP — build it first"; exit 1; }
[ -n "$ID" ] || { echo "no 'Developer ID Application' identity in the Keychain"; exit 1; }
echo "signing identity: $ID"

echo "› signing nested backend binaries (inside-out)"
# node-pty's helper + native addon (arm64 only after the prune)
find "$APP/Contents/Resources/backend" \( -name 'spawn-helper' -o -name '*.node' \) -type f -print0 |
  while IFS= read -r -d '' bin; do
    codesign --force --timestamp --options runtime --sign "$ID" "$bin"
  done
# the node binary needs the JIT / library-loading entitlements
codesign --force --timestamp --options runtime --entitlements "$ENT" --sign "$ID" "$APP/Contents/Resources/backend/node"

echo "› signing the app bundle"
codesign --force --timestamp --options runtime --entitlements "$ENT" --sign "$ID" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"
echo "  codesign verify: OK"

echo "› notarizing the app"
ZIP="$(mktemp -d)/Glass.zip"
ditto -c -k --keepParent "$APP" "$ZIP"
xcrun notarytool submit "$ZIP" --keychain-profile "$PROFILE" --wait
xcrun stapler staple "$APP"
echo "  app stapled"

echo "› building + signing the dmg"
rm -f "$OUTDMG"
STAGE="$(mktemp -d)"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Glass" -srcfolder "$STAGE" -ov -format UDZO "$OUTDMG" >/dev/null
rm -rf "$STAGE"
codesign --force --timestamp --sign "$ID" "$OUTDMG"

echo "› notarizing the dmg"
xcrun notarytool submit "$OUTDMG" --keychain-profile "$PROFILE" --wait
xcrun stapler staple "$OUTDMG"

echo "✓ done — $OUTDMG"
spctl -a -vvv --type install "$OUTDMG" 2>&1 | head -4 || true
