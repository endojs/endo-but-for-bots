# On-Device Android Admin Agent for the Endo Daemon

Status: Proposed.
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

The iroh transport needs a working `@number0/iroh` NAPI binding for the
device ABI. Two paths, tried in order:

- **Path A — cross-compile `@number0/iroh` for `aarch64-linux-android`.**
  nodejs-mobile is standard-ABI Node and napi-rs supports the Android
  target, so a from-source build should load and let us reuse `iroh.js`
  verbatim. Least new code.
- **Path B — run iroh natively in Kotlin via `iroh-ffi`.** iroh ships
  officially supported Android/Kotlin bindings. We run the endpoint in
  Kotlin, bridge each QUIC bidirectional stream over the nodejs-mobile
  channel, and add a small transport module that feeds the existing
  `adaptIrohStream` → `makeNetstringCapTP` path. More code, but it keeps
  Rust out of the Node ABI and uses the most Android-native iroh path.

Path A is preferred for reuse; Path B is the fallback and may become
primary if the NAPI build proves brittle on the target.

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
3. **The iroh native binding.** Path A depends on a successful
   `aarch64-linux-android` build of `@number0/iroh`; Path B trades that for
   a Kotlin bridge and a new transport adapter. Validate one of these
   early — the rest of the design assumes an iroh path exists on device.

## Build order

The in-repo, reusable pieces are independent of the Android shell and can
land and be tested on a desktop daemon first:

1. `exo-android-admin` — portable exo, `Client`/`Control` split, policy
   allowlist, `revoke()`, interface guards, against the `exo-shell` layout.
2. `host-android-admin` — unconfined backend with the injected `transport`
   seam, mockable so the admin surface is testable without a device.
3. `setup-android.js` — boot-time formula: install iroh, mint the admin
   exo, invite/adopt HQ.

The Android application shell — Kotlin DPC + `DeviceAdminReceiver` +
foreground service + nodejs-mobile embed + supervisor + JNI channel +
`DevicePolicyManager` invocations — is a separate deliverable that consumes
the `transport` seam exposed by `host-android-admin`.

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
