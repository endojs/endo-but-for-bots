package com.endojs.androidadmin.protocol

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.json.JSONArray
import org.json.JSONObject

/**
 * The Kotlin half of the cross-language contract.
 *
 * The JavaScript suite asserts that the exo *produces* each fixture request
 * and *consumes* each fixture result. This suite asserts the mirror image:
 * that decoding each request dispatches to the expected [AdminOperations]
 * call, and that the outcome encodes to the fixture's result.
 *
 * Because both halves are pinned to the same file and neither needs the
 * other to run, wire drift fails in CI on whichever side drifted — and never
 * has to be discovered on a physical device.
 */
class ProtocolFixturesTest {

    /**
     * Records every call and answers with scripted values, so a fixture's
     * request can be checked against the operation it actually reached.
     */
    private class RecordingOperations : AdminOperations {
        val calls = mutableListOf<Pair<String, List<Any?>>>()
        // Named `stub*` because a Kotlin property called `deviceState` would
        // generate a `getDeviceState()` accessor that clashes with the
        // interface method of the same JVM signature.
        var stubDeviceState: Map<String, Any?> = mapOf("deviceOwner" to true)
        var stubRestrictions: List<String> = emptyList()
        var stubHidden: Boolean = false

        private fun record(name: String, vararg args: Any?) {
            calls += name to args.toList()
        }

        override fun getDeviceState(): Map<String, Any?> {
            record("getDeviceState")
            return stubDeviceState
        }

        override fun listUserRestrictions(): List<String> {
            record("listUserRestrictions")
            return stubRestrictions
        }

        override fun isApplicationHidden(packageName: String): Boolean {
            record("isApplicationHidden", packageName)
            return stubHidden
        }

        override fun lockNow() = record("lockNow")

        override fun setCameraDisabled(disabled: Boolean) =
            record("setCameraDisabled", disabled)

        override fun setScreenCaptureDisabled(disabled: Boolean) =
            record("setScreenCaptureDisabled", disabled)

        override fun setMaximumTimeToLock(timeMs: Long) =
            record("setMaximumTimeToLock", timeMs)

        override fun setRequiredPasswordComplexity(complexity: PasswordComplexity) =
            record("setRequiredPasswordComplexity", complexity)

        override fun addUserRestriction(key: String) = record("addUserRestriction", key)

        override fun clearUserRestriction(key: String) = record("clearUserRestriction", key)

        override fun setApplicationHidden(packageName: String, hidden: Boolean) =
            record("setApplicationHidden", packageName, hidden)

        override fun setUninstallBlocked(packageName: String, blocked: Boolean) =
            record("setUninstallBlocked", packageName, blocked)

        override fun reboot() = record("reboot")

        override fun wipeData(reason: String?) = record("wipeData", reason)
    }

    private companion object {
        /**
         * The fixtures live with the JavaScript package that defines the
         * protocol; this module reads them rather than keeping a copy, because
         * a copy is exactly the thing that drifts.
         */
        val fixtures: JSONObject by lazy {
            val file = File(
                System.getProperty("endo.fixtures")
                    ?: error("endo.fixtures system property is not set"),
            )
            assertTrue(file.isFile, "fixtures not found at ${file.absolutePath}")
            JSONObject(file.readText())
        }

        fun cases(name: String): List<JSONObject> {
            val array = fixtures.getJSONArray(name)
            return (0 until array.length()).map { array.getJSONObject(it) }
        }
    }

    @Test
    fun `fixtures declare the version this build implements`() {
        assertEquals(PROTOCOL_VERSION, fixtures.getInt("version"))
    }

    @Test
    fun `every catalog action has a fixture`() {
        val covered = cases("cases").map { it.getString("action") }.toSet()
        val missing = ACTIONS.keys - covered
        assertTrue(missing.isEmpty(), "catalog actions with no fixture: $missing")
    }

    @Test
    fun `every fixture action is in the catalog`() {
        val unknown = cases("cases").map { it.getString("action") }.filter { it !in ACTIONS }
        assertTrue(unknown.isEmpty(), "fixture actions missing from the catalog: $unknown")
    }

    @Test
    fun `every fixture request keys its args exactly as the catalog declares`() {
        // Without this, the catalog's `args` would be decorative: the
        // dispatcher reads argument names literally, so the catalog could
        // disagree with both it and PROTOCOL.md and nothing would notice.
        for (case in cases("cases")) {
            val action = case.getString("action")
            val declared = ACTIONS.getValue(action).args
            val args = case.getJSONObject("request").getJSONObject("args")
            val present = args.keys().asSequence().toList()
            val undeclared = present - declared.toSet()
            assertTrue(
                undeclared.isEmpty(),
                "${case.getString("name")}: args $undeclared are not declared by the catalog for $action",
            )
        }
    }

    @Test
    fun `each fixture request reaches its operation and encodes its result`() {
        for (case in cases("cases")) {
            val name = case.getString("name")
            val operations = RecordingOperations()

            // Answer queries with the fixture's own expected value, so the
            // encoder is checked against the exact shape the JavaScript side
            // is pinned to consume.
            if (case.has("value") && !case.isNull("value")) {
                when (case.getString("action")) {
                    "getDeviceState" ->
                        operations.stubDeviceState = case.getJSONObject("value").toMap()
                    "listUserRestrictions" ->
                        operations.stubRestrictions =
                            case.getJSONArray("value").let { array ->
                                (0 until array.length()).map { array.getString(it) }
                            }
                    "isApplicationHidden" -> operations.stubHidden = case.getBoolean("value")
                }
            }

            val result = AdminDispatcher(operations)
                .dispatch(case.getJSONObject("request"))

            assertEquals(
                1,
                operations.calls.size,
                "$name: exactly one operation must be invoked",
            )
            assertEquals(
                case.getString("action"),
                operations.calls.single().first,
                "$name: dispatched to the wrong operation",
            )
            assertTrue(result.getBoolean("ok"), "$name: expected a success envelope")
            assertSameJson(name, case.get("value"), if (result.has("value")) result.get("value") else JSONObject.NULL)
        }
    }

    @Test
    fun `an omitted optional argument arrives as null, not as the string null`() {
        val case = cases("cases").single { it.getString("name") == "wipeData/omitted-optional-argument" }
        val operations = RecordingOperations()

        AdminDispatcher(operations).dispatch(case.getJSONObject("request"))

        assertNull(
            operations.calls.single().second.single(),
            "an absent optional argument must reach the operation as null",
        )
    }

    @Test
    fun `an unsupported version is refused without dispatching`() {
        val operations = RecordingOperations()
        val result = AdminDispatcher(operations)
            .dispatch(JSONObject("""{"v":99,"action":"lockNow","args":{}}"""))

        assertFailureNamed(result, "UnsupportedVersion")
        assertTrue(operations.calls.isEmpty(), "nothing may be invoked for an unknown version")
    }

    @Test
    fun `an unknown action is refused rather than silently succeeding`() {
        val operations = RecordingOperations()
        val result = AdminDispatcher(operations)
            .dispatch(JSONObject("""{"v":1,"action":"selfDestruct","args":{}}"""))

        assertFailureNamed(result, "UnknownAction")
        assertTrue(operations.calls.isEmpty())
    }

    @Test
    fun `a missing required argument is refused`() {
        val operations = RecordingOperations()
        val result = AdminDispatcher(operations)
            .dispatch(JSONObject("""{"v":1,"action":"setCameraDisabled","args":{}}"""))

        assertFailureNamed(result, "IllegalArgumentException")
        assertTrue(operations.calls.isEmpty())
    }

    @Test
    fun `a platform refusal is encoded as data rather than thrown`() {
        val refusing = object : AdminOperations by RecordingOperations() {
            override fun lockNow() =
                throw AdminFailure("SecurityException", "Calling package is not the device owner")
        }
        val result = AdminDispatcher(refusing)
            .dispatch(JSONObject("""{"v":1,"action":"lockNow","args":{}}"""))

        assertFailureNamed(result, "SecurityException")
    }

    @Test
    fun `an unexpected throwable still returns a failure envelope`() {
        // The dispatcher must never throw: an unanswered request would leave
        // the caller's remote reference pending until its timeout.
        val exploding = object : AdminOperations by RecordingOperations() {
            override fun lockNow(): Unit = throw IllegalStateException("boom")
        }
        val result = AdminDispatcher(exploding)
            .dispatch(JSONObject("""{"v":1,"action":"lockNow","args":{}}"""))

        assertFailureNamed(result, "IllegalStateException")
    }

    @Test
    fun `the text entry point round-trips through JSON`() {
        val operations = RecordingOperations()
        val text = AdminDispatcher(operations)
            .dispatch("""{"v":1,"action":"lockNow","args":{}}""")

        assertTrue(JSONObject(text).getBoolean("ok"))
        assertEquals("lockNow", operations.calls.single().first)
    }

    @Test
    fun `password complexity maps the wire buckets and rejects others`() {
        assertEquals(PasswordComplexity.HIGH, PasswordComplexity.fromWire("high"))
        assertFailsWith<AdminFailure> { PasswordComplexity.fromWire("extreme") }
    }

    private fun assertFailureNamed(result: JSONObject, name: String) {
        assertTrue(!result.getBoolean("ok"), "expected a failure envelope, got $result")
        assertEquals(name, result.getJSONObject("error").getString("name"))
        assertTrue(
            result.getJSONObject("error").getString("message").isNotEmpty(),
            "a failure must carry a message",
        )
    }

    /** Compare two JSON-ish values structurally, tolerating container identity. */
    private fun assertSameJson(label: String, expected: Any?, actual: Any?) {
        val normalizedExpected = normalize(expected)
        val normalizedActual = normalize(actual)
        assertEquals(normalizedExpected, normalizedActual, "$label: encoded value mismatch")
    }

    private fun normalize(value: Any?): Any? = when (value) {
        null, JSONObject.NULL -> null
        is JSONObject -> value.toMap()
        is JSONArray -> (0 until value.length()).map { normalize(value.get(it)) }
        is Number -> value.toLong()
        else -> value
    }
}
