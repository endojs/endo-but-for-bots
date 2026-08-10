package com.endojs.androidadmin

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import com.endojs.androidadmin.protocol.AdminDispatcher

/**
 * The foreground service that keeps the embedded Endo daemon resident.
 *
 * Background survival is the second of the two hard problems this application
 * exists to solve (the first being device-owner privilege). A plain background
 * process on One UI is reclaimed aggressively; a foreground service plus the
 * battery-optimization exemption a device owner can grant *itself* is what
 * makes the daemon durable enough to be relied on from HQ.
 */
class EndoDaemonService : Service() {

    private lateinit var bridge: NodeBridge

    override fun onCreate() {
        super.onCreate()
        startForeground(NOTIFICATION_ID, buildNotification())
        requestBatteryExemption()

        val operations = DevicePolicyAdminOperations(
            context = applicationContext,
            admin = AdminReceiver.componentName(applicationContext),
        )
        // The dispatcher is the pure-JVM half: everything it does is already
        // covered by `:protocol`'s fixture tests, which run with no device.
        bridge = NodeBridge(applicationContext, AdminDispatcher(operations))
        bridge.start()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // START_STICKY so the system restarts us if we are killed under
        // memory pressure: an admin agent that silently stays dead is worse
        // than one that restarts noisily.
        return START_STICKY
    }

    override fun onDestroy() {
        bridge.stop()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun buildNotification(): Notification {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    "Endo device agent",
                    // LOW keeps the required notification silent; it must stay
                    // visible, because the user is entitled to know a remote
                    // administration agent is running.
                    NotificationManager.IMPORTANCE_LOW,
                ),
            )
        }
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        return builder
            .setContentTitle("Endo device agent")
            .setContentText("Managed remotely by your organization")
            .setSmallIcon(android.R.drawable.ic_lock_lock)
            .setOngoing(true)
            .build()
    }

    /**
     * Ask to be exempt from battery optimization.
     *
     * A device owner can grant this to itself without user interaction; the
     * request is best-effort and its failure is logged rather than fatal,
     * because a daemon that runs but sleeps is still more useful than one that
     * refuses to start.
     */
    private fun requestBatteryExemption() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            return
        }
        val power = getSystemService(Context.POWER_SERVICE) as PowerManager
        if (power.isIgnoringBatteryOptimizations(packageName)) {
            return
        }
        try {
            val intent = Intent(
                Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                Uri.parse("package:$packageName"),
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            startActivity(intent)
        } catch (error: Exception) {
            Log.w(TAG, "could not request battery-optimization exemption", error)
        }
    }

    companion object {
        private const val TAG = "EndoDaemonService"
        private const val CHANNEL_ID = "endo-device-agent"
        private const val NOTIFICATION_ID = 1

        fun start(context: Context) {
            val intent = Intent(context, EndoDaemonService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }
    }
}
