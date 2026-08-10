package com.endojs.androidadmin.protocol

/**
 * The Kotlin half of the AndroidAdmin bridge protocol.
 *
 * This file is the counterpart of `packages/exo-android-admin/src/protocol.js`,
 * and the written contract both implement is
 * `packages/exo-android-admin/protocol/PROTOCOL.md`. Neither side is generated
 * from the other; instead both are pinned to the same golden fixtures
 * (`packages/exo-android-admin/protocol/fixtures.json`), so a disagreement
 * fails a unit test on whichever side drifted rather than surfacing on a
 * physical device.
 *
 * Deliberately free of Android dependencies so it compiles and tests on a
 * plain JVM. The privileged half lives behind [AdminOperations].
 */

/** Protocol version this build implements. */
const val PROTOCOL_VERSION: Int = 1

/** How dangerous an action is. Mirrors the JavaScript catalog's `kind`. */
enum class ActionKind {
    QUERY,
    MUTATE,
    DESTRUCTIVE,
}

/**
 * A catalog entry. [args] are the wire record's keys, in the order the
 * JavaScript exo zips its positional arguments into them.
 */
data class ActionSpec(
    val kind: ActionKind,
    val args: List<String> = emptyList(),
)

/**
 * The closed action catalog.
 *
 * This must agree with `ACTIONS` in `protocol.js`; `ProtocolFixturesTest`
 * fails if a fixture names an action missing here, and if this catalog names
 * an action no fixture covers.
 */
val ACTIONS: Map<String, ActionSpec> = mapOf(
    // Queries.
    "getDeviceState" to ActionSpec(ActionKind.QUERY),
    "listUserRestrictions" to ActionSpec(ActionKind.QUERY),
    "isApplicationHidden" to ActionSpec(ActionKind.QUERY, listOf("packageName")),

    // Mutations.
    "lockNow" to ActionSpec(ActionKind.MUTATE),
    "setCameraDisabled" to ActionSpec(ActionKind.MUTATE, listOf("disabled")),
    "setScreenCaptureDisabled" to ActionSpec(ActionKind.MUTATE, listOf("disabled")),
    "setMaximumTimeToLock" to ActionSpec(ActionKind.MUTATE, listOf("timeMs")),
    "setRequiredPasswordComplexity" to ActionSpec(ActionKind.MUTATE, listOf("complexity")),
    "addUserRestriction" to ActionSpec(ActionKind.MUTATE, listOf("key")),
    "clearUserRestriction" to ActionSpec(ActionKind.MUTATE, listOf("key")),
    "setApplicationHidden" to ActionSpec(ActionKind.MUTATE, listOf("packageName", "hidden")),
    "setUninstallBlocked" to ActionSpec(ActionKind.MUTATE, listOf("packageName", "blocked")),

    // Destructive.
    "reboot" to ActionSpec(ActionKind.DESTRUCTIVE),
    "wipeData" to ActionSpec(ActionKind.DESTRUCTIVE, listOf("reason")),
)

/** The password-complexity buckets the protocol admits. */
enum class PasswordComplexity(val wire: String) {
    NONE("none"),
    LOW("low"),
    MEDIUM("medium"),
    HIGH("high"),
    ;

    companion object {
        fun fromWire(value: String): PasswordComplexity =
            entries.firstOrNull { it.wire == value }
                ?: throw AdminFailure(
                    "IllegalArgumentException",
                    "unknown password complexity $value",
                )
    }
}

/**
 * A failure destined for the result envelope.
 *
 * The protocol treats failures as *data*: a JVM throwable cannot cross the
 * channel as a JavaScript throw, so every failure is encoded and rethrown on
 * the JavaScript side. [name] is the discriminator the JavaScript side
 * surfaces in its rejection message.
 *
 * Messages must not carry secrets or host paths — they travel to a remote
 * holder as part of a rejection.
 */
class AdminFailure(
    val name: String,
    override val message: String,
) : Exception(message)
