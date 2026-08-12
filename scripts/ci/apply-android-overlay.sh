#!/usr/bin/env bash
# Re-apply the version-controlled Android foreground-service overlay into the
# freshly-generated gen/android tree. `tauri android init` regenerates
# gen/android and wipes these bits, so this must run AFTER init and BEFORE build.
#
# Mirrors app/src-tauri/android-overlay/README.md. Idempotent.
set -euo pipefail

ST="${1:-app/src-tauri}"                     # path to src-tauri
OVERLAY="$ST/android-overlay"
GEN="$ST/gen/android/app/src/main"
MANIFEST="$GEN/AndroidManifest.xml"

[[ -d "$GEN" ]] || { echo "ERROR: $GEN missing — run 'tauri android init' first" >&2; exit 1; }

# 1. Kotlin foreground-service class
dst_kt="$GEN/java/org/flaxandteal/greasan/BuildForegroundService.kt"
mkdir -p "$(dirname "$dst_kt")"
cp -f "$OVERLAY/java/org/flaxandteal/greasan/BuildForegroundService.kt" "$dst_kt"
echo "copied BuildForegroundService.kt"

# 2. Manifest permissions (after INTERNET) — skip if already present
if ! grep -q "FOREGROUND_SERVICE_DATA_SYNC" "$MANIFEST"; then
  perl -0pi -e 's{(<uses-permission android:name="android.permission.INTERNET"\s*/>)}{$1\n    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />\n    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />\n    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />}' "$MANIFEST"
  echo "added foreground-service permissions"
else
  echo "permissions already present — skipping"
fi

# 3. Service declaration (before </application>) — skip if already present
if ! grep -q 'android:name=".BuildForegroundService"' "$MANIFEST"; then
  perl -0pi -e 's{(\s*</application>)}{\n        <service\n            android:name=".BuildForegroundService"\n            android:exported="false"\n            android:foregroundServiceType="dataSync" />$1}' "$MANIFEST"
  echo "added BuildForegroundService <service> declaration"
else
  echo "service already declared — skipping"
fi

echo "Overlay applied to $GEN"
