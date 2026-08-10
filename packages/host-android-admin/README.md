# @endo/host-android-admin

An unconfined Endo formula that mints an `AndroidAdmin` capability over the
privileged side of a device-owner application's bridge.

This is the device-side backend of the Android administration capability,
mirroring how `@endo/host-spawner` backs `@endo/exo-shell`. It supplies the
nodejs-mobile channel transport, an in-memory mock `DevicePolicyManager` for
desktop testing, and the device-side bring-up formula. The portable,
guest-facing exo lives in [`@endo/exo-android-admin`](../exo-android-admin).

It is **unconfined** because reaching the embedding's channel means reaching
the host module loader. Everything a guest can touch is the portable exo,
which holds no host authority of its own.

## Usage as a formula

The daemon's `make-unconfined` formula loads this module by file URL and calls
`make(powers, context, { env })`.

| `env` key       | required | meaning                                                                 |
| --------------- | -------- | ----------------------------------------------------------------------- |
| `policy`        | yes      | JSON policy: `allowedActions` plus optional `allowedPackages`, `allowedRestrictions`, `allowDestructive` |
| `bridge`        | no       | `'nodejs-mobile'` (default) or `'mock'`                                 |
| `channelModule` | no       | the embedding's bridge module specifier, default `'rn-bridge'`          |
| `timeoutMs`     | no       | per-call bound on the bridge, default `30000`                           |

There is deliberately **no default policy**: defaulting would mean guessing
how much authority over a physical device the operator meant to grant. An
unknown action name fails at bring-up rather than at first use.

## The formula returns a kit

A formula has exactly one result. Returning only the client would leave the
control facet — the sole means of re-scoping or revoking — unreachable, so
`make()` returns an `AndroidAdminKit`:

```js
const kit = await make(powers, context, { env });
const client = kit.client();   // vend this
const control = kit.control(); // keep this on the device
```

`client()` and `control()` are separate methods rather than a returned record
so that naming one in the daemon's pet store does not drag the other along
with it.

Formula cancellation revokes the capability and tears down the channel
subscription, rather than leaving a live administrative path to the device
behind.

## Bring-up

`src/setup-android.js` runs the device-side provisioning sequence: install the
iroh transport (so the device is reachable by NodeId with no open port), mint
the capability kit, and name both facets.

```sh
endo run --UNCONFINED packages/host-android-admin/src/setup-android.js \
  --powers @agent \
  -E ENDO_ANDROID_POLICY='{"allowedActions":["getDeviceState","lockNow"]}'
```

Then vend the client facet explicitly:

```
@hq android admin @android-admin
```

Vending is **not** automated by the bring-up script. Handing administrative
authority over a physical device to a remote peer is an act an operator should
perform explicitly, against a peer they have already accepted; a script that
auto-vended on boot would re-grant that authority on every restart, to
whatever peer currently holds the name.

## The mock bridge

`makeMockDeviceBridge()` implements the same wire contract the Kotlin side
implements — the same envelopes, the same error-as-data discipline — over a
fake `DevicePolicyManager` whose state the test can inspect:

```js
const { transport, state } = makeMockDeviceBridge({ deviceOwner: true });
const { client } = makeAndroidAdminAndControl({ transport, policy });

await E(client).setApplicationHidden('com.example.app', true);
t.deepEqual([...state.hiddenPackages], ['com.example.app']);
```

Pass `deviceOwner: false` to model an app that was never provisioned as device
owner: every privileged action then answers with a `SecurityException`, while
`getDeviceState` still answers — an operator has to be able to see *that*
provisioning failed.

The mock is **never selected implicitly**. A silent fall back to a fake device
would let a misconfigured deployment report success for administrative actions
that never touched hardware, so it requires an explicit `bridge: 'mock'`.

## The channel transport

`PROTOCOL.md` deliberately carries no correlation id: it assumes an ordered
channel and leaves multiplexing to the adapter. `makeChannelTransport` is that
layer. It frames each request with a monotonic id, matches replies back to
their pending call, and bounds every call with a timeout — so a wedged or
crashed Android side surfaces as a rejection rather than as a CapTP call that
never settles, which over a remote iroh link would look to the operator like a
hung console.

`stop()` unsubscribes and fails every in-flight call; it is wired to formula
cancellation.

## The honest boundary

The exo's policy check is the *guest-facing* bound. The Android side is the
real authority boundary and must independently refuse anything it is unwilling
to do. A bridge that trusts the envelope because "the exo already checked" has
moved the security boundary to the wrong side of the channel.

See
[`packages/daemon/designs/android-device-owner-agent.md`](../daemon/designs/android-device-owner-agent.md)
for the full design, including the device-owner application that hosts the
daemon and the layered testing strategy.
