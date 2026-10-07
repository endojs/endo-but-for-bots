# Hardened `TextEncoder` / `TextDecoder` Vetted Shim

| | |
|---|---|
| **Created** | 2026-05-04 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Revised — permits landed upstream (endojs/endo#3322); encapsulation revision in PR [#1349](https://github.com/endojs/endo-but-for-bots/pull/1349) |

## What is the Problem Being Solved?

Endo's hardened-JavaScript model rests on the premise that every
intrinsic shared between fearlessly coöperating compartments is either
a powerless data constructor or has been carefully tamed.
The host's `TextEncoder` and `TextDecoder` constructors are broadly
useful (UTF-8 round-tripping for byte-oriented work, the canonical
portable alternative to Node's `Buffer`) and would be welcome
additions to the permitted intrinsics.

Unlike `URL`, the text codecs have no ambient-authority static
methods and no exposed iterator prototype, so the taming story is
straightforward: list them on `universalPropertyNames`, sample
during the existing intrinsics-collection pass, and harden.

This work targets the same source as the URL shim
([endojs/endo#2635](https://github.com/endojs/endo/issues/2635)) but
is split out as its own design because the implementation has no
overlap with the URL/SharedURL split.

## Design

### Integration: `universalPropertyNames`

`packages/ses/src/permits.js` distinguishes three relevant buckets:

- `universalPropertyNames`: powerless data and constructors that live
  on every global (the start compartment and every compartment
  created after lockdown).
- `initialGlobalPropertyNames`: the powered variants that live only
  on the start compartment (`Date`, `Error`, `RegExp`, `Math`).
- `sharedGlobalPropertyNames`: the tamed, powerless variants of those
  same names, installed on every compartment created after lockdown.

`TextEncoder` and `TextDecoder` are pure transformations between
`string` and `Uint8Array`.
They have no static side channels and no ambient-authority methods.
They belong on `universalPropertyNames`: one identity-equal
constructor across the start compartment and every shared
compartment.

### Permits table

| Constructor | Property | Disposition | Rationale |
|---|---|---|---|
| `TextEncoder` | `prototype` | ✓ | Required for instances. |
| `TextEncoder` | `prototype.encode`, `encodeInto` | ✓ | Pure. |
| `TextEncoder` | `prototype.encoding` | ✓ | Pure (always `'utf-8'`). |
| `TextDecoder` | `prototype` | ✓ | Required for instances. |
| `TextDecoder` | `prototype.decode` | ✓ | Pure. |
| `TextDecoder` | `prototype.encoding`, `fatal`, `ignoreBOM` | ✓ | Pure. |

These constructors return `Uint8Array` (already a permitted
intrinsic) or `string`.
`TextDecoder`'s constructor accepts a label and an options bag; both
are pure inputs.
No iterator prototypes are exposed.

### Sampling and degradation on hosts without the codecs

`packages/ses/src/intrinsics.js`'s `sampleGlobals(globalThis,
universalPropertyNames)` already tolerates missing properties: a
permit whose name is absent on the global is simply skipped.
The shim relies on this behavior.
On XS, where `TextEncoder` and `TextDecoder` are not defined,
lockdown proceeds without them and compartments observe their
absence exactly as they do today.

### Lockdown sequencing

The new permits hook into the existing `intrinsics.js` flow with no
new lockdown phase:

1. `getGlobalIntrinsics` collects `TextEncoder` and `TextDecoder`
   from the host global.
2. The whitelist pass walks the permits graph and prunes any
   non-listed properties.
3. `harden` is applied to the closure of permitted intrinsics.

No code outside `packages/ses/src/` changes.
The shim is fully internal to SES.

### Test plan

Tests live under `packages/ses/test/`.

1. **Presence on universals.**
   In a fresh compartment created post-lockdown,
   `compartment.evaluate('typeof TextEncoder')` returns `'function'`
   when the host provides it, `'undefined'` otherwise.
   Same for `TextDecoder`.

2. **Identity across compartments.**
   The `TextEncoder` from the start compartment and from any
   post-lockdown compartment are the same object
   (`startCompartment.globalThis.TextEncoder ===
   compartment.globalThis.TextEncoder`).

3. **Frozen.**
   `Object.isFrozen(TextEncoder)`,
   `Object.isFrozen(TextEncoder.prototype)`,
   `Object.isFrozen(TextDecoder)`,
   `Object.isFrozen(TextDecoder.prototype)` are all `true`.

4. **Round-trip semantics preserved.**
   `new TextDecoder().decode(new TextEncoder().encode('hello')) ===
   'hello'`.
   This guards against accidental over-pruning.

5. **Host without the codecs.**
   A test that deletes `globalThis.TextEncoder` and
   `globalThis.TextDecoder` before calling `lockdown()` exercises the
   degradation path.
   No throw, and the post-lockdown compartments lack the bindings.

6. **XS smoke test.**
   The existing XS test runner exercises (1) and (5) on a host that
   never provided the codecs.

7. **Restricted-property reproduction (endojs/endo#3369).**
   Define own `caller` and `arguments`, each
   `{ value: null, writable: false, configurable: false }`, on the
   host codec constructors before `lockdown()` — the shape V8 ships
   up to and including Chrome 137 — and assert that `lockdown()`
   completes, that the permitted codecs are the SES-owned
   replacements, and that the host constructor objects are
   unreachable from the permitted intrinsics.
   Lives in both the Node suite
   (`test/text-encoder-decoder-restricted-properties.test.js`) and
   the Playwright browser suite
   (`browser-test/tests/text-codecs.spec.js`), where a genuinely
   affected Chromium carries the properties natively.

### Compatibility considerations

- **Code that monkey-patches the codecs.**
  Any code that today does `TextEncoder.prototype.foo = ...` after
  `@endo/init` will throw, because the permitted intrinsics are
  frozen.
  Such code must perform its mutation before lockdown (the same rule
  that already applies to every other intrinsic).
  Note this in the SES changeset for the release that ships the
  shim.

## Revision: encapsulated constructors (2026-10-07)

The original design sampled the host constructors directly onto the
permitted intrinsics.
That shipped upstream in endojs/endo#3322 (ses 2.3.0) and promptly
broke `lockdown()` on a wide band of Chromium releases
(endojs/endo#3369): on V8 up to and including Chrome 137, WebIDL
constructors — including `TextEncoder` and `TextDecoder` — carry own
legacy restricted properties, `caller` and `arguments`, each
`{ value: null, writable: false, configurable: false }`.
`arguments` and `caller` are not in the `FunctionInstance` permit
set, so the permits-enforcement pass tries to delete them, cannot
(they are non-configurable), and `lockdown()` throws.

Measured boundary (Chrome for Testing headless shells, Linux x64,
2026-10-07): 120, 126, 127, 133, 136, and 137 all carry the
restricted properties on both codec constructors; 138, 139, and 140
are clean.
The affected band is therefore every Chromium before 138 (June
2025), not "before 127" as the issue first estimated.

Rejected alternatives:

- **Tolerate the descriptor in `cauterizeProperty`.**
  Withdrawn by the issue reporter: the descriptor
  `{ value: null, writable: false, configurable: false }` reads
  identically on these WebIDL constructors, where the slot stays
  inert, and on a sloppy function, where the slot is live during a
  call and leaks the caller and the arguments.
  A tolerance keyed on the descriptor shape tolerates the live case
  too.
- **Permit the properties (endojs/endo#3371).**
  Same exposure decision expressed in the permits table, with the
  added drawback that a configurable variant of the property would
  also be permitted.
  Leaving `caller` and `arguments` visible on permitted intrinsics
  is not acceptable from an ocap standpoint (mhofman, endojs/endo#3369).

Adopted remedy — **encapsulation** (mhofman: "The repair would have
to replace the class altogether"): before the intrinsics collector
samples the global object, `lockdown()` replaces each host codec
constructor, where present, with a SES-owned constructor
(`packages/ses/src/tame-text-codecs.js`) that throws without `new`,
delegates construction to the captured host original via
`Reflect.construct` (preserving `new.target` for subclassing), and
reuses the host prototype object as its own non-writable
`prototype`.
The shared prototype's `constructor` is repointed at the
replacement, so the host constructor object — restricted properties
and all — is unreachable from the permitted intrinsics graph on
every engine.
The host prototypes carry no restricted properties, and all codec
behavior (methods, option getters, brand checks) lives on them, so
instances are genuine host codec instances and `instanceof`,
`encodeInto`, streaming `decode`, labels, and the
`encoding`/`fatal`/`ignoreBOM` getters retain host behavior.
The replacement is unconditional where the codecs exist, so the
permitted intrinsics have the same shape on affected and unaffected
engines alike; hosts without the codecs (XS without a providing
shell) keep the absent-codec degradation path unchanged.
The taming is idempotent, because SES-for-XS must apply it at module
load — its shim compartment constructor samples the global
intrinsics before `lockdown()` runs — and `lockdown()` applies it
again on every platform.

The revision is possibly temporary: once every supported engine
ships clean codec constructors, the encapsulation could be retired
in favor of direct sampling, with only test plan item 7 to retire
alongside it.

## Dependencies

| Design | Relationship |
|---|---|
| [hardened-url-shim](hardened-url-shim.md) | Sibling design split from the same source issue.  Both add a vetted host-provided constructor to SES permits.  The two sets of permits are independent and may land in either order. |
| [base64-native-fallthrough](base64-native-fallthrough.md) | Same family of work: tame and dispatch to native intrinsics inside SES rather than re-implementing in JavaScript.  Independent. |

## Phases

### Phase 1: Permits and sampling (S)

- Extend `packages/ses/src/permits.js` with entries for `TextEncoder`
  and `TextDecoder` on `universalPropertyNames`.
- Update the whitelist pass if any new shape is required.

### Phase 2: Tests and changeset (S)

- Add the test cases enumerated in the Test Plan.
- Add a changeset under `.changeset/` describing the newly tamed
  intrinsics and the behavior on hosts without them.

### Phase 3: Downstream audit (S)

- Grep the monorepo for `Buffer.from(` and `.toString('utf` in code
  that runs under SES.
  These call sites become candidates for migration to
  `TextEncoder`/`TextDecoder` per the project's
  "prefer Uint8Array + TextEncoder/TextDecoder over Buffer"
  convention.

## Design Decisions

1. **Universal, not start-only.**
   `TextEncoder` and `TextDecoder` are powerless.
   They belong on `universalPropertyNames` (one identity-equal
   constructor across all compartments), unlike `URL` which needs an
   `initialGlobalPropertyNames` / `sharedGlobalPropertyNames` split
   to keep `createObjectURL` on the start compartment.

2. **Tame inside SES, not as an external shim.**
   Centralizing the permits avoids duplicating SES's whitelisting
   machinery in a per-package shim.

3. **No polyfill in this design.**
   XS users continue to lack `TextEncoder` and `TextDecoder`.
   A separate polyfill design can layer cleanly on top when there is
   demand.

4. **Encapsulate, do not tolerate.**
   The permitted codec constructors are SES-owned replacements that
   delegate to the captured host originals (§ Revision), because the
   host constructors carry undeletable legacy restricted properties
   on Chromium before 138 and the restricted-property descriptor is
   indistinguishable from a live sloppy-function slot, so no
   tolerance or permit can admit the host constructor objects
   safely.

## Prompt

```
Split out from designs/hardened-url-shim.md per PR #84 review at
designs/hardened-url-shim.md:420 ("Separating the designs would be
good.").  The TextEncoder/TextDecoder taming has no implementation
overlap with the URL/SharedURL split, so it stands alone.
```
