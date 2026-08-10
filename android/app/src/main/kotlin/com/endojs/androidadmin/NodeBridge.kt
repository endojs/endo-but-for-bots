package com.endojs.androidadmin

import android.content.Context
import android.util.Log
import com.endojs.androidadmin.protocol.AdminDispatcher
import org.json.JSONObject

/**
 * The channel between the embedded Node runtime and this application's
 * privileged side.
 *
 * The JavaScript counterpart is
 * `packages/host-android-admin/src/nodejs-mobile-channel.js`. Frames are the
 * correlation envelope that adapter defines — `{ id, request }` inbound,
 * `{ id, result }` outbound — wrapping the protocol envelopes documented in
 * `PROTOCOL.md`.
 *
 * This class is deliberately dependency-light and does no protocol work of its
 * own: it moves frames and hands the payload to [AdminDispatcher], which is
 * pure JVM and already covered by tests that need no device.
 *
 * ### Embedding note
 *
 * The nodejs-mobile Node-side API is reached through the app's native library
 * (`libnode`), started with the daemon's entry script. The two calls this
 * class needs from that layer are represented by [NodeRuntime]: start the
 * runtime, and exchange strings with it. Keeping that behind an interface is
 * what lets the bridge be unit-tested and lets the embedding be swapped
 * (nodejs-mobile today, a different host later) without touching protocol
 * code.
 */
class NodeBridge(
    private val context: Context,
    private val dispatcher: AdminDispatcher,
    private val runtime: NodeRuntime = NodeJsMobileRuntime(),
) {

    fun start() {
        runtime.start(context) { message -> onMessage(message) }
    }

    fun stop() {
        runtime.stop()
    }

    /**
     * Handle one inbound frame.
     *
     * Never throws: this runs on the runtime's callback thread, where an
     * escaping exception would take down the channel rather than reach any
     * caller. A frame we cannot answer is logged and dropped, and the
     * JavaScript side's per-call timeout turns the silence into a rejection.
     */
    private fun onMessage(message: String) {
        val frame = try {
            JSONObject(message)
        } catch (error: Throwable) {
            Log.w(TAG, "dropping unparseable frame from the daemon")
            return
        }
        val id = frame.opt("id")
        if (id !is Number) {
            Log.w(TAG, "dropping frame with no numeric id")
            return
        }
        val request = frame.optJSONObject("request")
        if (request == null) {
            Log.w(TAG, "dropping frame with no request payload")
            return
        }
        val result = dispatcher.dispatch(request)
        try {
            runtime.send(
                JSONObject().put("id", id).put("result", result).toString(),
            )
        } catch (error: Throwable) {
            Log.w(TAG, "could not answer frame $id", error)
        }
    }

    private companion object {
        const val TAG = "EndoNodeBridge"
    }
}

/**
 * The embedding seam: start an embedded Node runtime and exchange strings
 * with it.
 *
 * Mirrors, on this side of the channel, the same discipline the JavaScript
 * side applies to its transport — the platform-specific piece is one small
 * injectable interface, so everything above it is testable without it.
 */
interface NodeRuntime {
    /** Start the runtime and register the inbound message handler. */
    fun start(context: Context, onMessage: (String) -> Unit)

    /** Send one frame to the runtime. */
    fun send(message: String)

    /** Stop the runtime and release the channel. */
    fun stop()
}

/**
 * nodejs-mobile-backed [NodeRuntime].
 *
 * Left unimplemented on purpose rather than guessed at: the exact entry points
 * depend on which nodejs-mobile distribution the app links (the react-native
 * package and the bare `libnode` AAR expose different Java surfaces), and a
 * plausible-looking wrong binding here would fail only on a device — the one
 * place this project is trying not to discover things.
 *
 * Wiring this up is the remaining device-side work; see
 * `android/README.md` § "Remaining work".
 */
class NodeJsMobileRuntime : NodeRuntime {
    override fun start(context: Context, onMessage: (String) -> Unit) {
        TODO(
            "Bind to the chosen nodejs-mobile distribution: start libnode with " +
                "the daemon entry script and register the channel listener.",
        )
    }

    override fun send(message: String) {
        TODO("Forward the frame to the nodejs-mobile channel.")
    }

    override fun stop() {
        TODO("Stop the embedded runtime and release the channel.")
    }
}
