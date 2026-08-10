# @endo/exo-android-admin

Remotable exo glue, interface guards, and the wire protocol for an
`AndroidAdmin` capability: a policy-bounded surface over an Android device's
`DevicePolicyManager`, split into a vendable client facet and a host-retained
control facet. Portable across SES realms; pair it with
`@endo/host-android-admin` for the privileged device-side bridge.

This is the portable half of the Android administration capability, mirroring
how `@endo/exo-shell` is the portable half of the Shell capability and
`@endo/host-spawner` supplies the host-side engine.

```js
import { makeAndroidAdminAndControl } from '@endo/exo-android-admin';

const { client, control } = makeAndroidAdminAndControl({
  transport, // the seam to the privileged Android side
  policy: {
    allowedActions: ['getDeviceState', 'lockNow', 'setApplicationHidden'],
    allowedPackages: ['com.example.app'],
    // allowDestructive defaults to false: reboot and wipeData are refused.
  },
});

await E(client).lockNow();
await E(client).setApplicationHidden('com.example.app', true);

control.revoke(); // severs `client` and everything derived from it
```

## The facet split

The host constructs the pair and **keeps `control`**; only `client` is ever
vended to a remote peer.

| | `AndroidAdmin` (client) | `AndroidAdminControl` |
| --- | --- | --- |
| Invoke permitted actions | ✅ | ❌ |
| `attenuate()` — derive a weaker facet | ✅ | ❌ |
| `inspect()` the bounds in force | ✅ | ✅ |
| `setPolicy()` — may **widen** authority | ❌ | ✅ |
| `revoke()` | ❌ | ✅ |

`setPolicy` is the reason the split exists: it can widen authority, which is
precisely the power a guest must not hold.

## Policy

Every call is checked against the policy **before a request is built**, so an
unauthorized action never reaches the privileged side of the bridge at all.

```ts
type AdminPolicy = {
  allowedActions: readonly string[];      // required; nothing is reachable by default
  allowedPackages?: readonly string[];    // for package-scoped actions
  allowedRestrictions?: readonly string[];// for restriction-scoped actions
  allowDestructive?: boolean;             // gates reboot / wipeData
};
```

Checks escalate: the action must be named; a `destructive` action must
additionally clear `allowDestructive`; and a scoped action's subject — always
its first argument — must appear in the matching allowlist. An unknown action
name in a policy is rejected outright rather than ignored, because silently
dropping a typo would produce a capability quietly weaker than the operator
believes they granted.

## Attenuation narrows, never widens

`client.attenuate(restriction)` returns a facet whose bounds are the
*intersection* of the parent's with `restriction`. Delegation can therefore
only reduce authority.

The intersection is recomputed against the live parent on every call, so
narrowing the parent through `control.setPolicy()` — or revoking it — also
narrows or kills every facet already derived from it. Revocation is one shared
cell for the whole family, not a copied flag.

```js
const cameraOnly = E(client).attenuate({ allowedActions: ['setCameraDisabled'] });
// cameraOnly can never regain lockNow, no matter what it asks for.
```

## The transport seam

The exo holds no Android, Node, or channel authority of its own — only an
injected transport:

```ts
type AdminTransport = (request: AdminRequest) => Promise<AdminResult>;
```

That single seam is what makes the whole guest-facing surface testable on a
desktop daemon against a mock bridge, reserving a physical device for
acceptance testing.

## The protocol is a written contract

Because the bridge is a *language* boundary, the wire format is specified
rather than inferred:

- [`protocol/PROTOCOL.md`](./protocol/PROTOCOL.md) — the envelope, the
  version-negotiation rule, and the action catalog.
- [`protocol/fixtures.json`](./protocol/fixtures.json) — golden
  request/response pairs. The JavaScript half asserts it *produces* those
  requests and *consumes* those responses; the Kotlin/Robolectric half asserts
  the mirror image. Wire drift fails in CI on both sides independently, so
  agreement never has to be demonstrated on the phone.
- [`src/protocol.js`](./src/protocol.js) — the machine-readable catalog the
  guards, the policy, and the fixtures all derive from. Adding an action means
  adding one catalog entry.

## The honest boundary

Policy enforcement here is the *guest-facing* bound, not the authority
boundary. The Android side is the real boundary and must independently refuse
anything it is unwilling to do; a bridge that trusts the envelope because "the
exo already checked" has moved the security boundary to the wrong side of the
channel.

Treat a vended client as live authority over a physical device within its
policy. Scope it to the minimum the holder needs, and prefer several narrow
capabilities over one broad one.

See
[`packages/daemon/designs/android-device-owner-agent.md`](../daemon/designs/android-device-owner-agent.md)
for the full design, including the device-owner application that hosts the
daemon and the layered testing strategy.
