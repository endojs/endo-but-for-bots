# On-Device Android Admin Agent for the Endo Daemon

Status: Partially implemented.
Testing levels L1–L5 are green: both JavaScript halves
(`@endo/exo-android-admin`, `@endo/host-android-admin`), the cross-daemon vend
test, and the pure-JVM Kotlin protocol module (`android/protocol`) all pass
without a device.
Remaining: the Node embedding inside the Android app, compiling `android/app`,
and the emulator levels (L6–L7).
Owner: daemon / device-management.

## Motivation

We want a single Android device — a Samsung Galaxy A37 is the concrete
target — to run an Endo daemon persistently in the background and vend a
confined *device-administration* capability to a remote "HQ" daemon, so
that HQ can configure and manage the device remotely over an
authenticated, encrypted peer connection.

The daemon already has everything needed to vend a capability to a remote
peer: guests hold remotable capabilities over CapTP, object identity is
preserved across the wire, and the iroh transport dials peers by their
Ed25519 `NodeId` with no open port, public IP, or self-hosted
infrastructure (see [iroh-network-design.md](./iroh-network-design.md)).
The two hard parts are Android-specific and orthogonal to the daemon's
capability model:

1. **Privilege.** Real administration (`DevicePolicyManager` — lock, wipe,
   password policy, app install/uninstall, restrictions, kiosk) requires
   the agent to be provisioned as the device's *device owner*. An
   unprivileged process cannot reach these APIs.
2. **Survival.** The agent must stay alive in the background against One
   UI's aggressive process reclamation, across Doze and device reboots.

This document captures the chosen design: a purpose-built device-owner
Android application that embeds the Endo daemon and bridges it to
`DevicePolicyManager`, rather than running the daemon under Termux.

## Why not Termux

Termux was the first candidate because it can host Node with the least
custom code, but it fails both hard requirements:

- **A Termux process can never be device owner.** Device owner is a
  property of an *installed application* bound to a `DeviceAdminReceiver`;
  Termux is not that application. The best a Termux-hosted daemon could do
  is shell out to `dpm`, which itself needs root, and even then it cannot
  reach the full `DevicePolicyManager` surface in-process.
- **Background survival is fragile.** On a Samsung mid-range device a
  backgrounded Termux session is reclaimed quickly; `termux-wake-lock`
  plus Termux:Boot is a workaround, not a guarantee.
- **The iroh binding needs a real Linux ABI.** `@number0/iroh` is a native
  NAPI addon; under bare Termux it typically requires `proot-distro` to
  load, adding a second moving part with its own lifecycle.

A device-owner application solves all three cleanly: it *is* the DPC, it
can run a foreground service and grant itself a battery-optimization
exemption, and it controls its own native ABI.

## Design

### Runtime topology

```
  ┌──────────── Galaxy A37 — agent app (com.you.endoadmin) ────────────┐
  │                                                                     │
  │  DeviceAdminReceiver ─────────▶ DevicePolicyManager  (device owner) │
  │        ▲ in-process, privileged                                     │
  │  ┌─────┴──────────── JNI / nodejs-mobile channel ───────────────┐   │
  │  │  endo daemon (nodejs-mobile, real Node aarch64)              │   │
  │  │    ├─ android-admin exo   Control facet stays here           │   │
  │  │    │        Client facet ──vended over iroh──▶ HQ            │   │
  │  │    ├─ NETS/iroh           listener, stable NodeId            │   │
  │  │    └─ workers ← app plays the "spawn envelope" supervisor    │   │
  │  └──────────────────────────────────────────────────────────────┘   │
  │  Foreground service + device-owner battery exemption → unkillable  │
  └─────────────────────────────────────────────────────────────────────┘
                        ▲ iroh QUIC (CapTP), dial-by-key
                        │
  ┌─────────────────────┴──────────── HQ machine ─────────────────────┐
  │  endo daemon → holds a LIVE remote ref to the Client facet         │
  │  E(remoteAdmin).lockNow()  ──round-trips to the device──▶          │
  └───────────────────────────────────────────────────────────────────┘
```

The agent application wears five hats:

1. **Device-owner DPC** — a `DeviceAdminReceiver` provisioned as device
   owner, giving in-process access to `DevicePolicyManager`.
2. **Foreground service** — keeps the process resident and exempt from
   battery optimization.
3. **Daemon host** — embeds the Endo daemon via nodejs-mobile (real Node
   for `aarch64-linux-android`).
4. **Worker supervisor** — implements the daemon's spawn-envelope
   protocol so the daemon does not rely on `child_process.fork()`.
5. **Admin bridge** — exposes a single privileged call surface from the
   Node daemon to Kotlin/`DevicePolicyManager`.

### The capability split

The device-administration capability follows the repository's standard
two-package pattern (`exo-http-client` + backend, `exo-shell` +
`host-spawner`):

- **`exo-android-admin`** — the portable, SES-safe half. A `makeExo` +
  `M.interface()` remotable that enforces the guest-facing policy and
  splits into a **`Client` facet** (vended to HQ) and a **`Control`
  facet** (retained on the device). `makeAndroidAdminAndControl({ transport,
  policy }) → { client, control }`, mirroring
  `makeHttpClientAndControl`. The policy is an allowlist of permitted DPM
  actions and, where relevant, target package names; a per-call value may
  only *narrow* it, never widen it. `control` carries `setPolicy()` and
  `revoke()`.
- **`host-android-admin`** — the unconfined backend. Its `make(powers,
  context, { env })` entry point constructs the exo with a real
  `transport`: a single injected async function `(action, args) => result`
  that marshals the call across the nodejs-mobile channel into Kotlin,
  where `DevicePolicyManager` is invoked in-process. The same seam accepts
  a mock transport so the entire admin surface is testable on a desktop
  daemon before the Android shell exists.

Only the `Client` facet is ever sent to HQ. The `Control` facet stays on
the device, so policy can be re-scoped or the capability revoked without
HQ's cooperation.

### The bridge protocol is an explicit versioned contract

The `transport` seam is a language boundary, so it is specified rather than
left implicit. If the JavaScript and Kotlin halves each invent their own
marshalling, the only place their disagreement surfaces is the physical
device — exactly the outcome the testing strategy exists to avoid.

The contract is therefore:

- **A versioned request envelope.** Every call is a hardened, JSON-able
  record `{ v, action, args }`, where `v` is the protocol version, `action`
  is a name from a closed catalog, and `args` is a record whose shape the
  catalog fixes per action.
- **An explicit result envelope.** Kotlin answers with
  `{ ok: true, value }` or `{ ok: false, error: { name, message } }`.
  Errors are *data*, not exceptions: a JVM exception cannot cross the
  channel as a JS throw, so the backend rethrows locally from the envelope.
- **A closed action catalog.** Actions and their argument shapes live in
  one portable module (`exo-android-admin/src/protocol.js`), which the exo's
  interface guards, the policy allowlist, and the fixtures all derive from.
  Adding an action means adding one catalog entry, not touching four files.
- **Golden fixtures as the cross-language oracle.** A checked-in
  `protocol/fixtures.json` enumerates representative request/response pairs.
  The JS side asserts it *produces* those requests and *consumes* those
  responses; the Kotlin/Robolectric side asserts the mirror image. Wire drift
  fails in CI on both sides independently, so agreement never has to be
  demonstrated on the phone.
- **`PROTOCOL.md`** documents the envelope, the version-negotiation rule
  (the app rejects a request whose `v` it does not implement), and the
  catalog, so the Kotlin implementation has a written spec rather than
  JavaScript to reverse-engineer.

### Provisioning and vending flow

Installed once at boot, a `setup-android.js` formula (an unconfined caplet,
like `setup-iroh.js`) performs the whole bring-up:

1. Install the iroh transport (`provideWorker`, `makeUnconfined` of
   `iroh.js`, `move` to `@nets/iroh`) so the device has a stable iroh
   `NodeId`.
2. Mint the admin exo via `makeUnconfined` of `host-android-admin`, naming
   the result `android-admin`.
3. Create an invitation naming the known HQ peer, or accept HQ's
   invitation, establishing the CapTP session.
4. Vend the `Client` facet to HQ by attaching it to a message
   (`@hq android-admin @android-admin`); HQ adopts it under a local pet
   name (e.g. `remote-device`).

From then on HQ holds a live remote reference. `E(remoteDevice).lockNow()`
and friends round-trip over iroh to the device and execute against
`DevicePolicyManager`.

### Worker model

The daemon does not have to fork Node processes inside the app. Worker
spawning is already abstracted behind a "spawn envelope" protocol:
`bus-manager-node-powers.js` and `manager-go-powers.js` delegate spawning
to an external supervisor instead of calling `child_process.fork()`, and
`manager-webextension.js` is a precedent for a constrained embedder. The
agent app implements the supervisor side of this protocol. For a
management-only control plane, a single worker (or an in-process worker
configuration) is sufficient, which keeps the embedding small.

### iroh on device

**Resolved: a prebuilt already exists — no cross-compilation needed.**

The original plan assumed we would have to cross-compile `@number0/iroh` for
`aarch64-linux-android`, and treated that as the design's largest open risk.
Checking the published package settles it:

- `@number0/iroh`'s `napi.targets` list includes `aarch64-linux-android`, and
  it declares `@number0/iroh-android-arm64` as an `optionalDependency`
  (`armv7-linux-androideabi` / `@number0/iroh-android-arm-eabi` are published
  too, for 32-bit devices).
- `@number0/iroh-android-arm64` is published at both `1.0.0` and `1.1.0`,
  inside the daemon's existing `^1.0.0` range.
- Its payload, `iroh.android-arm64.node`, is a real *ELF 64-bit LSB shared
  object, ARM aarch64*, linked against bionic (`libc.so`, `libdl.so`,
  `libm.so`) — an Android NDK build, not a repackaged Linux one.
- `@number0/iroh`'s loader already branches on
  `process.platform === 'android'` and requires the arm64 binding, so
  resolution needs no patching.

So Path A collapses to "install the dependency", and
`packages/daemon/src/networks/iroh.js` should run **verbatim** on device.

Two practical consequences, neither of them blocking:

- **The prebuilt is gated by `os: ['android']` / `cpu: ['arm64']`.** A build
  running on a developer's laptop will *not* fetch it by default. The app's
  bundling step must ask for it explicitly — under Yarn 4, via
  `supportedArchitectures` in `.yarnrc.yml`; under npm, via
  `--os=android --cpu=arm64`. Forgetting this yields a daemon that starts and
  then reports no iroh transport, which reads like a code bug rather than a
  packaging one.
- **`@number0/iroh` declares `engines.node >= 20.3.0`.** This, not the
  binding, is now the real constraint: the embedded runtime must be a
  nodejs-mobile build on Node 20.3 or newer. Confirm the chosen
  nodejs-mobile build's Node version before committing to the embedding —
  it is the one remaining item on this path that a published artifact does
  not already answer.

**Path B — run iroh natively in Kotlin via `iroh-ffi`** — remains the
fallback: iroh ships officially supported Android/Kotlin bindings, and we
would bridge each QUIC bidirectional stream over the nodejs-mobile channel
into the existing `adaptIrohStream` → `makeNetstringCapTP` path. It is now
only worth reaching for if the nodejs-mobile Node version cannot satisfy
`engines.node`, or if loading a 19 MB NAPI module inside the app process
proves problematic in practice.

## Security and trust

This vends high, network-reachable authority over a physical device, so
the boundaries matter:

- **Facet asymmetry.** HQ receives only the `Client` facet; the device
  keeps `Control`. Revocation and re-scoping are unilateral from the
  device side.
- **Policy allowlist at the boundary.** The exo enforces which DPM actions
  and which target packages are permitted, at the `makeExo` guard, before
  any privileged call reaches Kotlin. Per-call parameters may only narrow.
- **Peer authentication.** iroh connections are mutually authenticated and
  encrypted QUIC; the device pins HQ's `NodeId`, so only the invited peer
  can dial and adopt the capability.
- **Blast radius.** Treat the vended `Client` facet as full live device
  authority within its policy: a compromised HQ daemon is, within that
  policy, a compromised device. Scope the allowlist to the minimum HQ
  actually needs, and prefer several narrowly-scoped capabilities over one
  broad one.
- **Identity caveat inherited from iroh.** The device's iroh identity is
  currently derived from its public `NodeNumber`, not its root private key
  (see [iroh-network-design.md](./iroh-network-design.md) § Identity and
  trust). The same limitation and end-state apply here.

## Risks

Ranked by how much they gate the work:

1. **Device-owner provisioning requires a clean device.** Device owner is
   exclusive and must be set before any account is added:
   factory-reset the A37, then
   `adb shell dpm set-device-owner com.you.endoadmin/.AdminReceiver`.
   Samsung/Knox is Android-Enterprise compatible and standard DPM needs no
   Knox license, but an already-configured device costs a factory reset.
   This is operational, not technical, and should be planned first.
2. **Embedding and the worker supervisor.** nodejs-mobile provides the Node
   runtime; the effort is wiring the spawn-envelope supervisor to it and
   choosing a worker topology. A single/in-process worker keeps this
   contained.
3. ~~**The iroh native binding.**~~ **Retired.** A prebuilt
   `@number0/iroh-android-arm64` is published in the daemon's existing
   version range and is a genuine bionic-linked aarch64 build, and the
   package's loader already resolves it on `process.platform === 'android'`
   (see § iroh on device). What remains is not a risk but two build-time
   chores: opt into the Android architecture when bundling, and confirm the
   nodejs-mobile build satisfies `engines.node >= 20.3.0`.

## Build order

The in-repo, reusable pieces are independent of the Android shell and can
land and be tested on a desktop daemon first:

1. ✅ `exo-android-admin` — portable exo, `Client`/`Control` split, policy
   allowlist, `revoke()`, interface guards, against the `exo-shell` layout,
   with the protocol catalog, `PROTOCOL.md`, and `protocol/fixtures.json`
   that both halves are tested against.
   Adds `attenuate()`, which intersects against the live parent bounds on
   every call, so narrowing or revoking a parent also narrows or kills every
   facet derived from it.
2. ✅ `host-android-admin` — unconfined backend with the injected `transport`
   seam, a channel transport for the nodejs-mobile bridge, and a mock
   `DevicePolicyManager` bridge so the admin surface is testable without a
   device.
   The formula returns an `AndroidAdminKit` rather than a bare client,
   because a formula has one result and returning only the client would
   leave the control facet unreachable.
3. ✅ `setup-android.js` — boot-time formula: install iroh, mint the admin
   exo, name both facets.
   Vending is deliberately left to an explicit operator act rather than
   automated on boot.

Remaining, in dependency order: the L2 cross-daemon vend test
(§ Testing strategy), the Android application shell, and the Kotlin half of
the protocol tested against the same fixtures.

The Android application shell — Kotlin DPC + `DeviceAdminReceiver` +
foreground service + nodejs-mobile embed + supervisor + JNI channel +
`DevicePolicyManager` invocations — is a separate deliverable that consumes
the `transport` seam exposed by `host-android-admin`.

## Testing strategy

The design's central seam — the `transport` function
`(action, args) => result` between `host-android-admin` and Kotlin — is
also the *test* seam. Everything above it is portable JavaScript that runs
under desktop Node; everything below it is OS integration. The goal is to
push as much coverage as possible above the seam and onto a *disposable
emulator*, reserving the physical A37 for a final acceptance pass and
Samsung-specific quirks a device farm cannot reproduce.

The layers, cheapest and most deterministic first:

### L1 — Exo policy and guard units (desktop AVA, no device) ✅

Test `exo-android-admin` against a **recording mock transport** that
captures `(action, args)` without touching Android. Assertions:

- The `M.interface()` guard rejects malformed calls at the boundary.
- The policy allowlist admits only permitted actions and target packages,
  and a per-call parameter can only *narrow*, never widen (mirror the
  `exo-shell` timeout-narrowing tests).
- The `Client` facet exposes no control methods; `Control.setPolicy()` and
  `Control.revoke()` behave, and post-revoke calls on the vended `Client`
  fail closed.

These are pure, fast, and need no daemon fork.

### L2 — Cross-daemon vend integration (desktop AVA, two local daemons) ✅

Prove the actual "vend admin control to HQ" mechanism without a phone.
Following the daemon's existing gateway/multiplayer tests
(`test.serial`, `ENDO_ADDR=127.0.0.1:0`, `t.teardown` for every forked
daemon and temp dir): stand up two daemons in temp state trees, install a
**fake `android-admin`** backed by an in-JS fake `DevicePolicyManager`,
connect them (loopback TCP is enough here — cheaper than iroh), vend the
`Client` facet, and have the HQ side invoke methods. Assert that calls
arrive at the fake DPM with the exact marshalled args, that object identity
and facet asymmetry hold across CapTP, and that `Control.revoke()` on the
device side severs the HQ reference. This is the highest-value test: it
exercises the whole capability path end to end minus the OS.

### L3 — Contract fixtures shared by both halves ✅

Define the admin protocol as a fixed set of `(action, args) => result`
golden fixtures. The JS side (L1/L2) asserts it *produces* exactly these
payloads; the Kotlin bridge (L4) asserts it *consumes* them and calls the
right `DevicePolicyManager` method. Because both halves are tested against
the same fixtures, the device is never needed to prove the two agree — a
wire-format drift fails in CI, not on the phone.

### L4 — JVM bridge contract (plain JVM, no device/emulator) ✅

Implemented as `android/protocol` — and Robolectric turned out to be
unnecessary. Splitting the Kotlin so the catalog, envelope codec, and
dispatcher carry *no* Android dependency means they compile and run on a
plain JDK: `gradle :protocol:test` replays the L3 fixtures through the real
decoder and asserts each dispatches to the expected operation with correctly
unmarshalled arguments, with no SDK, no emulator, and no Robolectric.

`settings.gradle.kts` includes the Android `:app` module only when an SDK is
detected, so these tests run in ordinary CI. The suite additionally enforces
that the two language catalogs agree in both directions and that every
fixture's argument keys are catalog-declared, so adding an action to one
language without the other fails the build. Verified by mutation: renaming a
single wire key in the dispatcher fails the fixture test.

### L5 — iroh-on-device transport check (arm64 CI, not the phone) — partly resolved

The larger half of this is already answered off the shelf: a prebuilt
`aarch64-linux-android` binding is published and the loader resolves it
(§ iroh on device), so "does a binding exist for the target" no longer needs
testing. What remains is to assert on an `aarch64-linux` CI runner that the
binding *loads* under the embedded runtime and that two peers complete a
CapTP round-trip over iroh loopback, reusing the daemon's existing iroh
discovery tests. The device should still never be where we discover a load
failure.

### L6 — Emulator instrumented tests (CI, disposable AVD)

Only the parts that genuinely cannot be faked run here, on a
factory-fresh emulator — which, unlike a daily-driver phone, can be
provisioned as device owner and wiped freely:

- **Provisioning:** `adb shell dpm set-device-owner …` on a freshly booted
  AVD (no accounts), then assert the app reports device-owner status.
- **Embedding:** the app boots, starts the embedded daemon, and the daemon
  answers `ping` over its socket.
- **Real DPM effect:** drive a whitelisted action (e.g. password-quality
  policy) and assert it via `adb shell dumpsys device_policy`.
- **Survival:** simulate Doze (`adb shell dumpsys deviceidle force-idle`)
  and a background kill (`am kill`), then assert the foreground service and
  boot receiver bring the daemon back.

Because the embedded daemon is *the same bundle* that L1–L2 cover under
desktop Node, the emulator only has to validate the embedding and the OS
integration — not the daemon logic again.

### L7 — Emulator end-to-end smoke (CI)

One gate that ties it together with no physical device: emulator (agent) +
a local HQ daemon on the CI host, a real vend over the chosen transport,
HQ issues a whitelisted DPM command, and the effect is observed via
`adb shell dumpsys device_policy`. This is the "does the whole thing work
remotely" check.

### What still needs the A37

After L1–L7 are green, the residual manual pass on the physical device
covers only what an emulator cannot: Samsung One UI's real battery/Doze
behavior and background-kill aggressiveness, Knox interactions, and any
A37-specific `DevicePolicyManager` deviations. That is a short acceptance
checklist, not a test-development effort.

## References

- [iroh-network-design.md](./iroh-network-design.md) — the iroh transport,
  identity model, and address scheme this design builds on.
- `packages/exo-http-client`, `packages/exo-shell`, `packages/host-spawner`
  — the portable-exo + host-backend split this design mirrors.
- `packages/daemon/src/networks/setup-iroh.js` — the unconfined
  network-install formula pattern `setup-android.js` follows.
- `packages/daemon/src/bus-manager-node-powers.js`,
  `packages/daemon/src/manager-go-powers.js`,
  `packages/daemon/src/manager-webextension.js` — the spawn-envelope worker
  supervisor seam the agent app implements.
- `packages/daemon/MULTIPLAYER.md` — invitation, accept, attach, and adopt
  flow for vending a capability to a remote peer.
