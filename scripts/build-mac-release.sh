#!/bin/bash
# Build, sign, notarize and staple the macOS shapes.inc Bridge app, then zip it
# as the GitHub release asset the installer downloads (SIGNED_APP_URL in
# src/service.js). Run on a Mac with the Circle Labs Developer ID certificate
# and a notarytool keychain profile.
#
#   scripts/build-mac-release.sh            # dist/shapes.inc-Bridge-macos.zip
#   NODE_VERSION=v22.23.4 scripts/build-mac-release.sh
#
# Environment: SIGNING_IDENTITY, NOTARYTOOL_PROFILE, NODE_VERSION, SKIP_NOTARIZE=1.
set -euo pipefail
cd "$(dirname "$0")/.."

NODE_VERSION="${NODE_VERSION:-v22.23.4}"
SIGNING_IDENTITY="${SIGNING_IDENTITY:-Developer ID Application: Circle Labs, Inc. (GMW3D75476)}"
NOTARYTOOL_PROFILE="${NOTARYTOOL_PROFILE:-notarytool-profile}"
APP_NAME="shapes.inc Bridge"
DIST="$PWD/dist"
CACHE="${NODE_CACHE_DIR:-$HOME/.cache/shapes-bridge-node}"
mkdir -p "$DIST" "$CACHE"
rm -rf "$DIST/$APP_NAME.app" "$DIST/shapes.inc-Bridge-macos.zip"

echo "==> Node $NODE_VERSION (arm64 + x64 → universal)"
for arch in arm64 x64; do
  tarball="$CACHE/node-$NODE_VERSION-darwin-$arch.tar.gz"
  [ -s "$tarball" ] || curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-darwin-$arch.tar.gz" -o "$tarball"
  mkdir -p "$CACHE/$arch"
  tar -xzf "$tarball" -C "$CACHE/$arch" --strip-components=2 "node-$NODE_VERSION-darwin-$arch/bin/node"
done
# Verify against the published checksums before we sign anything.
curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" -o "$CACHE/SHASUMS256-$NODE_VERSION.txt"
for arch in arm64 x64; do
  expected=$(grep "node-$NODE_VERSION-darwin-$arch.tar.gz" "$CACHE/SHASUMS256-$NODE_VERSION.txt" | awk '{print $1}')
  actual=$(shasum -a 256 "$CACHE/node-$NODE_VERSION-darwin-$arch.tar.gz" | awk '{print $1}')
  [ "$expected" = "$actual" ] || { echo "checksum mismatch for $arch"; exit 1; }
done
lipo -create "$CACHE/arm64/node" "$CACHE/x64/node" -output "$CACHE/node-universal"
chmod 755 "$CACHE/node-universal"

echo "==> Build native connection controls and launcher"
for arch in arm64 x86_64; do
  xcrun clang -arch "$arch" -mmacosx-version-min=11.0 scripts/mac/launcher.c -o "$CACHE/launcher-$arch"
  xcrun swiftc -target "$arch-apple-macosx11.0" scripts/mac/controls.swift -o "$CACHE/controls-$arch"
done
lipo -create "$CACHE/launcher-arm64" "$CACHE/launcher-x86_64" -output "$CACHE/launcher-universal"
lipo -create "$CACHE/controls-arm64" "$CACHE/controls-x86_64" -output "$CACHE/controls-universal"

# Pin both release and SHA-256. Runtime setup never fetches executable code.
CLOUDFLARED_VERSION=2026.10.6
for arch in arm64 amd64; do
  if [ "$arch" = arm64 ]; then
    expected=ea1e5105d35bbe16cee5b2f7b4742059ada341fbd35938ed827c24b85efa51c8
  else
    expected=6c04a13835ca5ff29a0c6f58d17d1f3956aad1b7df1631f5b5efbc06269deded
  fi
  archive="$CACHE/cloudflared-$CLOUDFLARED_VERSION-$arch.tgz"
  [ -s "$archive" ] || curl -fsSL "https://github.com/cloudflare/cloudflared/releases/download/$CLOUDFLARED_VERSION/cloudflared-darwin-$arch.tgz" -o "$archive"
  actual=$(shasum -a 256 "$archive" | awk '{print $1}')
  [ "$expected" = "$actual" ] || { echo "cloudflared checksum mismatch for $arch"; exit 1; }
  mkdir -p "$CACHE/cloudflared-$arch"
  tar -xzf "$archive" -C "$CACHE/cloudflared-$arch" cloudflared
done
lipo -create "$CACHE/cloudflared-arm64/cloudflared" "$CACHE/cloudflared-amd64/cloudflared" -output "$CACHE/cloudflared-universal"

echo "==> Assemble"
node scripts/assemble-mac-app.js --node "$CACHE/node-universal" --out "$DIST/$APP_NAME.app" \
  --launcher "$CACHE/launcher-universal" --controls "$CACHE/controls-universal" --cloudflared "$CACHE/cloudflared-universal"
codesign --remove-signature "$DIST/$APP_NAME.app/Contents/MacOS/$APP_NAME Runtime" 2>/dev/null || true

echo "==> Sign (hardened runtime)"
for executable in "$APP_NAME Controls" cloudflared; do
  codesign --force --timestamp --options runtime --sign "$SIGNING_IDENTITY" "$DIST/$APP_NAME.app/Contents/MacOS/$executable"
done
codesign --force --timestamp --options runtime \
  --entitlements scripts/mac/runtime.entitlements \
  --identifier inc.shapes.bridge.runtime \
  --sign "$SIGNING_IDENTITY" "$DIST/$APP_NAME.app/Contents/MacOS/$APP_NAME Runtime"
codesign --force --timestamp --options runtime \
  --entitlements scripts/mac/launcher.entitlements \
  --identifier inc.shapes.bridge \
  --sign "$SIGNING_IDENTITY" "$DIST/$APP_NAME.app"
codesign --verify --deep --strict --verbose=2 "$DIST/$APP_NAME.app"

if [ "${SKIP_NOTARIZE:-0}" != "1" ]; then
  echo "==> Notarize"
  ditto -c -k --keepParent "$DIST/$APP_NAME.app" "$DIST/notarize-upload.zip"
  xcrun notarytool submit "$DIST/notarize-upload.zip" --keychain-profile "$NOTARYTOOL_PROFILE" --wait
  rm -f "$DIST/notarize-upload.zip"
  xcrun stapler staple "$DIST/$APP_NAME.app"
  spctl --assess --type execute --verbose=2 "$DIST/$APP_NAME.app"
fi

echo "==> Package"
ditto -c -k --keepParent "$DIST/$APP_NAME.app" "$DIST/shapes.inc-Bridge-macos.zip"
shasum -a 256 "$DIST/shapes.inc-Bridge-macos.zip" | tee "$DIST/shapes.inc-Bridge-macos.zip.sha256"
echo "Release asset: $DIST/shapes.inc-Bridge-macos.zip"
