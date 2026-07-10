#!/usr/bin/env bash
# Build, archive, export, and upload WhereToEat to TestFlight.
#
# Prereqs (one-time):
#   1. App Store Connect → Users and Access → Integrations → App Store Connect API
#      → Generate a key with role "App Manager". Download the .p8 file.
#   2. Move the .p8 into ~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8
#      (xcrun altool looks there by default).
#   3. Export these env vars (e.g. in ~/.zshrc):
#        export ASC_KEY_ID=ABCD123456
#        export ASC_ISSUER_ID=69a6de7f-xxxx-xxxx-xxxx-xxxxxxxxxxxx
#
# Run:
#   ./scripts/ios/testflight.sh
#
# What it does:
#   - Bumps CURRENT_PROJECT_VERSION (build number) by 1
#   - xcodebuild archive (Release, signed)
#   - xcodebuild -exportArchive (.ipa)
#   - xcrun altool --upload-app  (sends to App Store Connect)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROJECT="$REPO_ROOT/WhereToEat/WhereToEat.xcodeproj"
SCHEME="WhereToEat"
EXPORT_OPTIONS="$REPO_ROOT/scripts/ios/ExportOptions.plist"
BUILD_DIR="$REPO_ROOT/build/testflight"
ARCHIVE_PATH="$BUILD_DIR/WhereToEat.xcarchive"
EXPORT_PATH="$BUILD_DIR/export"

# Auto-load secrets from scripts/ios/.env if present (gitignored).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/.env" ]]; then
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/.env"
fi

: "${ASC_KEY_ID:?Set ASC_KEY_ID (App Store Connect API key id)}"
: "${ASC_ISSUER_ID:?Set ASC_ISSUER_ID (App Store Connect issuer id)}"

# Verify the .p8 is in the canonical location altool checks.
P8_PATH="$HOME/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8"
if [[ ! -f "$P8_PATH" ]]; then
  echo "Missing API key: $P8_PATH" >&2
  echo "Place AuthKey_${ASC_KEY_ID}.p8 there (chmod 600)." >&2
  exit 1
fi

# 1. Bump build number ONLY. Marketing version (MARKETING_VERSION) is never
#    touched here — it requires an explicit human edit. Snapshot it before
#    and verify it's unchanged after, just to be safe.
# Marketing version is read straight from the pbxproj because GENERATE_INFOPLIST_FILE=YES
# means there's no Info.plist for `xcrun agvtool what-marketing-version` to parse.
PBXPROJ="$PROJECT/project.pbxproj"
read_marketing_version() {
  grep -E '^[[:space:]]*MARKETING_VERSION = ' "$PBXPROJ" \
    | head -1 \
    | sed -E 's/.*MARKETING_VERSION = ([^;]+);.*/\1/' \
    | tr -d '[:space:]'
}
cd "$REPO_ROOT/WhereToEat"
MARKETING_BEFORE=$(read_marketing_version)
if [[ -z "$MARKETING_BEFORE" ]]; then
  echo "ABORT: could not read MARKETING_VERSION from $PBXPROJ" >&2
  exit 1
fi
CURRENT_BUILD=$(xcrun agvtool what-version -terse | tr -d '[:space:]')
NEXT_BUILD=$((CURRENT_BUILD + 1))
xcrun agvtool new-version -all "$NEXT_BUILD" >/dev/null
MARKETING_AFTER=$(read_marketing_version)
if [[ "$MARKETING_BEFORE" != "$MARKETING_AFTER" ]]; then
  echo "ABORT: marketing version changed ($MARKETING_BEFORE → $MARKETING_AFTER) — this script must not touch it." >&2
  exit 1
fi
echo "Build number: $CURRENT_BUILD → $NEXT_BUILD (marketing version unchanged: $MARKETING_AFTER)"
cd "$REPO_ROOT"

# 2. Clean output dir so old archives don't get re-uploaded.
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

# 3. Archive.
echo "Archiving…"
xcodebuild \
  -project "$PROJECT" \
  -scheme "$SCHEME" \
  -configuration Release \
  -destination "generic/platform=iOS" \
  -archivePath "$ARCHIVE_PATH" \
  -allowProvisioningUpdates \
  archive

# 4. Export .ipa.
#    `-authenticationKey*` flags pass the App Store Connect API key directly
#    so the export step doesn't need a logged-in Apple ID in Xcode's keychain
#    (older runs of this script relied on a cached Xcode-Token that has since
#    expired in the keychain).
echo "Exporting .ipa…"
xcodebuild \
  -exportArchive \
  -archivePath "$ARCHIVE_PATH" \
  -exportPath "$EXPORT_PATH" \
  -exportOptionsPlist "$EXPORT_OPTIONS" \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$P8_PATH" \
  -authenticationKeyID "$ASC_KEY_ID" \
  -authenticationKeyIssuerID "$ASC_ISSUER_ID"

IPA_PATH="$(ls "$EXPORT_PATH"/*.ipa | head -1)"
if [[ -z "$IPA_PATH" ]]; then
  echo "No .ipa produced in $EXPORT_PATH" >&2
  exit 1
fi
echo "IPA: $IPA_PATH"

# 5. Validate first (catches bad bundle issues without burning a build slot).
echo "Validating…"
xcrun altool --validate-app \
  -f "$IPA_PATH" \
  -t ios \
  --apiKey "$ASC_KEY_ID" \
  --apiIssuer "$ASC_ISSUER_ID"

# 6. Upload.
echo "Uploading to App Store Connect…"
xcrun altool --upload-app \
  -f "$IPA_PATH" \
  -t ios \
  --apiKey "$ASC_KEY_ID" \
  --apiIssuer "$ASC_ISSUER_ID"

echo
echo "Done. Build $NEXT_BUILD uploaded. Watch processing in App Store Connect → TestFlight."
