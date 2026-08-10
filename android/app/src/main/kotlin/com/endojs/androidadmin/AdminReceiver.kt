package com.endojs.androidadmin

import android.app.admin.DeviceAdminReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * The `DeviceAdminReceiver` this application is provisioned against.
 *
 * Device owner is bound to a *receiver component*, not merely to a package,
 * which is the structural reason a Termux-hosted daemon can never hold this
 * authority and this application can (see the design document's
 * "Why not Termux").
 *
 * Provisioning, on a factory-fresh device with no accounts added:
 *
 * ```sh
 * adb shell dpm set-device-owner com.endojs.androidadmin/.AdminReceiver
 * ```
 */
class AdminReceiver : DeviceAdminReceiver() {

    override fun onEnabled(context: Context, intent: Intent) {
        Log.i(TAG, "device admin enabled")
        // Bring the daemon up as soon as we hold authority, so a freshly
        // provisioned device is reachable without a manual launch.
        EndoDaemonService.start(context)
    }

    override fun onDisabled(context: Context, intent: Intent) {
        // Losing admin authority makes every privileged action fail; keep the
        // daemon running so an operator can still reach the device and see
        // `getDeviceState().deviceOwner === false` rather than a silent
        // disappearance.
        Log.w(TAG, "device admin disabled; privileged actions will now be refused")
    }

    companion object {
        private const val TAG = "EndoAdminReceiver"

        /** The component that device-owner status is bound to. */
        fun componentName(context: Context): ComponentName =
            ComponentName(context.applicationContext, AdminReceiver::class.java)
    }
}
