package org.flaxandteal.greasan

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/**
 * Foreground service that keeps a long on-device layer build alive when the app
 * is backgrounded (a backgrounded >1GB process is the first thing the low-memory
 * killer reaps) and shows an ongoing progress notification in the shade.
 *
 * Rust (`fg_service.rs`) drives it over JNI: [start] when a build begins,
 * [update] on each progress tick, [stop] when it finishes or fails. The service
 * itself does no work - it exists purely to hold the process up and own the
 * notification; the build runs on its own thread in the same process.
 */
class BuildForegroundService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val text = intent?.getStringExtra("text") ?: "Working…"
        val pct = intent?.getIntExtra("pct", -1) ?: -1
        val notif = buildNotification(this, text, pct)
        // On API 29+ the foregroundServiceType must match the manifest declaration.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            @Suppress("DEPRECATION")
            startForeground(NOTIF_ID, notif)
        }
        // Don't auto-restart if the OS kills us - a half-finished build can't resume.
        return START_NOT_STICKY
    }

    companion object {
        const val NOTIF_ID = 4711
        const val CHANNEL_ID = "greasan_build"

        private fun ensureChannel(ctx: Context) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val nm = ctx.getSystemService(NotificationManager::class.java)
                if (nm.getNotificationChannel(CHANNEL_ID) == null) {
                    val ch = NotificationChannel(
                        CHANNEL_ID,
                        "Layer builds",
                        NotificationManager.IMPORTANCE_LOW,
                    )
                    ch.setShowBadge(false)
                    nm.createNotificationChannel(ch)
                }
            }
        }

        private fun buildNotification(ctx: Context, text: String, pct: Int): Notification {
            ensureChannel(ctx)
            val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Notification.Builder(ctx, CHANNEL_ID)
            } else {
                @Suppress("DEPRECATION")
                Notification.Builder(ctx)
            }
            builder
                .setContentTitle("Gréasán")
                .setContentText(text)
                .setSmallIcon(ctx.applicationInfo.icon)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
            // pct in 0..100 → determinate bar; negative → indeterminate.
            if (pct in 0..100) {
                builder.setProgress(100, pct, false)
            } else {
                builder.setProgress(0, 0, true)
            }
            return builder.build()
        }

        /** Start the foreground service with an initial (indeterminate) notification. */
        @JvmStatic
        fun start(ctx: Context, text: String) {
            ensureChannel(ctx)
            maybeRequestNotifPermission(ctx)
            val i = Intent(ctx, BuildForegroundService::class.java)
                .putExtra("text", text)
                .putExtra("pct", -1)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(i)
            } else {
                ctx.startService(i)
            }
        }

        /** Update the ongoing notification's text + progress (0..100, <0 = spinner). */
        @JvmStatic
        fun update(ctx: Context, text: String, pct: Int) {
            ensureChannel(ctx)
            val nm = ctx.getSystemService(NotificationManager::class.java)
            nm.notify(NOTIF_ID, buildNotification(ctx, text, pct))
        }

        /** Stop the service and clear the notification. */
        @JvmStatic
        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, BuildForegroundService::class.java))
        }

        /**
         * On API 33+ the notification is hidden unless POST_NOTIFICATIONS is
         * granted. Request it (fire-and-forget) when we have an Activity context;
         * the foreground service itself runs regardless - only the visible bar
         * depends on the grant.
         */
        private fun maybeRequestNotifPermission(ctx: Context) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && ctx is Activity) {
                val granted = ctx.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) ==
                    PackageManager.PERMISSION_GRANTED
                if (!granted) {
                    ctx.requestPermissions(
                        arrayOf(android.Manifest.permission.POST_NOTIFICATIONS),
                        9911,
                    )
                }
            }
        }
    }
}
