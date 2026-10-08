# Hardened `TextEncoder` / `TextDecoder` Vetted Shim

| | |
|---|---|
| **Created** | 2026-05-04 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Revised |

> **Revised 2026-10-07.**
> In short: sampling the host codec constructors directly made
> `lockdown()` throw on older Chromium (observed through 137),
> because those constructors carry undeletable `caller` and
> `arguments` properties.
> SES now replaces each host codec constructor with its own
> constructor that delegates to the host and shares the host
> prototype, and samples that replacement instead.
> The sections below describe the current design; the history of the
> change, the evidence, and the rejected alternatives are in the
> section Revision: encapsulated constructors.

## What is the Problem Being Solved?

Endo's hardened-JavaScript model rests on the premise that every
intrinsic shared between fearlessly coöperating compartments is either
a powerless data constructor or has been carefully tamed.
The host's `TextEncoder` and `TextDecoder` constructors are broadly
useful (UTF-8 round-tripping for byte-oriented work, the canonical
portable alternative to Node's `Buffer`) and would be welcome
additions to the permitted intrinsics.

Unlike `URL`, the text codecs have no ambient-authority static
methods and no exposed iterator prototype.
The taming is therefore small: SES replaces each host codec
constructor with an SES-owned constructor that delegates to the host
and shares the host prototype, lists the codecs on
`universalPropertyNames`, samples the replacements during the
existing intrinsics-collection pass, and hardens them.
The replacement is needed because the host constructors cannot be
sampled directly on Chromium before 138 (see the section Revision:
encapsulated constructors).

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

The new permits hook into the existing `intrinsics.js` flow:

1. The codec taming replaces each host codec constructor on the
   global with an encapsulated constructor
   (see the section Revision: encapsulated constructors).
   This step runs exactly once, inside `lockdown()`, on every engine,
   SES-for-XS included.
   That single application depends on
   endojs/endo-but-for-bots#1425 (see the section Dependencies),
   which stops SES-for-XS from sampling the global intrinsics at
   module load for the post-lockdown `Compartment`.
2. `getGlobalIntrinsics` collects `TextEncoder` and `TextDecoder`
   (now the encapsulated replacements) from the global.
3. The whitelist pass walks the permits graph and prunes any
   non-listed properties.
4. `harden` is applied to the closure of permitted intrinsics.

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

7. **Restricted-property reproduction (endojs/endo#3369, codecs
   only).**
   Define own `caller` and `arguments`, each
   `{ value: null, writable: false, configurable: false }`, on the
   host codec constructors before `lockdown()` (the shape V8 ships
   through Chrome 137).
   Assert that `lockdown()` completes and that the permitted codecs
   are the SES-owned replacements.
   Then check that the host constructor objects are unreachable from
   the permitted intrinsics with a transitive walk, not a single
   `.constructor` check:
   - Start from every permitted intrinsic and every value bound on a
     fresh compartment's global.
   - From each object, follow every own property descriptor
     (`value`, `get`, and `set`, string and symbol keys alike) and
     the `[[Prototype]]` link.
   - Assert that neither captured host constructor is ever visited.

   The walk covers the brand-checked accessors and methods on the
   shared prototypes.
   It cannot see references held inside host closures.
   The test therefore checks the walk, and it does not claim that no
   reference exists anywhere (the section Revision: encapsulated
   constructors lists the channels the walk does not cover).
   The test asserts the codec fix alone, so it does not depend on the
   `URL` and `URLSearchParams` follow-up:
   - The Node suite
     (`test/text-encoder-decoder-restricted-properties.test.js`)
     defines the properties only on the codec constructors.
   - The Playwright browser suite
     (`browser-test/tests/text-codecs.spec.js`) runs on Chrome for
     Testing 137, a measured affected version, where the properties
     are native.
     It deletes `globalThis.URL` and `globalThis.URLSearchParams`
     before `lockdown()`, so the absent-intrinsic path keeps them
     out of the way.
     It also pins 138 as a measured clean version, where the same
     assertions hold without the deletions.
   `lockdown()` succeeding on an affected Chromium with `URL` and
   `URLSearchParams` present is the follow-up's test, not this one's.

8. **Unrepointable host prototype.**
   Before `lockdown()`, while the global binding is still the host
   constructor, put a host codec prototype into each state that
   prevents repointing its `constructor`: frozen; non-extensible
   with `constructor` made non-writable; and extensible with
   `constructor` made non-writable and non-configurable.
   In each state, assert that `lockdown()` throws a `TypeError`
   naming the constructor, rather than leaving the host constructor
   in place or failing with an untyped error from deep inside
   `lockdown()`.
   Runs in the Node suite and in the XS runner with a shell that
   provides the codecs.

9. **Subclassing and pre-lockdown captures.**
   After `lockdown()`, with `Host` a host constructor captured before
   `lockdown()` (`const { TextDecoder: Host } = globalThis`):
   - `class X extends TextDecoder {}` yields instances that are
     `instanceof X` and `instanceof TextDecoder` and decode correctly.
   - `new TextDecoder() instanceof Host` is `true`.
   - `new Host() instanceof TextDecoder` is `true`.
   - `Host !== TextDecoder`.
   - An instance constructed before `lockdown()` reports the
     replacement as its `constructor`.
   - `Reflect.construct(TextDecoder, [], F)` with an arbitrary
     function `F` yields an instance whose prototype is
     `F.prototype`, and neither the instance, `F`, nor anything the
     walk of item 7 reaches from them is the host constructor.
   - The same holds when `F` is a Proxy, or when `F.prototype` is an
     accessor: `Reflect.construct` reads `F.prototype` through an
     ordinary `[[Get]]` on `F`, so a guest trap or getter observes
     only `F` and the property key, never `Host`.
   - The replacements' `name` and `length` equal the host's
     (`'TextEncoder'`/`'TextDecoder'`, `0`).
   - The replacements' own keys are exactly `length`, `name`, and
     `prototype`.
   - Calling a replacement without `new` throws a `TypeError` whose
     message names the constructor.
   - `new TextDecoder('bogus')` throws the same error class as the
     host (`RangeError`), because arguments are forwarded unchanged.

### Compatibility considerations

- **Code that monkey-patches the codecs.**
  Any code that today does `TextEncoder.prototype.foo = ...` after
  `@endo/init` will throw, because the permitted intrinsics are
  frozen.
  Such code must perform its mutation before lockdown (the same rule
  that already applies to every other intrinsic).
  Note this in the SES changeset for the release that ships the
  shim.
- **Constructor identity changes after lockdown.**
  The permitted `TextEncoder` and `TextDecoder` are SES-owned
  replacements (see the section Revision: encapsulated
  constructors), so a host constructor captured before `lockdown()`
  is no longer identical to the global binding:
  `Host === TextDecoder` is `false`.
  `instanceof` still holds in both directions, because the
  replacement reuses the host prototype object; that preservation is
  the reason the prototype is shared rather than copied.
- **The shared prototype's `constructor` is repointed.**
  Instances that a program constructed before `lockdown()` share the
  host prototype, so their `constructor` now reports the
  replacement.
  This is a visible mutation of host-shared state, made once, inside
  `lockdown()`, before the prototype is hardened.
  Importing SES without calling `lockdown()` leaves the host
  constructors and their prototypes untouched, on every engine.
- **The replacement is a different function object.**
  On every engine, including those whose host constructors are
  clean, the permitted constructors are SES-owned functions.
  Their `name` and `length` match the host constructors, but code
  that compares function identity, feature-detects by looking for
  `[native code]` in `Function.prototype.toString` output, or
  inspects other own properties of the host constructor, can observe
  the difference.
  The user-facing explanation lives in two places, so a user who
  meets `Host !== TextDecoder` can find the reason without reading
  this design:
  - the `.changeset/` entry for the SES release that ships the
    revision, which states the identity change, the repointed
    `constructor`, and the retirement trigger
    (see the section Revision: encapsulated constructors);
  - a short note in `packages/ses/docs/guide.md`, beside its
    existing `TextEncoder`/`TextDecoder` entries, saying that the
    permitted codecs are SES-owned stand-ins for the host
    constructors and linking to this design.
- **More than one copy of SES in a realm.**
  The taming runs only inside `lockdown()`, so importing a second
  copy of SES changes nothing.
  A second copy whose `lockdown()` runs after the first finds the
  codec prototype already frozen, cannot repoint its `constructor`,
  and throws the diagnostic described in the install paragraph of
  the section Revision: encapsulated constructors.
- **Other names for the same host constructors.**
  Host modules such as Node's `util` may expose the codec
  constructors under a second name.
  Those references are outside the permitted intrinsics graph and
  keep the host object; they are not reachable from a compartment
  unless an endowment passes them in.

## Revision: encapsulated constructors (2026-10-07)

Summary of the remedy:
Before the intrinsics collector samples the global object, SES
replaces each host `TextEncoder` and `TextDecoder` with an SES-owned
constructor that delegates construction to the host through
`Reflect.construct` and reuses the host prototype object, so
instances and `instanceof` keep host behavior.
The permitted intrinsics are those replacements, never the host
constructor objects, so the host's undeletable `caller` and
`arguments` properties never reach the permits pass.
The rest of this section gives the failure that motivates the
change, the measured evidence, the rejected alternatives, and then
the adopted remedy in detail.

Background: `lockdown()` collects the intrinsics (the built-in
objects every compartment shares), then walks them against an
allowlist called the permits.
The permits-enforcement pass deletes every property the permits do
not name, and `lockdown()` throws if a deletion fails.

The original design sampled the host constructors directly onto the
permitted intrinsics.
That shipped upstream in endojs/endo#3322 (ses 2.3.0) and broke
`lockdown()` on a wide band of Chromium releases (endojs/endo#3369).
The failure runs as follows:

1. On V8 through Chrome 137, WebIDL constructors (constructors that
   browsers define from Web IDL interface specifications) carry
   own legacy restricted properties, `caller` and `arguments`, each
   `{ value: null, writable: false, configurable: false }`.
   `TextEncoder` and `TextDecoder` are WebIDL constructors.
2. `caller` and `arguments` are not in the `FunctionInstance` permit
   set.
3. The permits-enforcement pass therefore tries to delete them but
   cannot (they are non-configurable), and `lockdown()` throws.

Measured boundary (Chrome for Testing headless shells, Linux x64,
2026-10-07):
- 120, 126, 127, 133, 136, and 137 carry the restricted properties
  on both codec constructors.
- 138, 139, and 140 are clean.

Inference, not measurement:
- The intermediate versions (121 to 125, 128 to 132, 134, and 135)
  were not measured.
- Treating the affected band as every Chromium before 138 (June
  2025) extrapolates from the measured points.
  The issue first estimated "before 127", which the measurements
  disprove.
- The cause of the change in 138 has not been traced to a V8 commit.

The test plan pins the measured versions (137 affected, 138 clean),
not the inferred band.
The design does not depend on the extrapolation: the replacement is
unconditional, so an unmeasured version on either side of 138 gets
the same treatment.

The same restricted-property shape is a property of WebIDL
constructors in general, not of the codecs.
Two other permitted intrinsics are host WebIDL constructors on the
same engines: `URLSearchParams` (universal) and, in the default
`urlBlobTaming: 'retain'` mode, the host `URL` bound as
`%InitialURL%`.
This revision fixes only the codecs, so it narrows endojs/endo#3369
and does not close it.
After it lands, `lockdown()` still throws on Chromium before 138 in
the default mode, now on `URLSearchParams` or `%InitialURL%` instead
of the codecs.
The follow-up applies the same rule (a permitted host WebIDL
constructor is never the host object) to those two, using the shared
maker below; it is tracked as its own design revision of
[hardened-url-shim](hardened-url-shim.md), and endojs/endo#3369
closes only when it lands.
Test plan item 7 asserts the codec fix alone and does not wait for
the follow-up.
Order: the codecs land first because their replacement is new code
with no existing users of a tamed constructor; `URLSearchParams`
follows, then `%InitialURL%`, whose `SharedURL` sibling already
uses the same delegation shape.

Rejected alternatives:

- **Tolerate the descriptor in `cauterizeProperty`.**
  Withdrawn by the issue reporter.
  On a sloppy function, `caller` and `arguments` are live during a
  call: they return the calling function and the call's arguments.
  The descriptor `{ value: null, writable: false, configurable: false }`
  reads identically on these WebIDL constructors, where the slot
  stays inert, and on a sloppy function, where it is live.
  A tolerance keyed on the descriptor shape tolerates the live case
  too.
  A narrower variant would tolerate the descriptor only on native
  functions named `TextEncoder` or `TextDecoder`.
  That is an allowlist of host-specific exceptions rather than a
  shape check, and it is still worse than encapsulation, because it
  admits the host objects and grows the permits machinery with
  per-host special cases.
- **Give the replacement a fresh prototype.**
  The replacement could own a new prototype object whose methods
  forward to the host prototype, leaving host state untouched.
  Rejected because instances constructed before `lockdown()` (and
  instances that host APIs create internally) have the host
  prototype, so `instanceof` against the permitted constructor would
  fail for them, and every method and accessor would need a
  forwarding wrapper that repeats the host brand check.
  Reusing the host prototype keeps `instanceof` and all behavior, at
  the cost of mutating host-shared state: `Host.prototype.constructor`
  is repointed and the prototype is hardened.
  Any non-SES code in the same realm, including code that holds the
  host constructor from before `lockdown()`, sees the repointed
  `constructor` and the frozen prototype.
  Other realms (iframes, workers) have their own prototypes and are
  not affected.
- **Replace only where the host constructor is affected.**
  A feature test could gate the replacement: encapsulate only when
  the host constructor has an undeletable own `caller` or
  `arguments`, and sample the host constructor directly otherwise.
  Unlike the tolerance above, this never admits an affected host
  object.
  It would spare users on Chromium 138 and later, Node, Deno, and
  XS the identity break and the repointed `constructor`.
  Rejected because the cost moves rather than shrinks:
  - The permitted intrinsics would differ by engine, so
    `Host === TextDecoder` would be `true` on some engines and
    `false` on others, and code that passes tests on Node could
    fail on an older Chromium.
    An unconditional break is visible everywhere and is caught by
    every test run.
  - Both paths must be tested on every engine family, while the
    unconditional path is one code path with one set of assertions.
  - The `URL` and `URLSearchParams` follow-up already replaces its
    constructors unconditionally (`SharedURL`), so a conditional
    codec rule would make the shared maker carry two policies.
  The retirement trigger below removes the cost for everyone at
  once, when the affected engines leave the support floor.
- **Permit the properties (endojs/endo#3371).**
  This makes the same exposure decision as the tolerance, through
  the permits table instead.
  It also loses the ability to remove `caller` or `arguments` where
  they are configurable: a permitted property is kept, so a host or
  sloppy function whose slot is deletable and live would keep it.
  Leaving `caller` and `arguments` visible on permitted intrinsics
  is not acceptable from an ocap standpoint (@mhofman,
  endojs/endo#3369).

Adopted remedy: **encapsulation**.
As @mhofman put it, "The repair would have to replace the class
altogether."
Before the intrinsics collector samples the global object,
`lockdown()` replaces each host codec constructor, where present,
with an encapsulated constructor
(`packages/ses/src/tame-text-codecs.js`).
The replacement reuses the host's prototype object, so instances
keep host behavior; the sketch below shows the shape, and the
paragraph after it explains why the shared prototype works.

The codec module does not define its own delegator.
It uses one shared maker, `encapsulateHostConstructor(Host, name)`
in `packages/ses/src/encapsulate-host-constructor.js`, which states
the rule once.
The maker is pure with respect to the global object: it builds the
delegator, sets its `length`, `name`, and `prototype`, repoints the
shared prototype's `constructor`, and returns the delegator.
It never reads or writes `globalThis` and keeps no install record,
because `SharedURL`, its intended second consumer, is returned as an
intrinsic through `addIntrinsics` and never written to the global.
Replacing the global binding belongs to the codec taming in
`tame-text-codecs.js`, the only caller that writes the global (see
the install paragraph below).
`SharedURL` in `tame-url-constructor.js` already has this shape; the
`URL` and `URLSearchParams` follow-up moves it onto the maker rather
than adding further copies.
That move is not yet checked: `SharedURL` throws
"secure mode Calling %SharedURL% constructor as a function throws",
and it also copies the host's pure static helpers (`parse` and,
where present, its siblings) onto the replacement, which the codecs
do not need.
The maker therefore takes the error-message name as a parameter, so
`SharedURL` can keep its existing message, and leaves static
members to the caller; the follow-up
confirms the adoption against `tame-url-constructor.js` before it
claims the shape is shared.
The encapsulated constructor:

- It throws a `TypeError` when called without `new`, with a message
  that names the constructor (for example, "Calling TextDecoder
  constructor as a function throws").
  The wording deliberately matches `%SharedURL%`'s existing error,
  so all encapsulated constructors from the shared maker, including
  the `URL` and `URLSearchParams` follow-up, report the same message
  shape.
- It delegates construction to the captured host original through
  `Reflect.construct`, preserving `new.target` so subclassing works.
- It reuses the host prototype object as its own non-writable
  `prototype`.
- It repoints the shared prototype's `constructor` at the
  encapsulated constructor.

```js
const Host = globalThis.TextDecoder;
const TextDecoder = function TextDecoder(...args) {
  if (new.target === undefined) {
    throw TypeError('Calling TextDecoder constructor as a function throws');
  }
  return Reflect.construct(Host, args, new.target);
};
// TextDecoder.prototype === Host.prototype (non-writable)
// Host.prototype.constructor === TextDecoder
```

The key mental model is the shared prototype.
`new TextDecoder()` returns an object built by the host constructor,
so it has the host's internal slots, and its `[[Prototype]]` is the
host prototype, which is also the encapsulated constructor's
`prototype`.
All codec behavior (methods, option getters, brand checks) lives on
that prototype, so the following retain host behavior: the
`instanceof` operator, the `encode`, `encodeInto`, and `decode`
methods (including streaming `decode`), encoding-label handling, and
the `encoding`, `fatal`, and `ignoreBOM` getters.

A worked trace of `new TextDecoder()` after `lockdown()`:
- The constructor is the encapsulated `TextDecoder`, an SES-owned
  function.
- It calls `Reflect.construct(Host, [], TextDecoder)`; the host
  constructor builds the instance and gives it the host's internal
  slots.
- The instance's `[[Prototype]]` is `TextDecoder.prototype`, which is
  the same object as `Host.prototype`.
- That prototype's `constructor` is the encapsulated `TextDecoder`,
  so nothing on the instance's path leads back to `Host`.
The host prototypes carry no restricted properties.
The host constructor still holds its own `prototype` link to the
shared prototype, but that link runs one way: nothing reachable from
the permitted intrinsics points back at the host constructor once
`constructor` is repointed, and test plan item 7 checks that claim
by a transitive walk of the permitted graph.
The only remaining reference is the one captured inside the
encapsulated constructor's closure, which no compartment can read.

Why the host constructor stays unreachable, as an argument rather
than only a test:
- The prototype's methods and accessors are WebIDL operations and
  attributes. They return strings, numbers, booleans, and
  `Uint8Array` results or objects of the form
  `{ read, written }`, never a function and never their constructor.
- `new.target` flows only one way. `Reflect.construct(Host, args,
  F)` reads `F.prototype` to choose the new instance's prototype; it
  does not hand `Host` to `F` or store it on the instance. A caller
  who supplies an arbitrary `F`, through a subclass or a direct
  `Reflect.construct`, gets a host-slotted instance with `F`'s
  prototype and nothing more. Test plan item 9 asserts this.
- The replacement's own properties are `name`, `length`, and
  `prototype`, set by SES. It has none of the host's own
  properties.

This guarantee is empirical: it rests on the current WebIDL
definitions of `TextEncoder` and `TextDecoder`, a host surface SES
does not control.
It would break if a host added a codec method or accessor that
returns a constructor or class, or a `Symbol.species`-style hook
that hands out the constructor.
The permits table limits the exposure to the members it names, so
a new member is pruned before it is reachable, but a changed
existing member would not be; the test plan's walk is the guard
against that.

Escape channels this argument and the walk do not cover:
- References held inside host closures or internal slots.
- Other names for the same host constructors that a host module
  exposes (see the section Compatibility considerations), and
  endowments that pass them in.
- Host constructors from other realms, which are other objects.

The replacement is unconditional where the codecs exist, so the
permitted intrinsics have the same shape on affected and unaffected
engines alike, at the cost of constructor identity with pre-lockdown
captures (see the section Compatibility considerations).
Hosts without the codecs (XS without a providing shell) keep the
absent-codec degradation path unchanged.

Install rule: inside `lockdown()`, the taming writes each
replacement to the global binding exactly once, just before the
intrinsics collector samples the universal names.
`TextEncoder` and `TextDecoder` are universal names, which the
collector reads from the global object rather than receiving through
`addIntrinsics` (the `lockdown()` call that registers a tamed
intrinsic under a permit name, as `tameUrlConstructor` and
`tameDateConstructor` do).
This one write is the install rule for universal host WebIDL
constructors; the `URLSearchParams` follow-up, also universal, uses
the same rule rather than adding its own install logic.

The single application depends on endojs/endo-but-for-bots#1425.
Without that change, SES-for-XS, the SES build that runs on
Moddable's XS engine, builds the shim compartment constructor for
the post-lockdown `Compartment` at module load, with
`getGlobalIntrinsics` sampling the universal names from the global
object outside `lockdown()`; a taming that runs only inside
`lockdown()` would be invisible to that earlier sample.
With it, `lockdown()` on SES-for-XS builds the post-lockdown
`Compartment` from a fresh `makeShimStartCompartment()` after
`hardenIntrinsics()`, as Node already does through
`setGlobalObjectMutableProperties` in `packages/ses/src/lockdown.js`,
so every post-lockdown sample sees the hardened replacement.
The import-time shim constructor that remains serves only the
pre-lockdown adapter, which never sees permitted intrinsics.
The taming therefore runs once on every engine, keeps no record of
past passes, and needs no idempotence check.

When the taming finds a host codec prototype whose `constructor` it
cannot repoint (the prototype is frozen, or the property is
non-writable and either non-configurable or on a non-extensible
prototype), it throws a `TypeError` naming the constructor (for
example, "Cannot tame TextDecoder: its prototype's constructor
cannot be repointed; the prototype was frozen or locked before
lockdown(), possibly by a second copy of SES") rather than leaving a
possibly-host constructor on the permitted path, where it would
either fail the permits pass again on affected Chromium or break the
rule that a permitted host WebIDL constructor is never the host
object.
Test plan item 8 covers each of those prototype states.

The revision is possibly temporary.
Retirement trigger: when the oldest Chromium that SES supports is
138 or later, the encapsulation can be retired in favor of direct
sampling, with test plan items 7 and 8 retired alongside it.
SES does not yet document a supported-browser floor; the retirement
decision therefore needs one stated first, and the changeset that
retires the encapsulation names it.
Only Chromium has been measured.
The design does not claim that Firefox or WebKit codec constructors
are clean or affected; the unconditional replacement covers them
either way, and the changeset text says "observed on Chromium 137
and earlier" rather than "Chromium only".

Shipping: the codec revision can ship on its own.
It removes the codec constructors from the endojs/endo#3369 failure, and it
gives users relief on affected Chromium only once the `URL` and
`URLSearchParams` follow-up also lands; until then `lockdown()`
still throws there on those two in the default mode.
The changeset says so, so a user does not take the codec release
as the fix for endojs/endo#3369.

## Dependencies

| Design | Relationship |
|---|---|
| [hardened-url-shim](hardened-url-shim.md) | Sibling design split from the same source issue.  Both add a vetted host-provided constructor to SES permits.  The two sets of permits are independent and may land in either order. |
| endojs/endo-but-for-bots#1425 (sample XS compartment intrinsics at lockdown) | Prerequisite.  The codec taming runs once, inside `lockdown()` (see the section Lockdown sequencing); without endojs/endo-but-for-bots#1425, SES-for-XS samples the universal names at module load and would miss the replacement, so the codec revision lands after it. |
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
   delegate to the captured host originals
   (see the section Revision: encapsulated constructors).
   The host constructors carry undeletable legacy restricted
   properties on Chromium before 138.
   The restricted-property descriptor is indistinguishable from a
   live sloppy-function slot, so no tolerance or permit can admit the
   host constructor objects safely.

## Prompt

```
Split out from designs/hardened-url-shim.md per PR #84 review at
designs/hardened-url-shim.md:420 ("Separating the designs would be
good.").  The TextEncoder/TextDecoder taming has no implementation
overlap with the URL/SharedURL split, so it stands alone.
```
