# Endo Android device-owner agent

The Android application that hosts an Endo daemon on a device and exposes
`DevicePolicyManager` to it as a confined capability, so a remote HQ daemon can
administer the device over an authenticated, encrypted peer connection.

Full design, including why this is an application rather than a Termux script:
[`packages/daemon/designs/android-device-owner-agent.md`](../packages/daemon/designs/android-device-owner-agent.md).

## Modules

The project is split along the one seam that decides how much can be tested
without hardware.

| Module | What it is | Needs an Android SDK? |
| --- | --- | --- |
| `:protocol` | The bridge protocol, its action catalog, and the dispatcher. Pure JVM Kotlin, no Android imports. | **No** |
| `:app` | The device-owner application: receiver, foreground service, `DevicePolicyManager` implementation, Node embedding. | Yes |

`settings.gradle.kts` includes `:app` only when an SDK is detected, so
`gradle :protocol:test` runs in ordinary CI on a machine that has never seen
the Android toolchain.

## Running the protocol tests

```sh
cd android
gradle :protocol:test
```

These are the Kotlin half of the cross-language contract. They read
[`packages/exo-android-admin/protocol/fixtures.json`](../packages/exo-android-admin/protocol/fixtures.json)
— the very file the JavaScript suite is pinned to, not a copy — and assert the
mirror image of what the JavaScript side asserts:

| Side | Asserts |
| --- | --- |
| JavaScript (`yarn workspace @endo/exo-android-admin test`) | the exo **produces** each fixture request and **consumes** each fixture result |
| Kotlin (`gradle :protocol:test`) | decoding each request **reaches** the expected operation and its outcome **encodes** to that result |

Neither side needs the other to run, and neither needs a device, so wire drift
fails in CI on whichever half drifted instead of being discovered on a phone.

The suite also enforces that the two catalogs agree — every catalog action has
a fixture, every fixture action is in the catalog, and every fixture's argument
keys are declared by the catalog — so adding an action to one language without
the other fails the build.

## Provisioning

Device owner can only be set on a device with **no accounts added**, so an
already-configured phone costs a factory reset.

```sh
# On a factory-fresh device, before signing into any account:
adb install app-release.apk
adb shell dpm set-device-owner com.endojs.androidadmin/.AdminReceiver
```

Verify:

```sh
adb shell dumpsys device_policy | grep -i "device owner"
```

## Architecture

```
  ┌──────────── Android device — com.endojs.androidadmin ─────────────┐
  │                                                                    │
  │  AdminReceiver ──────────────▶ DevicePolicyManager (device owner)  │
  │        ▲                                ▲                          │
  │  EndoDaemonService (foreground)   DevicePolicyAdminOperations      │
  │        │                                ▲                          │
  │        │                          AdminDispatcher  ← :protocol,    │
  │        │                                ▲            pure JVM,     │
  │        └──── NodeBridge ────────────────┘            fully tested  │
  │                  ▲ { id, request } / { id, result }                │
  │           NodeRuntime (nodejs-mobile)                              │
  │                  ▲                                                 │
  │           embedded Endo daemon ── vends AndroidAdmin over iroh ──▶ │
  └────────────────────────────────────────────────────────────────────┘
```

`AdminDispatcher` — the part that decodes, validates, and routes every
privileged request — carries no Android dependency, which is why the protocol
is fully covered by tests that run anywhere.

## The authority boundary is here, not in JavaScript

The JavaScript exo checks its policy before building a request, but that check
lives on the far side of an IPC channel. `DevicePolicyAdminOperations`
re-asserts device-owner status on every privileged call rather than trusting
that an arriving request was authorized. A bridge that trusted the envelope
because "the exo already checked" would have moved the security boundary to the
wrong side of the channel.

`getDeviceState` is the one action that answers without device-owner status: an
operator has to be able to see *that* provisioning failed, and a bare refusal is
indistinguishable from an unreachable device.

## Remaining work

Everything below the protocol layer is written but unverified, because this
repository's CI has no Android SDK. In dependency order:

1. **Bind `NodeJsMobileRuntime`.** Its three methods are deliberately `TODO()`
   rather than guessed: the Java surface differs between the
   nodejs-mobile-react-native package and the bare `libnode` AAR, and a
   plausible-looking wrong binding would fail only on a device. Pick a
   distribution, then implement start / send / stop against it.
2. **Confirm the Node version.** `@number0/iroh` declares
   `engines.node >= 20.3.0`, which is now the binding constraint on which
   nodejs-mobile build can be embedded (the `aarch64-linux-android` iroh
   prebuilt itself already exists — see the design's "iroh on device").
3. **Opt into the Android architecture when bundling the daemon.** The iroh
   prebuilt is gated by `os: ['android']` / `cpu: ['arm64']`, so a build run on
   a laptop will not fetch it by default. Under Yarn 4 use
   `supportedArchitectures` in `.yarnrc.yml`; under npm, `--os=android
   --cpu=arm64`. Skipping this yields a daemon that starts and then reports no
   iroh transport, which reads like a code bug rather than a packaging one.
4. **Compile `:app`.** It has never been through a compiler; expect the usual
   first-build corrections.
5. **Emulator tests (design levels L6–L7).** Provisioning on a fresh AVD, the
   daemon answering `ping`, a real DPM effect observed through
   `adb shell dumpsys device_policy`, and survival across
   `dumpsys deviceidle force-idle` and `am kill`.

Only after those does the physical Galaxy A37 have anything left to prove:
Samsung One UI's real battery and background-kill behaviour, Knox interactions,
and any A37-specific `DevicePolicyManager` deviations.
