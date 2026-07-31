# Android overlay — build foreground service

`src-tauri/gen/` is git-ignored (Tauri regenerates it), so the Android bits of
the on-device-build **foreground service + progress notification** live here as
canonical, version-controlled copies. The live build reads them from
`gen/android`; `tauri android build` does **not** regenerate that tree, so once
applied they persist. Re-apply them after any `tauri android init` (which *does*
regenerate `gen/android`).

## What it does

Keeps a long on-device layer build alive when the app is backgrounded (a
backgrounded >1 GB process is the first thing the low-memory killer reaps) and
shows a live progress notification in the shade. Driven from Rust over JNI
(`src/fg_service.rs`, called from `src/builder_plugin.rs`).

## Files to apply into `gen/android`

1. **`java/org/flaxandteal/greasan/BuildForegroundService.kt`**
   → copy to `gen/android/app/src/main/java/org/flaxandteal/greasan/BuildForegroundService.kt`

2. **`AndroidManifest.xml` additions** — add to
   `gen/android/app/src/main/AndroidManifest.xml`:

   Permissions (next to `INTERNET`):
   ```xml
   <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
   <uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />
   <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
   ```

   Service (inside `<application>`):
   ```xml
   <service
       android:name=".BuildForegroundService"
       android:exported="false"
       android:foregroundServiceType="dataSync" />
   ```

## Notes

- `dataSync` foreground-service type + its permission are required on
  targetSdk ≥ 34; the service is started while the app is foreground (user taps
  Build), which is allowed.
- `POST_NOTIFICATIONS` (Android 13+) gates only the *visible* notification, not
  the keep-alive — the service requests it on first build, but the bar stays
  hidden until the user grants it.
- The notification channel is `IMPORTANCE_LOW` (no sound/peek) with
  `setOnlyAlertOnce` — standard for an ongoing progress bar.
