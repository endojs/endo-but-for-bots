package com.endojs.androidadmin

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.os.Build
import android.os.UserManager
import com.endojs.androidadmin.protocol.AdminFailure
import com.endojs.androidadmin.protocol.AdminOperations
import com.endojs.androidadmin.protocol.PasswordComplexity

/**
 * The privileged implementation of [AdminOperations], backed by
 * `DevicePolicyManager`.
 *
 * This is the only class in the project that holds real device authority, and
 * it is deliberately thin: decoding, validation, and dispatch all happen in
 * the pure-JVM `:protocol` module, which is why almost none of the protocol's
 * behaviour needs a device or an emulator to test. What is left here is the
 * mapping from a protocol action onto a platform call.
 *
 * ### This is the real authority boundary
 *
 * The JavaScript exo checks its policy before sending a request, but that is
 * the guest-facing bound and it lives on the other side of an IPC channel.
 * Every method here re-asserts device-owner status through [requireOwner]
 * rather than trusting that an arriving request was authorized.
 */
class DevicePolicyAdminOperations(
    private val context: Context,
    private val admin: ComponentName,
) : AdminOperations {

    private val dpm: DevicePolicyManager =
        context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager

    private val isDeviceOwner: Boolean
        get() = dpm.isDeviceOwnerApp(context.packageName)

    /**
     * Refuse anything privileged when this app was never provisioned as device
     * owner, with the same failure name the platform itself would raise, so an
     * operator sees one diagnosis rather than two.
     */
    private fun requireOwner() {
        if (!isDeviceOwner) {
            throw AdminFailure(
                "SecurityException",
                "Calling package is not the device owner",
            )
        }
    }

    /**
     * Wrap a platform call, translating the exceptions `DevicePolicyManager`
     * raises into protocol failures. An untranslated throwable would still be
     * encoded by the dispatcher, but with a less useful name.
     */
    private inline fun <T> privileged(action: String, body: () -> T): T {
        requireOwner()
        return try {
            body()
        } catch (security: SecurityException) {
            throw AdminFailure("SecurityException", security.message ?: "refused by the platform")
        } catch (argument: IllegalArgumentException) {
            throw AdminFailure(
                "IllegalArgumentException",
                argument.message ?: "rejected by the platform for $action",
            )
        }
    }

    // Queries.

    /**
     * Answers even when not device owner: an operator has to be able to see
     * *that* provisioning failed, and a bare refusal here is indistinguishable
     * from an unreachable device.
     */
    override fun getDeviceState(): Map<String, Any?> = mapOf(
        "deviceOwner" to isDeviceOwner,
        "model" to Build.MODEL,
        "manufacturer" to Build.MANUFACTURER,
        "apiLevel" to Build.VERSION.SDK_INT,
        "securityPatch" to Build.VERSION.SECURITY_PATCH,
    )

    override fun listUserRestrictions(): List<String> = privileged("listUserRestrictions") {
        val userManager = context.getSystemService(Context.USER_SERVICE) as UserManager
        val restrictions = userManager.userRestrictions
        restrictions.keySet()
            .filter { restrictions.getBoolean(it, false) }
            .sorted()
    }

    override fun isApplicationHidden(packageName: String): Boolean =
        privileged("isApplicationHidden") {
            dpm.isApplicationHidden(admin, packageName)
        }

    // Mutations.

    override fun lockNow() = privileged("lockNow") { dpm.lockNow() }

    override fun setCameraDisabled(disabled: Boolean) = privileged("setCameraDisabled") {
        dpm.setCameraDisabled(admin, disabled)
    }

    override fun setScreenCaptureDisabled(disabled: Boolean) =
        privileged("setScreenCaptureDisabled") {
            dpm.setScreenCaptureDisabled(admin, disabled)
        }

    override fun setMaximumTimeToLock(timeMs: Long) = privileged("setMaximumTimeToLock") {
        dpm.setMaximumTimeToLock(admin, timeMs)
    }

    override fun setRequiredPasswordComplexity(complexity: PasswordComplexity) =
        privileged("setRequiredPasswordComplexity") {
            val value = when (complexity) {
                PasswordComplexity.NONE -> DevicePolicyManager.PASSWORD_COMPLEXITY_NONE
                PasswordComplexity.LOW -> DevicePolicyManager.PASSWORD_COMPLEXITY_LOW
                PasswordComplexity.MEDIUM -> DevicePolicyManager.PASSWORD_COMPLEXITY_MEDIUM
                PasswordComplexity.HIGH -> DevicePolicyManager.PASSWORD_COMPLEXITY_HIGH
            }
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
                throw AdminFailure(
                    "UnsupportedOperationException",
                    "password complexity requires API 31; this device is ${Build.VERSION.SDK_INT}",
                )
            }
            dpm.setRequiredPasswordComplexity(value)
        }

    override fun addUserRestriction(key: String) = privileged("addUserRestriction") {
        dpm.addUserRestriction(admin, key)
    }

    override fun clearUserRestriction(key: String) = privileged("clearUserRestriction") {
        dpm.clearUserRestriction(admin, key)
    }

    override fun setApplicationHidden(packageName: String, hidden: Boolean) =
        privileged("setApplicationHidden") {
            // The platform returns false when the package is absent or cannot
            // be hidden. The protocol reports success as the *absence* of a
            // failure, so a false return must become a failure rather than a
            // silently discarded value — otherwise HQ would believe a policy
            // took effect that never did.
            val applied = dpm.setApplicationHidden(admin, packageName, hidden)
            if (!applied) {
                throw AdminFailure(
                    "IllegalStateException",
                    "the platform did not apply hidden=$hidden to $packageName",
                )
            }
        }

    override fun setUninstallBlocked(packageName: String, blocked: Boolean) =
        privileged("setUninstallBlocked") {
            dpm.setUninstallBlocked(admin, packageName, blocked)
        }

    // Destructive.

    override fun reboot() = privileged("reboot") { dpm.reboot(admin) }

    override fun wipeData(reason: String?) = privileged("wipeData") {
        // `reason` is an operator note for the audit trail; on API 28+ the
        // platform surfaces it to the user, so pass it through when present.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && !reason.isNullOrBlank()) {
            dpm.wipeData(0, reason)
        } else {
            dpm.wipeData(0)
        }
    }
}
