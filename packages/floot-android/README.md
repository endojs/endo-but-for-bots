# Floot for Android

Android shell for the same Endo Chat / Floot web interface used in the browser.
The app offers two connection modes:

- **This phone's Endo:** a packaged Rust/XS daemon with private persistent state,
  connected to the bundled web UI over a private Unix socket and CapTP.
- **Remote Endo:** paste the HTTPS web UI URL, including its `#gateway=…&agent=…`
  fragment, and tap **Connect** in the **Connection** menu.
  The app remembers it and does not start or expose its local daemon in this mode.

Choose **Use as assistant** from the toolbar menu to select Floot as the Android assistant.
System invocation opens the selected connection; recording still starts with the
Floot mic control, after Android grants microphone permission.
Closing or backgrounding the app stops local audio without cancelling accepted
agent work.

## Appearance and diagnostics

The native shell follows Android's system light/dark mode.
WebView passes the same preference to local and remote pages through
`prefers-color-scheme`; the shared UI follows it by default.
A saved space appearance override remains available in the shared UI.

Open the toolbar menu → **Diagnostics** to read app, WebView, voice-service, and
background daemon errors, or **Save logs…** to download a text report with Android's
system file picker.
The preview shows the latest 8 KiB from each log; exports include all retained logs.
Exports also work if Android recreates the app while the file picker is open.
Logs survive relaunch in app-private, non-backed-up storage.
Each of the three streams keeps two files of at most 256 KiB, with individual
messages capped at 8,192 characters; long daemon lines are truncated while reading.
Known URL fragments, Endo locators, and token fields are redacted.
Reports may still contain conversation or tool output; review before sharing.
Android may terminate background processes; the next connection reopens the same
Endo identity and durable store.

## Share Floot objects between Endo daemons

In the browser's Floot settings, choose **Export Floot objects…** and copy the
export.
On the phone, choose **This phone's Endo**, add a **Floot Chat** space, paste the
export, and create the space.
The controller and optional STT/TTS objects become named references in the
phone's inventory; execution and speech services remain on the exporting host.
Use the same import control in a desktop browser to import into another Endo.

An export conveys access to the selected controller and speech services.
It is not an expiring pairing code or an attenuated per-session grant.
Only share it with a trusted device, and ensure its Endo transport addresses are
reachable by the importing daemon.
Remote mode is the simplest option when you already have a working web UI URL.
Remote pages cannot access the phone's local daemon bridge.

## Build and test

The initial native runtime target is `arm64-v8a`, Android API 29 or later.
Install the Android SDK (platform 36), NDK, JDK 17 or newer supported by Gradle,
Rust's `aarch64-linux-android` target, and the repository's Yarn dependencies.
Initialize the pinned XS submodule before building:

```sh
git submodule update --init --depth 1 c/moddable
rustup target add aarch64-linux-android
export ANDROID_HOME=/path/to/android-sdk
export ANDROID_NDK_HOME="$ANDROID_HOME/ndk/29.0.14206865"
yarn workspace @endo/floot-android build
```

The debug APK is `android/app/build/outputs/apk/debug/app-debug.apk`.
Generated web assets and native binaries are ignored; rebuild them from source.
Gradle's wrapper is checked in.

```sh
yarn workspace @endo/floot-android test
yarn workspace @endo/chat test test/unit/android-connection.test.js test/unit/floot-transfer.test.js test/unit/floot-submission-client.test.js
yarn workspace @endo/floot test test/pending-queue.test.js test/session-submissions.test.js
```

Updated Floot hosts provide `enqueueOnce(text, requestId)` with durable receipts
for 24-hour retries, including after dispatch or host restart.
The shared UI saves the request ID before sending and restores unacknowledged
text on reconnect.
Unsent drafts are saved per session and survive system theme changes or relaunch.
Browser Web Locks coordinate receipt updates across views; an older browser
without Web Locks must be updated before sending.
Older hosts still accept text and voice, but an uncertain legacy submission is
never retried automatically or with a new ID.
Inspect the conversation before using **Clear unconfirmed submission…**.

See [DESIGN.md](./DESIGN.md) for boundaries, lifecycle, and remaining work.
