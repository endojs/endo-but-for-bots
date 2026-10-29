# Hardened `TextEncoder` / `TextDecoder` Vetted Shim

| | |
|---|---|
| **Created** | 2026-05-04 |
| **Updated** | 2026-10-29 |
| **Author** | Kris Kowal (prompted) |
| **Status** | **Implemented** (Phases 1-2) |

## Status

**Implemented (Phases 1-2).** The permits, the global sampling, the
tests, and the changeset merged upstream in
[endojs/endo#3322](https://github.com/endojs/endo/pull/3322) on 2026-07-22
(merge commit `8021d268e7`). They reached `llm`, this repository's
integration branch that carries upstream `endojs/endo` plus fork-only work,
through the regular upstream merges. § Sampling and degradation on hosts
without the codecs describes the sampling.

The change put `TextEncoder` and `TextDecoder` on `universalPropertyNames`
in `packages/ses/src/permits.js` with the prototype permits in the table
below. It added 18 focused tests covering items 1-5 of the § Test plan
below, and a changeset (`.changeset/hardened-text-codecs.md`, released by
[endojs/endo#3302](https://github.com/endojs/endo/pull/3302)).

A follow-up PR, [endojs/endo#3340](https://github.com/endojs/endo/pull/3340)
(merged 2026-08-11 as `dc504ca993`, also on `llm`), explicitly denies
Node's non-standard `Symbol(nodejs.util.inspect.custom)` method on both
prototypes.

A regression on older Chromium followed: `lockdown()` threw because the
host codec constructors carry undeletable `caller` and `arguments`
properties
([endojs/endo#3369](https://github.com/endojs/endo/issues/3369)).
The remedy merged upstream in
[endojs/endo#3376](https://github.com/endojs/endo/pull/3376) on
2026-10-29 (merge commit `679d9afaa4`) and reaches `llm` with the next
upstream merge.
§ Revision: restricted `caller` and `arguments` on older Chromium
records the failure and the remedy.

Remaining items:

- **§ Test plan item 6 (XS smoke test):** open as draft
  [endojs/endo-but-for-bots#1349](https://github.com/endojs/endo-but-for-bots/pull/1349).
  It extends `packages/ses/test/_xs.js`. It also found that the current
  Moddable `xst` *does* define both codecs, so on today's toolchain the XS
  path exercises pass-through-and-harden rather than the missing-codecs
  case this design assumed. § Sampling and degradation and Design
  Decision 3 below note this.
- **Phase 3 (downstream audit, optional):** not performed on `llm`. As of
  `llm` commit `7ff30afbce`, `packages/*/src` has 16 `Buffer.from(` / `.toString('utf...')` call sites
  in 10 files. All are Node-host powers, drivers, and backends
  (`9p-server`, `cli`, `daemon`, `git`, `platform`, `sandbox`, and the
  `*-sandbox` packages), not
  code that runs inside a compartment. An audit, if wanted, is a separate
  cleanup job.
- **Node `TextDecoder` fast-path flags:** hardening a `TextDecoder`
  *instance* on recent Node releases makes the next `decode()` throw.
  Tracked upstream as
  [endojs/endo#2813](https://github.com/endojs/endo/issues/2813), with the
  open fix [endojs/endo#3245](https://github.com/endojs/endo/pull/3245)
  (`@endo/lockdown` accessor patch). This concerns hardened instances, not
  the permitted constructor and prototype this design covers.

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
| `TextEncoder` | `prototype` | yes | Required for instances. |
| `TextEncoder` | `prototype.encode`, `encodeInto` | yes | Pure. |
| `TextEncoder` | `prototype.encoding` | yes | Pure (always `'utf-8'`). |
| `TextEncoder` | `prototype[@@toStringTag]` | yes | String data. |
| `TextEncoder` | `prototype[Symbol(nodejs.util.inspect.custom)]` | no | Node-only, non-standard; denied by [endojs/endo#3340](https://github.com/endojs/endo/pull/3340). |
| `TextDecoder` | `prototype` | yes | Required for instances. |
| `TextDecoder` | `prototype.decode` | yes | Pure. |
| `TextDecoder` | `prototype.encoding`, `fatal`, `ignoreBOM` | yes | Pure. |
| `TextDecoder` | `prototype[@@toStringTag]` | yes | String data. |
| `TextDecoder` | `prototype[Symbol(nodejs.util.inspect.custom)]` | no | Node-only, non-standard; denied by [endojs/endo#3340](https://github.com/endojs/endo/pull/3340). |

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
On a host where `TextEncoder` and `TextDecoder` are not defined
(older XS builds, when this design was written), lockdown proceeds
without them and compartments observe their absence exactly as they
do today.
Current Moddable `xst` defines both codecs, so on today's XS the
permits pass them through and harden them (see § Status).

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
   The existing XS test runner exercises (1) on XS.
   This design assumed XS never provides the codecs, so the XS run
   would also cover (5).
   Current Moddable `xst` defines both codecs (found by
   [endojs/endo-but-for-bots#1349](https://github.com/endojs/endo-but-for-bots/pull/1349),
   closed unmerged on 2026-10-29, so no XS run of (1) has landed),
   so on today's toolchain the XS run exercises pass-through-and-harden,
   and (5) is covered only by the deletion test on Node.

### Compatibility considerations

- **Code that monkey-patches the codecs.**
  Any code that today does `TextEncoder.prototype.foo = ...` after
  `@endo/init` will throw, because the permitted intrinsics are
  frozen.
  Such code must perform its mutation before lockdown (the same rule
  that already applies to every other intrinsic).
  Note this in the SES changeset for the release that ships the
  shim.

## Revision: restricted `caller` and `arguments` on older Chromium (2026-10-29)

### The failure

`lockdown()` collects the intrinsics, then deletes every property
the permits do not name, and throws if a deletion fails.
On older V8, every Web IDL function, including the `TextEncoder` and
`TextDecoder` constructors, carries own `caller` and `arguments`
properties, each `{ value: null, writable: false, enumerable: false,
configurable: false }`.
The `FunctionInstance` permits do not name them, they cannot be
deleted, and so `lockdown()` threw as soon as
[endojs/endo#3322](https://github.com/endojs/endo/pull/3322) made the
codecs permitted intrinsics (ses 2.3.0;
[endojs/endo#3369](https://github.com/endojs/endo/issues/3369)).

Measured on Chrome for Testing headless shells (Linux x64,
2026-10-07): 120, 126, 127, 133, 136 and 137 carry the properties on
both codec constructors; 138, 139 and 140 do not.
The versions in between were not measured.
endojs/endo#3376 also reports the shape on the Android System WebView
through at least 133.
The shape belongs to Web IDL functions in general, so `URLSearchParams`
and the host `URL` (`%InitialURL%`) carry it too.

### The remedy: tolerate a frozen `null`

`cauterizeProperty` in `packages/ses/src/cauterize-property.js` now
tolerates exactly one undeletable shape on a function's `arguments` or
`caller`: an own data property whose value is `null`, non-writable
and non-configurable.
It reports `Tolerating undeletable <path> === null` through the
reporter's `warn` and leaves the property in place.
Any other value, or a writable or configurable property, still fails
`lockdown()`.
This parallels the existing tolerance of an undeletable `prototype`
that can be set to `undefined`.

Consequences for this design:

- The host codec constructors stay the permitted intrinsics.
  § Design above is unchanged: sampling, the permits table, identity
  across compartments (test plan item 2) and hardening all hold on
  every engine.
- The tolerance is not specific to the codecs.
  It also lets `URLSearchParams` and `%InitialURL%` through on the
  same engines, so [hardened-url-shim](hardened-url-shim.md) needs no
  revision for this failure.
- Each affected function adds one warning per property to the
  `lockdown()` report on affected engines.

### Security considerations

The upstream argument is that a frozen `null` is inert: it cannot
change and it leaks nothing.
That holds for Web IDL functions.
The descriptor alone does not distinguish them from a V8 sloppy-mode
`function`, whose own `arguments` reads as the same frozen `null`
outside a call and as the live arguments object during one (checked
on Node 22.23).
The tolerance is therefore safe as long as the permitted intrinsics
contain no sloppy-mode functions, which holds for engine built-ins
and for SES's own strict-mode code.
The open question below asks whether to pin that assumption in a
test.

### Test plan additions

7. **Frozen `null` tolerated, other shapes refused.**
   Landed with endojs/endo#3376 under `packages/ses/test/error/`:
   it plants pills on a replacement `Array.isArray` and checks that a
   frozen `null` pill passes `lockdown()` with a warning, while a
   frozen non-`null` pill and a writable `null` pill fail.

8. **Browser smoke (manual).**
   `lockdown()` completes on Chrome for Testing 137 with the codecs
   permitted, and `new TextDecoder().decode(new TextEncoder().encode('ok'))`
   round-trips in a post-lockdown compartment.
   No CI job covers this: Browser Tests do not run on frozen-base PRs
   (endojs/endo-but-for-bots#1582 tracks the workflow change).

### Considered and rejected

- **Encapsulate affected host constructors.**
  Replace each codec constructor that has an own `arguments` property
  with an SES-owned constructor that delegates to the host and shares
  its prototype
  ([endojs/endo-but-for-bots#1349](https://github.com/endojs/endo-but-for-bots/pull/1349),
  mirrored as [endojs/endo#3377](https://github.com/endojs/endo/pull/3377)).
  Reason: closed as superseded by endojs/endo#3376, which fixes every
  Web IDL function at once, keeps constructor identity on every
  engine, and adds no new code path.
- **Permit `caller` and `arguments` on the codecs**
  ([endojs/endo#3371](https://github.com/endojs/endo/pull/3371)).
  Reason: closed; a per-constructor permit would have to be repeated
  for every Web IDL intrinsic.

### Open questions

1. Should the SES test suite assert that no permitted intrinsic is a
   sloppy-mode function, so the frozen-`null` tolerance can never
   cover a live `arguments` or `caller` slot?

## Dependencies

| Design | Relationship |
|---|---|
| [hardened-url-shim](hardened-url-shim.md) | Sibling design split from the same source issue.  Both add a vetted host-provided constructor to SES permits.  The two sets of permits are independent and may land in either order. |
| [endojs/endo#3376](https://github.com/endojs/endo/pull/3376) | Upstream fix for the older-Chromium `lockdown()` failure; merged 2026-10-29, not yet on `llm`.  See § Revision. |
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

Optional cleanup; it does not gate the **Implemented** status.

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
   Hosts that lack `TextEncoder` and `TextDecoder` continue to lack
   them (current Moddable `xst` defines both; see § Status).
   A separate polyfill design can layer cleanly on top when there is
   demand.

## Prompt

```
Split out from designs/hardened-url-shim.md per PR #84 review at
designs/hardened-url-shim.md:420 ("Separating the designs would be
good.").  The TextEncoder/TextDecoder taming has no implementation
overlap with the URL/SharedURL split, so it stands alone.
```
