package com.endojs.androidadmin.protocol

/**
 * The privileged operations the protocol dispatches to.
 *
 * This is the Kotlin mirror of the JavaScript side's `transport` seam, and it
 * serves the same purpose: everything above it is portable, testable logic;
 * everything below it touches the platform. The Android module implements it
 * with `DevicePolicyManager`; unit tests implement it with a recording fake,
 * which is what lets the whole dispatcher be exercised on a plain JVM with no
 * Android SDK, no emulator, and no device.
 *
 * Implementations should throw [AdminFailure] for expected refusals (a
 * `SecurityException` from the platform, an unknown restriction key). The
 * dispatcher encodes any other throwable defensively.
 */
interface AdminOperations {

    // Queries.

    /**
     * Device identity and provisioning status.
     *
     * Must answer even when the app is *not* device owner — an operator has to
     * be able to see that provisioning failed, and a bare failure here is
     * indistinguishable from an unreachable device.
     */
    fun getDeviceState(): Map<String, Any?>

    fun listUserRestrictions(): List<String>

    fun isApplicationHidden(packageName: String): Boolean

    // Mutations.

    fun lockNow()

    fun setCameraDisabled(disabled: Boolean)

    fun setScreenCaptureDisabled(disabled: Boolean)

    fun setMaximumTimeToLock(timeMs: Long)

    fun setRequiredPasswordComplexity(complexity: PasswordComplexity)

    fun addUserRestriction(key: String)

    fun clearUserRestriction(key: String)

    fun setApplicationHidden(packageName: String, hidden: Boolean)

    fun setUninstallBlocked(packageName: String, blocked: Boolean)

    // Destructive.

    fun reboot()

    /** @param reason optional operator note; absent when the caller omitted it. */
    fun wipeData(reason: String?)
}
