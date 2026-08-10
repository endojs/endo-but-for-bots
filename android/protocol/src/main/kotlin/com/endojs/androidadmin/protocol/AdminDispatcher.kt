package com.endojs.androidadmin.protocol

import org.json.JSONArray
import org.json.JSONObject

/**
 * Decodes a request envelope, dispatches it to [operations], and encodes the
 * result envelope.
 *
 * This is the Kotlin counterpart of the JavaScript side's request builder and
 * result unwrapper, and the object the golden fixtures pin: for each fixture,
 * feeding `request` here must invoke the expected [AdminOperations] call, and
 * the outcome must encode to `result`.
 *
 * `org.json` is the JSON implementation because it is part of the Android
 * platform (no dependency shipped in the app) and available as an ordinary
 * artifact for JVM unit tests, so both run the same code.
 *
 * ### Authority note
 *
 * The JavaScript exo checks its policy before building a request, but that is
 * the *guest-facing* bound. This class sits on the real authority boundary and
 * therefore re-validates independently: unknown versions, unknown actions, and
 * missing or ill-typed arguments are all refused here. A bridge that trusted
 * the envelope because "the exo already checked" would have moved the security
 * boundary to the wrong side of the channel.
 */
class AdminDispatcher(private val operations: AdminOperations) {

    /**
     * Handle one request envelope, returning the result envelope.
     *
     * Never throws: every failure path becomes `{ ok: false, error }`, because
     * a throwable cannot cross the channel and an unanswered request would
     * leave the caller's remote reference pending until its timeout.
     */
    fun dispatch(request: JSONObject): JSONObject =
        try {
            val version = request.optInt("v", -1)
            if (version != PROTOCOL_VERSION) {
                throw AdminFailure(
                    "UnsupportedVersion",
                    "protocol version $version is not implemented by this build",
                )
            }
            val action = request.optString("action", "")
            val args = request.optJSONObject("args") ?: JSONObject()
            success(invoke(action, args))
        } catch (failure: AdminFailure) {
            failure(failure.name, failure.message)
        } catch (error: Throwable) {
            // Defensive: an unexpected platform throwable must still reach the
            // caller as data rather than dying inside the channel listener.
            failure(error.javaClass.simpleName, error.message ?: "unspecified failure")
        }

    /** Convenience for channel adapters that carry frames as text. */
    fun dispatch(requestText: String): String = dispatch(JSONObject(requestText)).toString()

    private fun invoke(action: String, args: JSONObject): Any? {
        val spec = ACTIONS[action]
            ?: throw AdminFailure(
                "UnknownAction",
                "action $action is not in this build's catalog",
            )
        return when (action) {
            // Queries.
            "getDeviceState" -> JSONObject(operations.getDeviceState())
            "listUserRestrictions" -> JSONArray(operations.listUserRestrictions())
            "isApplicationHidden" -> operations.isApplicationHidden(args.string("packageName"))

            // Mutations.
            "lockNow" -> operations.lockNow().let { null }
            "setCameraDisabled" -> operations.setCameraDisabled(args.boolean("disabled")).let { null }
            "setScreenCaptureDisabled" ->
                operations.setScreenCaptureDisabled(args.boolean("disabled")).let { null }
            "setMaximumTimeToLock" ->
                operations.setMaximumTimeToLock(args.long("timeMs")).let { null }
            "setRequiredPasswordComplexity" ->
                operations
                    .setRequiredPasswordComplexity(
                        PasswordComplexity.fromWire(args.string("complexity")),
                    )
                    .let { null }
            "addUserRestriction" -> operations.addUserRestriction(args.string("key")).let { null }
            "clearUserRestriction" -> operations.clearUserRestriction(args.string("key")).let { null }
            "setApplicationHidden" ->
                operations
                    .setApplicationHidden(args.string("packageName"), args.boolean("hidden"))
                    .let { null }
            "setUninstallBlocked" ->
                operations
                    .setUninstallBlocked(args.string("packageName"), args.boolean("blocked"))
                    .let { null }

            // Destructive.
            "reboot" -> operations.reboot().let { null }
            // `reason` is optional: PROTOCOL.md requires an omitted optional
            // argument to be ABSENT from `args`, never present as null.
            "wipeData" -> operations.wipeData(args.optionalString("reason")).let { null }

            // Unreachable while the catalog and this `when` agree; the
            // dispatcher-coverage test enforces that they do.
            else -> throw AdminFailure(
                "UnknownAction",
                "action $action (kind ${spec.kind}) has no dispatch arm",
            )
        }
    }

    private companion object {
        fun success(value: Any?): JSONObject =
            JSONObject().put("ok", true).apply {
                // `value` is omitted rather than null for actions that produce
                // no result, matching the JavaScript encoder.
                if (value != null) put("value", value)
            }

        fun failure(name: String, message: String): JSONObject =
            JSONObject()
                .put("ok", false)
                .put("error", JSONObject().put("name", name).put("message", message))

        /** A required string argument. */
        fun JSONObject.string(key: String): String =
            if (has(key) && !isNull(key)) getString(key)
            else throw AdminFailure(
                "IllegalArgumentException",
                "missing required argument $key",
            )

        /** An optional string argument; absent is a legitimate value. */
        fun JSONObject.optionalString(key: String): String? =
            if (has(key) && !isNull(key)) getString(key) else null

        fun JSONObject.boolean(key: String): Boolean =
            if (has(key) && !isNull(key)) getBoolean(key)
            else throw AdminFailure(
                "IllegalArgumentException",
                "missing required argument $key",
            )

        fun JSONObject.long(key: String): Long =
            if (has(key) && !isNull(key)) getLong(key)
            else throw AdminFailure(
                "IllegalArgumentException",
                "missing required argument $key",
            )
    }
}
