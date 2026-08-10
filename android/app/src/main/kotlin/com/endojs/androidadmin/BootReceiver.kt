package com.endojs.androidadmin

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Restarts the daemon after a reboot.
 *
 * Without this, a device that reboots — including one rebooted *by* the
 * `reboot` admin action — would go permanently dark from HQ's point of view,
 * which is the failure mode most likely to be mistaken for a lost device.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED ||
            intent.action == Intent.ACTION_LOCKED_BOOT_COMPLETED
        ) {
            EndoDaemonService.start(context)
        }
    }
}
