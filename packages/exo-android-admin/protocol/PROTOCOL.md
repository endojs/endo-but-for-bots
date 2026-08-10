# AndroidAdmin bridge protocol, version 1

This is the wire contract between the portable `AndroidAdmin` exo (JavaScript,
running in an Endo worker) and the privileged Android side of the bridge
(Kotlin, holding `DevicePolicyManager`).

It is written down because it is a *language* boundary.
If each half infers the format from the other's source, the only place a
disagreement surfaces is a physical device — which is exactly what the
project's testing strategy exists to avoid.
Both halves are instead tested against the shared fixtures in
[`fixtures.json`](./fixtures.json).

## Transport assumptions

The protocol assumes only a bidirectional, ordered, message-oriented channel
carrying UTF-8 JSON documents.
It does not assume nodejs-mobile specifically.
Request/response correlation is the channel adapter's concern, not this
protocol's: an adapter that multiplexes concurrent calls adds its own
correlation id around these envelopes.

## Request envelope

Every call is a JSON object:

```json
{ "v": 1, "action": "setCameraDisabled", "args": { "disabled": true } }
```

| Field    | Type     | Meaning                                              |
| -------- | -------- | ---------------------------------------------------- |
| `v`      | integer  | Protocol version. Currently `1`.                     |
| `action` | string   | A name from the action catalog below.                |
| `args`   | object   | Named arguments, keyed per the catalog.              |

Rules:

- `args` keys are fixed by the catalog, not by the caller.
  The exo zips its positional method arguments against the catalog's argument
  names, so the wire shape cannot drift with a JavaScript calling convention.
- An omitted optional argument is **absent** from `args`, never present as
  `null`.
- The Android side MUST reject a request whose `v` it does not implement,
  rather than guessing at the argument shapes of a version it does not know.
  Reject with `error.name = "UnsupportedVersion"`.
- The Android side MUST reject an `action` outside its catalog with
  `error.name = "UnknownAction"`.
  It MUST NOT treat an unknown action as a no-op success.

## Result envelope

Success:

```json
{ "ok": true, "value": { "deviceOwner": true, "model": "SM-A375F" } }
```

Failure:

```json
{ "ok": false, "error": { "name": "SecurityException", "message": "Not device owner" } }
```

Rules:

- Failures are **data, not exceptions**.
  A JVM throwable cannot cross the channel as a JavaScript throw, so the
  Android side catches and encodes it; the JavaScript side rethrows locally
  from the envelope.
- `value` is omitted for actions that produce no result.
  The exo resolves such calls to `undefined` and does not surface any value
  the Android side may have returned.
- `error.message` MUST NOT carry secrets or host paths: it crosses to a
  remote holder as part of a rejection.

## Authority note

Policy enforcement lives in the **exo**, before a request is ever built, and
in the **Android side**, which is the real authority boundary.
This protocol carries no policy: an arriving request has already passed the
guest-facing allowlist, but the Android implementation must still refuse
anything it is not itself willing to do.
A bridge that trusts the envelope because "the exo already checked" has moved
the security boundary to the wrong side of the channel.

## Action catalog

`kind` is `query` (side-effect free), `mutate` (changes configuration), or
`destructive` (irreversible or service-interrupting; additionally gated by the
policy's `allowDestructive` flag).
`scope` names the policy allowlist constraining the action's subject, which is
always the first argument.

| Action                          | Kind        | Args                        | Scope       | Result                     |
| ------------------------------- | ----------- | --------------------------- | ----------- | -------------------------- |
| `getDeviceState`                | query       | —                           | —           | object, incl. `deviceOwner` |
| `listUserRestrictions`          | query       | —                           | —           | array of strings           |
| `isApplicationHidden`           | query       | `packageName`               | package     | boolean                    |
| `lockNow`                       | mutate      | —                           | —           | —                          |
| `setCameraDisabled`             | mutate      | `disabled`                  | —           | —                          |
| `setScreenCaptureDisabled`      | mutate      | `disabled`                  | —           | —                          |
| `setMaximumTimeToLock`          | mutate      | `timeMs`                    | —           | —                          |
| `setRequiredPasswordComplexity` | mutate      | `complexity`                | —           | —                          |
| `addUserRestriction`            | mutate      | `key`                       | restriction | —                          |
| `clearUserRestriction`          | mutate      | `key`                       | restriction | —                          |
| `setApplicationHidden`          | mutate      | `packageName`, `hidden`     | package     | —                          |
| `setUninstallBlocked`           | mutate      | `packageName`, `blocked`    | package     | —                          |
| `reboot`                        | destructive | —                           | —           | —                          |
| `wipeData`                      | destructive | `reason` (optional)         | —           | —                          |

`complexity` is one of `none`, `low`, `medium`, `high`, mapping to the
`DevicePolicyManager` password-complexity buckets.

The catalog's machine-readable source of truth is `ACTIONS` in
[`../src/protocol.js`](../src/protocol.js).
This table and that object must agree; a test asserts the fixtures cover every
catalog entry, so an action added without a fixture fails CI.

## Versioning

`v` increments when an existing action's argument or result shape changes, or
when an action is removed.
**Adding** an action does not bump `v`: an older Android build simply reports
`UnknownAction`, which the JavaScript side surfaces as an ordinary failure.

## Testing both halves

`fixtures.json` holds representative request/response pairs.
Each entry is:

```json
{
  "name": "setCameraDisabled/true",
  "action": "setCameraDisabled",
  "positional": [true],
  "request": { "v": 1, "action": "setCameraDisabled", "args": { "disabled": true } },
  "result": { "ok": true },
  "value": null
}
```

- The **JavaScript** side asserts that calling the exo method with
  `positional` produces exactly `request`, and that feeding back `result`
  resolves to `value` (`null` standing for `undefined`, which JSON cannot
  represent).
- The **Kotlin/Robolectric** side asserts the mirror image: decoding
  `request` dispatches to the expected `DevicePolicyManager` call, and its
  outcome encodes to `result`.

Neither side needs the other to run, and neither needs a device, so wire drift
fails in CI on both sides independently.
