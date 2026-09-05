# Reified Passable Symbols behind a Node Condition (`pass-style-symbol`)

| | |
|---|---|
| **Created** | 2026-09-04 |
| **Updated** | 2026-09-05 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |

This is a design document only; it lands no implementation. The maintainer
brief that prompted it is reproduced verbatim under [Prompt](#prompt).

## Background

This design lives inside `@endo/pass-style` and its consumers, and uses that
subsystem's vocabulary throughout. The load-bearing terms:

- **Passable**: a value `@endo/pass-style` admits into a pass-by-copy or
  pass-by-reference message. `passStyleOf(value)` classifies a passable into
  one of a fixed set of *pass styles* (`copyRecord`, `copyArray`, `tagged`,
  `remotable`, `symbol`, ...); a non-passable value throws.
- **Pass-by-copy / reify**: pass-by-copy passables are serialized by value and
  reconstructed (*reified*) on the receiving side into a fresh local value.
  Reifying a symbol means turning its wire name back into a local JavaScript
  value that stands for that symbol.
- **Marshal**: `@endo/marshal`, the layer that encodes a passable to a wire
  form (smallcaps, capdata, or `encodePassable` ordered keys) and decodes it
  back, calling into `@endo/pass-style` at the leaves.
- **Remotable**: a pass-by-reference passable (a `Far` object); mentioned only
  as one of the pass styles, not otherwise central here.
- **Compartment / vat**: isolation units. A *compartment* is an SES evaluation
  scope with its own globals; a *vat* is an Agoric unit of isolated, resumable
  computation, typically hosting many compartments. Several vats can share one
  OS process. The threat model below turns on the fact that the global symbol
  registry is shared across all compartments and vats in a process, defeating
  that isolation.
- **`PASS_STYLE`**: the well-known key `Symbol.for('passStyle')`, exported from
  `packages/pass-style/src/passStyle-helpers.js`. Every pass-by-copy container
  carries it as a property whose string value names the container's pass style;
  this is the existing tagging convention the tagged-object representation
  reuses (see [The existing dispatch mechanism this rides
  on](#the-existing-dispatch-mechanism-this-rides-on)).

## Summary

Today a passable symbol *is* a primitive JavaScript `symbol`: a well-known
symbol (`Symbol.iterator` and friends, reified on the wire as `"@@" + name`)
or a `Symbol.for(name)` registered symbol. This design introduces an
**alternate reified representation** for passable symbols: a plain hardened
object

```js
{ [Symbol.for('passStyle')]: 'symbol', [Symbol.toStringTag]: symbolName }
```

Distinguish two roles the primitive symbols play here, because the design turns
on the distinction. The object is *keyed* by two primitive symbols,
`Symbol.for('passStyle')` and `Symbol.toStringTag`, which are the existing
pass-by-copy tagging convention every container already uses (see [The existing
dispatch
mechanism this rides on](#the-existing-dispatch-mechanism-this-rides-on)). The
passable *value* this object stands in for contains no primitive symbol at all.
"Carries no primitive symbol" is a claim about the represented value, not about
the tag keys.

Relative to today's primitive representation, the design's changes are: the
reified value carries no primitive `symbol`; the variant module eliminates
well-known symbols as a passable category; and its decode leaf never calls
`Symbol.for` on incoming names. The name is carried in `Symbol.toStringTag`
because that follows the standing tag-record convention (`[PASS_STYLE]` plus
`[Symbol.toStringTag]`, as in `remotable.js` and `byteArray.js`) and keeps the
name out of the string-key namespace; a useful consequence is that AVA's
`t.deepEqual` treats two reifications of the same name as structurally equal
(see [The AVA/`t.deepEqual`
advantage](#the-avatdeepequal-advantage-with-a-worked-example)).

This representation is **not** the default. It is selected per process by a
custom Node resolution condition, `pass-style-symbol`, activated with
`node -C pass-style-symbol` (equivalently `--conditions=pass-style-symbol`).
Absent that flag, resolution falls through to `"default"` and today's *runtime
behavior on today's values is unchanged*: no default process ever produces the
tagged shape, so the primitive-symbol path handles every value exactly as
today. The one deliberate, dormant default-world change this design makes is
that `HelperTable` gains a `'symbol'` entry unconditionally, so a hand-built
`[PASS_STYLE]: 'symbol'` object is *routed to* `SymbolHelper` by the existing
`[PASS_STYLE]`-keyed object dispatch (see [The existing dispatch mechanism this
rides on](#the-existing-dispatch-mechanism-this-rides-on)) rather than hitting
`Unrecognized PassStyle` for an unknown tag. Under `default` that helper still
**rejects** the object: its validator probes the active world's
`nameForPassableSymbol`, which under `default` yields no name for it (see [The
`HelperTable['symbol']`
decision](#the-helpertablesymbol-decision-register-unconditionally)), so
`passStyleOf` still throws; only the *shape of the error* changes, and only for
a value default code never constructs. This is called out at first statement
because a naive "default is untouched, byte for byte" reading is contradicted by
that routing change; the precise claim is "default *production and encoding* of
real values is unchanged," not "`passStyleOf` accepts the tagged shape under
default."

The swap is deliberately narrow: a single package-private `imports` alias
inside `@endo/pass-style`, `#pass-style-symbol-impl` (resolved per-process by
Node's `imports` map at load time, detailed in [The condition
wiring](#the-condition-wiring-packagejson-imports)), resolves either to
today's `src/symbol.js` (`default`) or to a new sibling
`src/symbol-tagged.js` (`pass-style-symbol`). The two modules present the
*same* function surface (`isPassableSymbol` / `assertPassableSymbol` /
`nameForPassableSymbol` / `passableSymbolForName` / `unpassableSymbolForName`),
plus a shared world-identity export (see [A named world query, not a
shape-sniff](#a-named-world-query-not-a-shape-sniff)), so any downstream code
that reaches passable symbols *through that surface* (`passStyleOf`, and all
three marshal encoders) swaps transitively with no line of its own changing.

The transitivity has a limit *wider than `typeof` guards*, and the design must
not undersell it: three kinds of breakage exist. A guard recoverable by a
predicate swap; a structural use no predicate swap can rescue; and a *silent*
identity loss that raises no error at all.

- **Recoverable by predicate swap.** Code that inspects a passable symbol with a
  bare `typeof === 'symbol'` guard can be made world-agnostic by validating
  through `isPassableSymbol` / `nameForPassableSymbol` instead. `@endo/ocapn`'s
  `selector.js` is such a site.
- **Not recoverable by any predicate swap.** Code that uses the *symbol-ness
  itself* structurally (as a JavaScript **property key**, or by reading
  `symbol.description`) cannot be rescued by a predicate, because a plain
  object is neither a property key nor has a `.description`. `@endo/ocapn`'s
  syrup layer does exactly this: `getSyrupSelectorName`
  (`packages/ocapn/src/syrup/js-representation.js:44`) reads `.description`, and
  syrup dictionary keys are selectors. Such sites need a representation change,
  not a guard change.
- **Silent identity loss (no error raised).** The primitive representation
  interns per name: `Symbol.for('foo')` decoded twice yields the *same*
  reference, so code keying a `Map`/`WeakMap` on a decoded passable symbol and
  expecting repeat decodes of the same name to hit the same key gets a correct
  cache. The tagged representation mints a **fresh object every decode** (the
  very property the [`t.deepEqual`
  advantage](#the-avatdeepequal-advantage-with-a-worked-example) celebrates), so
  such a cache silently degrades to a miss (no thrown guard, no structural
  mismatch, just a `WeakMap` that never hits). Because it fails silently rather
  than loudly, the implementation's tree audit must search for identity-keyed
  uses of decoded symbols specifically, not only `typeof`/`.description` uses.

This design surfaces the guard and structural classes (see [OCapN
selectors](#ocapn-selectors-endoocapn)) but has not audited the whole tree; every
such site is a latent break the implementation must find and address, and the
structural and silent-identity classes raise the implementation cost above "swap
the guards."

## Motivation

### The threat model, sharpened

The maintainer brief (reproduced under [Prompt](#prompt)) asserts a
memory-exhaustion vector; grounding it in the code confirms and sharpens it.

`passableSymbolForName` (`packages/pass-style/src/symbol.js`) is the decode
leaf for *every* incoming passable symbol name. A grep
(`grep -rn passableSymbolForName packages/`) finds **seven** call sites, not the
three wire codecs alone:

- smallcaps: `encodeToSmallcaps.js:363`, `return passableSymbolForName(encoding.slice(1))`
- capdata: `encodeToCapData.js:368`, `return passableSymbolForName(name)`
- `encodePassable` (ordered keys): `encodePassable.js:777`, `return passableSymbolForName(name)`
- Justin source-rendering, two sites: `marshal-justin.js:176` and `:334`, both
  `const sym = passableSymbolForName(name)` inside `decodeToJustin` (a public
  `@endo/marshal` export, re-exported from `index.js`, that renders received
  capdata as JS source). `decodeToJustin` **is** a decode-reachable leaf for the
  threat model (a host can plausibly feed attacker-supplied capdata into it for
  debug logging), so it grows the registry under `default` exactly like the wire
  codecs. Both sites immediately assert `assert.typeof(sym, 'symbol')`, so under
  the variant they not only swap (they call the same public
  `passableSymbolForName`) but also *break*: the tagged object fails that
  `typeof` guard. That guard is a recoverable-class break the implementation
  must make world-agnostic, and `decodeToJustin` must be added to the
  round-trip/registry-growth test catalog (see [Test and CI
  strategy](#test-and-ci-strategy-and-the-empirical-check-the-brief-demanded)).
- OCapN selectors: `packages/ocapn/src/selector.js:15`,
  `makeSelector(name) => harden(passableSymbolForName(name))`; on the swapped
  path, with a `typeof === 'symbol'` reader guard that breaks (see [OCapN
  selectors](#ocapn-selectors-endoocapn)).
- syrup selectors: `packages/ocapn/src/syrup/js-representation.js:37`,
  `SyrupSelectorFor(name) => passableSymbolForName('syrup:' + name)`. This leaf
  both swaps (it produces the tagged object under the variant) and is a
  structural break (its reader `getSyrupSelectorName` reads `.description`); see
  [OCapN selectors](#ocapn-selectors-endoocapn).

(Panel round 2 caught the syrup leaf missing from an earlier "three" count; this
seven-site count is grep-verified rather than re-counted from memory, so the
enumeration is exhaustive as of this writing.)

Its terminal line is `return Symbol.for(name)`. `Symbol.for` interns into the
**global symbol registry**: a process-wide, string-keyed table with **no
eviction and no per-realm/per-compartment scoping**. Once `Symbol.for('x')`
runs, the entry for `'x'` lives for the lifetime of the process and is shared
by every compartment and vat in it. There is no API to remove an entry and it
is never garbage-collected; the registry deliberately keeps the symbol alive
so that a later `Symbol.for('x')` returns the *same* symbol.

So any path by which untrusted content chooses the string handed to
`passableSymbolForName` is a path by which untrusted content grows an
unbounded, permanent, process-global table. Decoding an inbound message that
carries `N` distinct never-before-seen registered-symbol names adds `N`
permanent registry entries. This is:

- **not compartment-scoped**: a confined guest that can cause a decode grows
  a table shared by the whole process, escaping its memory allotment;
- **not vat-scoped**: the same in an Agoric-style multi-vat process;
- **durable**: surviving GC, compartment disposal, and vat termination.

An attacker who can get a peer to decode attacker-chosen symbol names, for
example by sending messages or by getting content reflected into a decode, has
a cheap, durable denial-of-service against total process memory. The cost to
the attacker is one string per entry on the wire; the cost to the victim is a
permanent registry slot per distinct name, forever.

Well-known symbols carry a smaller but related problem: they widen the passable
symbol category to a fixed set of engine-defined identities (`Symbol.iterator`,
`Symbol.asyncIterator`, ...) whose membership is a moving target across
JavaScript versions, encoded through the reserved-`@@` escape in `symbol.js`.
That escape is what `symbol.js`'s comments call the "Hilbert Hotel" scheme: a
collision-avoidance convention that reserves the `@@` prefix so a well-known
symbol's wire name can never be confused with a registered-symbol name of the
same spelling. For OCapN alignment we want passable symbols to be *exactly*
"a name," nothing engine-defined and nothing that touches a global registry.

### What this landing does and does not deliver

The threat above is sharpest in an Agoric-style multi-vat/compartment process,
where one confined guest can grow a table shared by trusted vats. This design
delivers the *mechanism* that closes the leak (the tagged reification, armed by
a Node condition) and its *test-harness* rollout (AVA `nodeArguments`, see
[Test and CI strategy](#test-and-ci-strategy-and-the-empirical-check-the-brief-demanded)).
It does **not** yet deliver the vat-deployment path. A bundled vat does not read
a runtime `-C` flag; `@endo/bundle-source` resolves `imports` at *build* time
through its own `conditions` bundling option
(`packages/bundle-source/src/main.js`), a materially different mechanism.
Threading `pass-style-symbol` through `bundle-source`'s `conditions` so a vat
bundle can opt in is future work, noted as an open question below
([open question 7](#open-questions)). Read the vat framing above as the
motivating *beneficiary* of the eventual rollout, not as something this landing
wires up.

State the consequence plainly, not just the scope: because open question 7
concedes a bundled vat cannot read `-C` and open question 9 concedes the
condition is process-wide, the lever cannot be pulled where the threat actually
lives (a single untrusted vat inside a shared-process kernel). As landed, the
*only* world that can arm the variant is an AVA test config's `nodeArguments`
(see [Test and CI strategy](#test-and-ci-strategy-and-the-empirical-check-the-brief-demanded)).
So the honest near-term value of this landing is "it proves the representation
and closes the leak for a process that opts in wholesale," not "it closes the
multi-vat DoS." The multi-vat close waits on the value-parameter shape
([open question 8](#open-questions)) or the bundle path
([open question 7](#open-questions)). The cross-package churn here buys the
proof and the migration lever, weighed against that, not against the DoS close.

### Two policies ride behind one condition

The `pass-style-symbol` condition bundles two logically independent changes, and
this design ships them atomically on purpose:

1. **The memory-exhaustion fix**: decode never calls `Symbol.for`, so no wire
   name grows the global registry. This is the security payload.
2. **The category narrowing**: well-known symbols cease to be a passable
   category and `@@`-prefixed names are rejected (the Hilbert Hotel escape is
   retired). This touches the registry not at all; `Symbol[suffix]` is a fixed
   engine-property lookup (`packages/pass-style/src/symbol.js:104-110`). This
   narrowing has **two** distinct casualties, not one: (a) well-known symbols
   (`Symbol.iterator` and friends) cease to be passable, and (b) a *registered*
   symbol whose own name begins with `@@` (e.g. `Symbol.for('@@foo')`) can no
   longer be represented either: today the double escape decodes `@@@@foo` on
   the wire back to `Symbol.for('@@foo')`
   (`packages/pass-style/src/symbol.js:104-106`), and the variant's blanket
   `@@`-rejection forecloses that registered case as collateral. Casualty (b) is
   the narrower one, easy to miss behind the headline "well-known symbols
   disappear."

They are separable in principle: one could keep well-known symbols and only
change the registered-symbol leaf, or reify `@@iterator` as a tagged object
literally named `@@iterator` with no `Symbol.for`. They are shipped together
because the tagged representation the security fix adopts *is* a plain object,
and a plain object has no way to denote "the engine's `Symbol.iterator`
identity": reifying well-known names as tagged objects would either invent a
second escape or silently alias distinct engine symbols to equal-by-name
objects. Rather than carry a second escape convention into the new
representation, the variant drops the well-known category. A deployer who wants
the memory fix therefore also accepts the receive-side narrowing that a
default peer's legal `@@iterator` message no longer decodes (see [Cross-variant
interop](#cross-variant-interop)). This coupling is a deliberate design choice,
recorded here so it is weighed rather than discovered; splitting it into two
conditions is [open question 3](#open-questions).

### Why a plain object closes it

The tagged-object representation carries the name in `Symbol.toStringTag` (an
ordinary string-valued own property) and never calls `Symbol.for` on decode.
`passableSymbolForName(name)` under the variant returns
`harden({ [PASS_STYLE]: 'symbol', [Symbol.toStringTag]: name })`: a fresh
object, immediately eligible for GC once unreferenced, touching no global
table. The unbounded-registry vector is closed at the leaf, for every call site
at once (the three marshal codecs, the two `decodeToJustin` sites, and the two
OCapN selector leaves), because all of them call the same swapped
`passableSymbolForName`. (This closes the vector
*at this leaf*; whether an equivalent intern table lives elsewhere in OCapN is
the subject of [open question 4](#open-questions), so "closed" here means
"closed at the pass-style decode leaf," not proven closed across every
downstream selector consumer.)

Well-known symbols disappear as a category: under the variant,
`assertPassableSymbol` rejects primitive symbols outright (see
[What swaps as one unit](#what-swaps-as-one-unit)), so `Symbol.iterator` is simply not
passable, and the `@@`-escape logic is not part of the variant module.

## The existing dispatch mechanism this rides on

This is **not** a new mechanism in `passStyleOf`. Two facts about the current
code make the tagged object a first-class citizen with essentially no new
machinery:

1. `PASS_STYLE = Symbol.for('passStyle')` is already exported from
   `packages/pass-style/src/passStyle-helpers.js`, and is already the tag every
   pass-by-copy container (records, arrays, tagged, errors, remotables) carries.
   This is the reason the tagged object's literal shows `Symbol.for('passStyle')`
   as a *key*: keying by `PASS_STYLE` is the standing pass-by-copy convention,
   independent of whether the represented value contains any primitive symbol.

2. `passStyleOf`'s object dispatcher already special-cases "a frozen object
   with an own `[PASS_STYLE]` string property" and routes it straight to
   `HelperTable[<that string>]`, bypassing the generic record/array scan
   (`packages/pass-style/src/passStyleOf.js`, the `object` case):

   ```js
   const passStyleTag = inner[PASS_STYLE];
   if (passStyleTag !== undefined) {
     assert.typeof(passStyleTag, 'string');
     const helper = HelperTable[passStyleTag];
     helper !== undefined || Fail`Unrecognized PassStyle: ${q(passStyleTag)}`;
     assertValid(helper, inner, passStyleOfRecur);
     return /** @type {PassStyle} */ (passStyleTag);
   }
   ```

   So a `[PASS_STYLE]: 'symbol'` object is *already* dispatched to
   `HelperTable['symbol']`; the only thing missing is a helper registered
   under that key.

`HelperTable` is not open, though. It is seeded from a fixed allowlist
(`makeHelperTable`, `passStyleOf.js`):

```js
const HelperTable = {
  __proto__: null,
  copyArray: undefined,
  byteArray: undefined,
  copyRecord: undefined,
  tagged: undefined,
  error: undefined,
  remotable: undefined,
};
```

and the helper list passed to `makePassStyleOf([...])` is likewise fixed. So
registering `'symbol'` means (a) adding `symbol: undefined` to that seed and
(b) adding a `SymbolHelper` (`styleName: 'symbol'`) to the list. Those are the
only two edits inside `passStyleOf.js` itself, and, critically, they are
**condition-independent** (see next section).

## What swaps as one unit

The unit swapped by the condition is exactly the `#pass-style-symbol-impl`
module. Everything else swaps transitively because it imports the function
surface from that alias rather than from `./symbol.js` directly, *provided it
reaches passable symbols through that surface* (the `typeof`-guard caveat in the
[Summary](#summary) is the exception).

### The two implementation modules

- **`src/symbol.js`** (the `"default"` target). Primitive-symbol semantics of
  the five shared functions are exactly as today. It gains **one** new export,
  a `SymbolHelper` validator for the tagged shape (see
  [The `HelperTable['symbol']` decision](#the-helpertablesymbol-decision-register-unconditionally)
  for why both modules must export it), so it is not literally untouched; the
  behavior of the five shared functions is unchanged.

- **`src/symbol-tagged.js`** (new; the `"pass-style-symbol"` target). Same five
  exports, tagged-object semantics:
  - `passableSymbolForName(name)` returns `harden({ [PASS_STYLE]: 'symbol',
    [Symbol.toStringTag]: name })`. No `Symbol.for`. No `@@` escape. `name`
    must be a well-formed string; names beginning `@@` are **rejected**
    (well-known symbols are not representable), which also removes the Hilbert
    Hotel escape entirely.
  - `nameForPassableSymbol(sym)` accepts the tagged object and returns its
    `Symbol.toStringTag` string, but **also rejects a `@@`-prefixed name** (it
    returns `undefined`, so the value does not read back as a passable symbol);
    it returns `undefined` for anything that is not a tagged object.
  - `isPassableSymbol` / `assertPassableSymbol` are true/pass **only** for the
    tagged object; a primitive `symbol` is **not** passable under the variant.
  - `unpassableSymbolForName(name)` keeps its intent (a distinct
    non-passable marker); it may stay `Symbol(name)` or also become a
    non-registered tagged object (see [Open questions](#open-questions)).
  - Additionally exports a `SymbolHelper` (a `PassStyleHelper` with
    `styleName: 'symbol'`, validating shape: frozen, own `[PASS_STYLE] ===
    'symbol'`, own string `[Symbol.toStringTag]` **whose value is not
    `@@`-prefixed**, no other own enumerable data).

  The `@@` rejection must be enforced at **all three doors**, not just the
  producer: `passableSymbolForName` (produce), `nameForPassableSymbol` (read),
  and `SymbolHelper` (validate). Otherwise a hand-built
  `harden({ [PASS_STYLE]: 'symbol', [Symbol.toStringTag]: '@@iterator' })` would
  classify as `passStyleOf === 'symbol'`, encode as `@@iterator`, and a
  `default` peer would decode it to `Symbol.iterator`: the variant's own
  emitter reintroducing the category it abolishes. The in-tree sibling already
  guards both of its doors this way: `packages/ocapn/src/selector.js` checks
  `@@` in **both** `makeSelector` (produce, line 10) and `getSelectorName`
  (read, line 35).

### A named world query, not a shape-sniff

The active world is ambient process state that, as designed so far, has no name
a call site can read. Both the test strategy and any world-aware consumer would
otherwise have to *sniff* the world by calling `passableSymbolForName('x')` and
inspecting the returned shape, which is exactly the `typeof`-style guard this
design elsewhere names as its breakage class, re-introduced as recommended
discipline. Worse, under `default` that probe has a **permanent side effect**:
`passableSymbolForName('x')` interns `'x'` into the global registry forever, so
the sniff feeds the very table this design exists to protect.

Both implementation modules therefore **export the world as data**: a single
named constant

```js
// src/symbol.js
export const passableSymbolRepresentation = 'primitive';
// src/symbol-tagged.js
export const passableSymbolRepresentation = 'tagged';
```

re-exported through `#pass-style-symbol-impl` (and, for consumers, through
`@endo/pass-style`). Tests and world-agnostic code branch on that named value
rather than on the shape of a minted symbol, with no side effect and no
shape-sniff. Both modules already exist, so this adds no mechanism, only a
constant. This is a **new** pattern in the repo, not a mirror of an existing
one: `@endo/harden`'s `hardenIsNoop` (`packages/harden/is-noop.js`) is sometimes
cited as precedent, but reading it shows it does the opposite: it *is* a
behavioral sniff (it hardens a synthetic object and inspects the resulting
property descriptor) and it detects a different axis entirely (SES lockdown's
`hardenTaming` option), not which `package.json` condition selected the module.
A repo-wide grep finds no package using an `imports` map at all, so this design
introduces the "named constant, zero-behavior world query" pattern rather than
following a proven one; it stands on its own merits.

One ergonomic seam remains: the caller *arms* the variant with the condition
name `pass-style-symbol` (versus `default`) but *queries* it as
`passableSymbolRepresentation === 'tagged'` (versus `'primitive'`): two
vocabularies for one concept, forcing the caller to memorize the mapping. The
constant could instead (or additionally) return the active condition name
itself, so the caller names the same world it armed; the implementation should
pick one vocabulary or export both.

Relatedly, because the world is ambient state a call site cannot see, the
variant module's error messages **must name the variant**: today
`assertPassableSymbol(Symbol.iterator)` throws `Only registered symbols or
well-known symbols are passable`, which names the category the variant just
removed. Variant errors should instead name `pass-style-symbol`, so a developer
who hits one under an ambiently-armed process is not sent chasing the wrong
model.

### The consumers that change their import specifier

Three in-package sites import the symbol functions from `./src/symbol.js`
directly and so do **not** swap unless their specifier is repointed at the
alias. For the first two, only the *specifier* changes; the code does not.

- `packages/pass-style/index.js` currently re-exports the five functions
  `from './src/symbol.js'`. Change that to `from '#pass-style-symbol-impl'`.
  Because marshal's encoders import `nameForPassableSymbol` /
  `passableSymbolForName` from `@endo/pass-style` (the public entry), this one
  edit swaps the entire marshal encode/decode chain (`encodeToSmallcaps.js`,
  `encodeToCapData.js`, `encodePassable.js`) with **no change to marshal at
  all**. The wire format is *invariant*: on the wire a symbol is still its
  name string; only the in-memory value that name reifies to changes. A
  `default` sender and a `pass-style-symbol` receiver therefore interoperate
  on the wire; they disagree only about the *local* JS value a name denotes,
  which is exactly the intended semantic difference and never a silent
  corruption (see [Cross-variant interop](#cross-variant-interop)).

- `packages/pass-style/src/passStyleOf.js` currently imports
  `assertPassableSymbol` `from './symbol.js'`. Change that to
  `from '#pass-style-symbol-impl'`. This makes the primitive `case 'symbol':`
  arm swap for free: under `default`, `assertPassableSymbol` accepts primitive
  passable symbols (today's behavior); under the variant, it throws, so
  primitive symbols are not passable and the `Symbol.for`-registry classify
  path is closed on this side too.

- `packages/pass-style/tools/arb-passable.js:6` imports `passableSymbolForName`
  from `../src/symbol.js` **directly** (not through the public entry), and ships
  via `tools.js`; it is the fast-check arbitrary that mints example passable
  symbols. Left unchanged it keeps minting *primitive* symbols labeled Passable
  even under the variant, so every property test built on it would either fail
  or, worse, silently exercise the wrong world (the proposed variant config's
  `files: ['test/**/*.test.*']` runs them). Its specifier must therefore also be
  repointed at `#pass-style-symbol-impl`, so the arbitrary produces the tagged
  object under the variant. Unlike the first two, this is a genuinely
  world-sensitive site the implementation must not miss.

### The `HelperTable['symbol']` decision: register unconditionally

Recommendation: **register the `symbol` style unconditionally, and make
`SymbolHelper`'s validator probe `nameForPassableSymbol(val) !== undefined`
under the active world** (option (b) of [open question 1](#open-questions)). Add
`symbol: undefined` to the `makeHelperTable` seed and add `SymbolHelper` to the
`makePassStyleOf([...])` list *in both branches*, sourced from
`#pass-style-symbol-impl`. Because `passStyleOf.js` sources `SymbolHelper`
through that alias, and under `default` the alias resolves to `src/symbol.js`,
**`src/symbol.js` must also export a `SymbolHelper`** (this is the one new
export noted in [The two implementation
modules](#the-two-implementation-modules)). Both modules therefore export a
structurally-identical validator for the tagged shape; only the five
*behavioral* functions differ between them.

The bare-structural variant of this recommendation (option (a), validate shape
only) is **rejected** precisely because it breaks the completeness invariant
that `passStyleOf`/`assertPassable` are relied on to hold. Under (a), a
hand-built tagged object classifies as `passStyleOf === 'symbol'` while
`default`'s `nameForPassableSymbol` returns `undefined`, so the value is
"classified-but-unencodable": consumers that lean on classification as a
*complete* Passable predicate (CopySet/CopyMap key admission, `sameStructure`,
remote-argument gating) admit a value the encoders then reject. Folding the
`nameForPassableSymbol` probe into the validator (option (b)) keeps
`passStyleOf` a single code path *and* keeps acceptance and encodability from
diverging, so a value classifies as `'symbol'` only if the active world can also
turn it back into a name. Rationale for keeping registration unconditional
rather than swapping `HelperTable` (option (c)):

- It keeps `passStyleOf.js` a single code path with no condition-branching of
  its own: less risk, one thing to reason about.
- It is **harmless under `default`**: nothing in a `default` process ever
  *produces* the tagged-object shape (the default `passableSymbolForName`
  returns primitives), so `HelperTable['symbol']` is never reached by the object
  dispatcher for any real value; the primitive `case 'symbol':` continues to
  handle real symbols.
- Under the probe, a hand-built tagged object in a `default` process is
  **rejected**, not recognized, and this is the same end result as option (c),
  so it is *not* a benefit (b) can claim over (c). The recommended validator
  calls the active world's `nameForPassableSymbol`, which under `default` cannot
  turn a tagged object into a name, so the helper's `assertValid` fails and
  `passStyleOf` throws (a validation error). Option (c), with `'symbol'`
  unregistered, instead throws `Unrecognized PassStyle: 'symbol'`. The two
  differ only in the *shape* of the rejection, not in whether a default process
  admits the tagged object; both reject it. The "recognize a hand-built tagged
  object under `default`" property belongs to the **rejected** option (a) (bare
  structural validator), and is exactly the property that breaks the
  completeness invariant (next paragraph), which is why (b) drops it. So the
  genuine reason to prefer (b) over (c) is the single code path (first bullet),
  not any difference in what default admits.

Why the probe is part of the recommendation and not merely an option: option
(a)'s "recognize a hand-built tagged object under `default`" property is exactly
where the bare-structural validator would break the completeness invariant. A purely
structural `SymbolHelper` (frozen, own `[PASS_STYLE] === 'symbol'`, own string
`[Symbol.toStringTag]`) does not consult whether the active world's
`nameForPassableSymbol` can turn the value back into a wire name; so under
`default` it would green-light a value (`passStyleOf(val) === 'symbol'`) that
`default`'s `nameForPassableSymbol` cannot encode (see [The consumers that
change their import
specifier](#the-consumers-that-change-their-import-specifier)): the
classified-but-unencodable split-brain that consumers relying on classification
as a *complete* predicate (CopyMap/CopySet key admission, `sameStructure`,
remote-argument gating) would trip over. The recommended validator therefore
*additionally* probes `nameForPassableSymbol(val) !== undefined` under the
active world, so classification and encodability cannot diverge. That is what
makes option (b), not option (a), the recommendation.

Option (c), making `HelperTable` itself part of the swap so `'symbol'` exists
*only* under the variant, is viable and also sidesteps the split-brain, but
adds a second conditional surface (`passStyleOf.js` would branch on the
condition too, rather than staying a single code path). It is recorded as
[open question 1](#open-questions)(c) for maintainers who prefer the stricter
"the shape is meaningless unless armed" stance.

Note that the two `'symbol'`-producing paths coexist by construction and never
collide. Within a single process the condition is fixed, so at most one path is
*active*: under `default` only the primitive path produces passable symbols,
and the tagged path is dormant but present; under the variant only the tagged
path produces passable symbols, and the primitive `case 'symbol':` throws. They
are not two live producers racing; they are one live producer and one
inert-but-registered fallback.

### Alternative considered: a value parameter instead of a process condition

The chosen mechanism binds "which symbol representation this process produces"
to a Node resolution condition resolved once at startup. A reviewer rightly
asks why the choice is not an ordinary value-oriented parameter, given that
`passStyleOf`'s `[PASS_STYLE]` dispatch is *already* value-oriented (any object
carrying the tag classifies correctly regardless of which code minted it, and
the recommendation to register `SymbolHelper` unconditionally concedes that
*recognizing* the tagged shape needs no condition at all). Only *producing* a
representation needs a choice, and that choice is expressible as a
constructor-time option to `makePassStyleOf` / `makeMarshal` rather than as
ambient process state.

The value-parameter approach has a real advantage: it decouples the policy
("emit tagged symbols") from module resolution, so a single process could put
one marshal instance (an untrusted vat's decode path) behind the hardened
representation while another keeps default interop, matching the *vat*
granularity the threat model invokes rather than the coarser *process*
granularity a condition imposes.

The condition mechanism was chosen anyway for this landing because the swap
must reach code that does **not** take a marshal instance as a parameter:
`passStyleOf` is called through module-level singletons, and marshal's encoders
import `passableSymbolForName`/`nameForPassableSymbol` as free module bindings,
not as injected capabilities. Threading a value parameter to every such call
site is a much larger, cross-package refactor than a resolution alias, and it
changes public constructor signatures. The condition is the *easy* mechanism
and is explicitly a **migration lever**, not the end state. The value-parameter
design is the better long-term shape and is recorded as [open question
8](#open-questions); the coarse process-vs-vat granularity it would fix is
[open question 9](#open-questions). This section exists so the tradeoff is on
the record rather than silently foreclosed.

### Alternative considered: a representation-preserving intern table

The value-parameter alternative above still changes the *representation* (a
symbol becomes an object). A cheaper alternative closes the same threat while
keeping `typeof passable === 'symbol'`, and it must be weighed on the record
because the entire cost surface this design accepts (a `HelperTable` entry, a
Node condition, a second AVA config, a second tsconfig, a published-type
divergence, the `selector.js` edits, and a tree-wide `typeof`-guard audit) is
justifiable only against the cheapest alternative that closes the same threat.

All three defects the [threat model](#the-threat-model-sharpened) names ("not
compartment-scoped", "not vat-scoped", "durable") are properties of the
**global** registry, not of primitive symbols as such. A decode leaf that mints
`Symbol(name)` (a fresh, *non-registered* symbol) and reads the name back from
`symbol.description`, interning `name -> symbol` in a table **owned by the
marshal instance** rather than by the engine, closes all three: the table is
GC-scoped to the instance, disposed with it, never process-global. Crucially it
keeps every `typeof === 'symbol'` guard true, keeps the published `.d.ts` saying
`symbol`, keeps `packages/ocapn/src/selector.js` and the syrup `.description`
reads working unchanged, and needs no `HelperTable` entry, no condition, no
second config, and no `typeof`-audit. This is not hypothetical: `@endo/ocapn`
already ships exactly this scheme: `SyrupSelectorFor`
(`packages/ocapn/src/syrup/js-representation.js:36`) mints a passable symbol for
a name and `getSyrupSelectorName` reads it back off `.description`.

Why the tagged object is chosen over it anyway:

- **Per-value GC beats a per-instance table.** The tagged object is collectable
  the instant it is unreferenced; the intern table holds every distinct decoded
  name alive for the life of the marshal instance. For a long-lived instance
  decoding attacker-chosen names, that is the same unbounded-growth shape as the
  registry, merely instance-scoped rather than process-scoped: it narrows the
  blast radius but does not make decode allocation-neutral. (A `WeakValue`-keyed
  table mitigates this but complicates equality.)
- **Structural equality vs. identity.** The intern table preserves same-name
  `===` identity *within* an instance but loses it *across* instances (two
  marshal instances mint distinct `Symbol('foo')`); the tagged object has no
  cross-instance identity either, but recovers "same conceptual symbol" as a
  *structural* fact (`t.deepEqual`), which the primitive cannot (see [The
  AVA/`t.deepEqual` advantage](#the-avatdeepequal-advantage-with-a-worked-example)).
- **`Symbol.description` is not a hardened, spoof-proof carrier.** Reading a
  name back off `.description` reintroduces a primitive whose description is
  engine-controlled and not a pass-by-copy own property; the tagged object
  carries the name as an ordinary, hardenable own property under the standing
  `[PASS_STYLE]`/`[Symbol.toStringTag]` convention.

The intern table remains a legitimate contender on cost, and a maintainer who
weights "no representation change, no tree-wide audit" above per-value GC and
structural equality could reasonably prefer it. It is rejected here, not
omitted, so the choice is on the record.

## The condition wiring (`package.json` `imports`)

Add a package-private `imports` field to `packages/pass-style/package.json`.
`#`-prefixed specifiers are resolvable **only** from within the package, so
this is not public API:

```jsonc
{
  "name": "@endo/pass-style",
  "type": "module",
  "main": "./index.js",
  "exports": {
    ".": "./index.js",
    "./tools.js": "./tools.js",
    "./endow.js": "./endow.js",
    "./package.json": "./package.json"
  },
  "imports": {
    "#pass-style-symbol-impl": {
      "pass-style-symbol": "./src/symbol-tagged.js",
      "default": "./src/symbol.js"
    }
  }
}
```

Resolution order in an `imports`/`exports` object is source order, first match
wins; `"default"` must be last. With no `-C pass-style-symbol`, only
`"default"` matches and resolves to `./src/symbol.js`, today's behavior. With
`node -C pass-style-symbol`, the `"pass-style-symbol"` key matches first and
resolves to `./src/symbol-tagged.js`.

### The load-bearing caveat: resolution is per-process, once, at startup

Node resolves conditional `imports`/`exports` **once per process, for the
whole module graph, at load time**. It is not a per-call, per-package, or
per-import runtime toggle. There is no supported way to load *both* branches in
one process, and no way to flip mid-run. Consequences that must be designed
around, not glossed:

- Turning the condition on affects **every** consumer transitively loaded in
  that process, not just `@endo/pass-style`'s own tests, but any package
  whose test process imports pass-style symbols indirectly (marshal, ocapn,
  and anything downstream). A process is wholly in one world or the other.
- Therefore "test both branches" means **two processes**, never one. You
  cannot assert default and variant behavior in the same test file.
- A mixed deployment (some peers default, some variant) is a *wire*
  interoperation question, answered in [Cross-variant interop](#cross-variant-interop),
  not an in-process one.

## Test and CI strategy, and the empirical check the brief demanded

The brief insists we not *assume* that AVA forwards a `-C` flag to whatever
process ultimately resolves the conditional import, but confirm it. **The
forwarding path is already load-bearing in this very repo**, by a mechanism the
pass-style suite depends on today:

- Every Endo AVA config sets `nodeArguments: ['-C', 'ses-ava:endo']`
  (`ava-endo-lockdown.config.mjs` and siblings). AVA applies `nodeArguments`
  to the Node worker processes it spawns to run test files.
- `@endo/ses-ava`'s `package.json` `exports` for `./test.js` has a
  `"ses-ava:endo"` conditional branch resolving to `./prepare-endo.js`. That
  branch is selected **only** because the `-C ses-ava:endo` in `nodeArguments`
  reaches the worker where module resolution happens.
- The pass-style test suite imports `@endo/ses-ava/test.js` and gets the Endo
  prepared harness today, which is only possible if the condition reached the
  worker. So the forwarding path (`ava nodeArguments`, then worker `execArgv`,
  then conditional resolution) is a **load-bearing, already-exercised** fact,
  not an assumption.

This also tells us *where* to inject `pass-style-symbol`: through an AVA
config's `nodeArguments`, driven by `ses-ava`'s existing multi-config
mechanism (`sesAvaConfigs` in `package.json`, dispatched by
`packages/ses-ava/src/command.js`, which spawns `ava --config <file>` once per
named config).

Concretely:

1. Add a config file `ava-endo-lockdown-pass-style-symbol.config.mjs` (repo
   root, beside the existing ones):

   ```js
   export default {
     nodeArguments: ['-C', 'ses-ava:endo', '-C', 'pass-style-symbol'],
     require: ['@endo/ses-ava/prepare-endo-config.js'],
     files: ['test/**/*.test.*'],
     timeout: '2m',
   };
   ```

   Both `-C` flags are passed; `ses-ava:endo` is still needed for the harness.
   The design *expects* that Node **unions** repeated `-C`/`--conditions` (so
   `node -C a -C b` against an `imports` map listing both `a` and `b` activates
   *both*), and that which *target* a given alias resolves to is decided by
   the order of keys in the `imports` map (first match wins), not the order of
   the flags. `ses-ava:endo` and `pass-style-symbol` sit on *different* aliases
   (`@endo/ses-ava`'s `exports` versus pass-style's `imports`), so on this
   expectation they never compete and each resolves independently. This
   union-and-map-order behavior is stated as *expected, not yet observed in
   this repo*; the implementation PR must observe it once against the actual
   Node in CI (see [open question 6](#open-questions)) rather than shipping it
   as settled fact.

2. Register it in `packages/pass-style/package.json` `sesAvaConfigs`:

   ```jsonc
   "sesAvaConfigs": {
     "lockdown": "../../ava-endo-lockdown.config.mjs",
     "unsafe": "../../ava-endo-lockdown-unsafe.config.mjs",
     "endo": "../../ava-endo-shims-only.config.mjs",
     "pass-style-symbol": "../../ava-endo-lockdown-pass-style-symbol.config.mjs"
   }
   ```

   `ses-ava` runs every named config serially, so a bare `yarn test` now
   exercises **both** worlds. To run only the variant during development:
   `yarn test --only pass-style-symbol` (ses-ava's `--only`/`-o` filter). A
   dedicated script is optional sugar:

   ```jsonc
   "test:pass-style-symbol": "ses-ava --only pass-style-symbol"
   ```

3. **Make the test files world-aware.** Because a given worker is wholly in
   one world, a shared test file cannot assert "primitive under default AND
   tagged under variant" in one run. The clean split:
   - Keep the existing symbol tests asserting **default** (primitive) behavior;
     they run under the default configs and, under the variant config, the
     assertions that a passable symbol is a primitive `symbol` would **fail**,
     so they must be gated. Gate on the **named world query** rather than
     sniffing a minted value (Node exposes no "is condition X active" API, but
     this design exports one: see [A named world query, not a
     shape-sniff](#a-named-world-query-not-a-shape-sniff)). Import
     `passableSymbolRepresentation` from `@endo/pass-style` and branch on
     `passableSymbolRepresentation === 'primitive'` vs. `'tagged'`, with no
     shape inspection and no `Symbol.for` side effect on the global registry.
     Alternatively, split into `symbol.test.js` (runs default config only) and
     `symbol-tagged.test.js` (runs variant config only) via AVA's per-config
     `files` globs.
   - Add variant-only tests asserting: `passableSymbolForName` returns the
     tagged object; it never grows the registry (see the registry-growth
     regression test below); primitive symbols are **not** passable;
     `passStyleOf(tagged) === 'symbol'`; a hand-built tagged object is
     *accepted* by classification (the `SymbolHelper` probe succeeds, since the
     variant's `nameForPassableSymbol` yields its name), so classification and
     encodability agree; a full marshal round-trip (`toCapData`/`fromCapData`,
     smallcaps, `encodePassable`) reifies to the tagged object; and
     `decodeToJustin` renders a `{'@qclass':'symbol'}` tree without throwing
     (its `assert.typeof(sym, 'symbol')` guards, `marshal-justin.js:176`/`:334`,
     must have been made world-agnostic).
   - Add a **default-world** test asserting the mirror property the
     `HelperTable['symbol']` decision turns on: a hand-built tagged object
     (`harden({ [PASS_STYLE]: 'symbol', [Symbol.toStringTag]: 'foo' })`) is
     *rejected* under `default` (`passStyleOf` throws because `SymbolHelper`'s
     probe calls `default`'s `nameForPassableSymbol`, which yields no name), so
     classification never green-lights a value the default encoders cannot
     encode. This pins down which of the two candidate `SymbolHelper` behaviors
     (accept-structurally, option (a); vs. probe-and-reject, option (b)) actually
     ships.

4. **Add a registry-growth regression test** (variant world) that makes the
   security claim executable rather than asserted:

   ```js
   const before = Symbol.for(freshName); // interns once
   // decode many distinct fresh names via passableSymbolForName / fromCapData
   // assert none of them are found by Symbol.keyFor on the decoded values
   // (decoded values are objects, keyFor(object) throws/undefined), and that
   // Symbol.for(sameName) still returns a *fresh-to-the-registry* entry,
   // i.e., decode did not pre-intern it.
   ```

   Contrast with the default world, where decoding those names *does* intern
   them (`Symbol.keyFor(decoded) === name`). The two tests together are the
   worked proof of the threat model and its fix.

5. **Add cross-variant interop tests.** The two claims [Cross-variant
   interop](#cross-variant-interop) makes are testable in-process today, with
   literal wire payloads and no live two-peer setup:
   - *default emits, variant decodes.* Construct the wire encoding a `default`
     peer produces for a `@@iterator` (well-known) name literally, hand it to a
     variant-world decoder, and assert it is **rejected** (the variant refuses
     `@@` names) rather than silently mis-decoded. Repeat with a
     registered-symbol name and assert it decodes to the tagged object.
   - *variant emits, default decodes.* Take a variant-emitted registered name
     off the wire, decode it in a default-world process, and assert it
     `Symbol.for`-interns (`Symbol.keyFor(decoded) === name`), demonstrating
     that a default peer re-grows its own registry from variant-emitted names.
   Because a worker is wholly one world, each direction is a separate
   world-gated test that constructs the *other* world's payload as a literal
   rather than by running the other world live.

6. **Let CI run the whole matrix** by virtue of `ses-ava` iterating all
   `sesAvaConfigs`. No CI YAML change is required beyond ensuring pass-style's
   `test` script stays `ses-ava` (it does). Optionally add an explicit
   `test:pass-style-symbol` job for signal isolation, but it is redundant with
   the default `test`.

## The AVA/`t.deepEqual` advantage, with a worked example

This section is an *ergonomics* property of the tagged representation, distinct
from the security motivation above; it is a reason the variant is nicer to
assert on, not itself a reason the DoS closes. Because the reified value is a
plain object, AVA's `t.deepEqual` structurally compares two instances by their
own properties (`[Symbol.toStringTag]` and `[PASS_STYLE]`), which is exactly
pass-by-copy identity ("same name implies same symbol"). Primitive symbols
cannot do this: two independently produced symbols are `===`-unequal unless
they happen to share a registry entry, and `t.deepEqual` on primitive symbols
compares them by identity, so a genuine pass-by-copy equivalence reads as
*unequal*.

Worked example (variant world):

```js
import { passableSymbolForName } from '@endo/pass-style';

// Two independently decoded "foo" selectors from two different messages:
const a = passableSymbolForName('foo');
const b = passableSymbolForName('foo');

// Variant: fresh objects each time, but structurally identical.
t.not(a, b);            // not === (fresh objects), as with fresh symbols
t.deepEqual(a, b);      // structurally equal by [toStringTag]/[PASS_STYLE]
t.deepEqual(a, {
  [Symbol.for('passStyle')]: 'symbol',
  [Symbol.toStringTag]: 'foo',
});                     // the reified shape is inspectable and assertable
```

Contrast the default world, where `passableSymbolForName('foo')` is
`Symbol.for('foo')`: there `a === b` (registry-interned), but a *non-registered*
conceptual duplicate (`Symbol('foo')`) is neither `===` nor `t.deepEqual` to
it, and `t.deepEqual(sym, sym2)` gives you no structural recourse. The variant
makes "same conceptual symbol" a *structural* fact AVA can see. This should be
demonstrated by an early test committed with the implementation, not merely
asserted in prose.

## OCapN selectors (`@endo/ocapn`)

`packages/ocapn/src/selector.js` builds `makeSelector` / `getSelectorName`
directly on `passableSymbolForName` / `nameForPassableSymbol` from
`@endo/pass-style`. It is therefore **already** on the swapped path: with no
change to `selector.js`, under the variant `makeSelector('foo')` returns the
tagged object and `getSelectorName` reads it back.

But `selector.js` has a hard primitive assumption that **breaks under the
variant** and must be addressed:

```js
export const getSelectorName = selector => {
  if (typeof selector !== 'symbol') {
    throw new Error(`Expected symbol, got ${typeof selector}: ...`);
  }
  ...
};
```

Under the variant a selector is `typeof === 'object'`, so `getSelectorName`
throws on its own valid selectors. `makeSelector` also `harden(...)`s the
result (fine for an object) but its `@@`-prefix guard is now redundant with the
variant leaf's own rejection.

`selector.js`'s guards are the **recoverable** class (see [Summary](#summary)):
validate "is this a passable symbol" via `isPassableSymbol` /
`nameForPassableSymbol` returning a string, not via `typeof === 'symbol'`.
Recommendation: **bring OCapN selectors under the same condition and make those
guards world-agnostic as part of arming the variant.** Since OCapN alignment is
a *stated motivation* for this whole effort, leaving selectors on primitive
symbols while pass-style moves would be self-defeating.

The syrup layer is the **unrecoverable** class, and the design must flag it as a
harder cost than `selector.js`. `packages/ocapn/src/syrup/js-representation.js`
mints its selectors through `passableSymbolForName`
(`SyrupSelectorFor`, `js-representation.js:37`), so it is one of the leaves that
swaps to the tagged object under the variant, and then reads the name back with
`getSyrupSelectorName` (`js-representation.js:44`) off
`selectorSymbol.description`, and uses selectors as **JavaScript dictionary
keys** (`js-representation.js:160-180`). A tagged object has
no `.description` and cannot be a property key at all, so **no predicate swap
recovers this**: it needs a representation change (read the name from
`[Symbol.toStringTag]`, key syrup dictionaries by string) or it must stay on the
primitive scheme independent of the pass-style world. A reader auditing `typeof`
guards will hit these first and mis-scope the work as guard edits, so the design
names it explicitly. Note this file documents itself as "not used in OCapN...
useful for testing and debugging," so it is not on the production OCapN wire
path, but it is a real in-tree consumer that breaks.

The concrete edits to either file are **implementation**, out of scope for this
design; this document's job is to flag that selectors are on the path, that
`selector.js`'s `typeof` guards are the recoverable breakage, and that the syrup
layer's `.description`/property-key use is the unrecoverable breakage. Whether
OCapN's own wire/table representation needs any further change is
[open question 4](#open-questions).

## Typecheck, `.d.ts`, and ESLint under the non-default condition

`moduleResolution` is `NodeNext` (root `tsconfig.eslint-base.json`) and
TypeScript is `~6.0.3`. NodeNext TypeScript **does** resolve package `imports`
maps, and it picks the branch according to its own condition set. By default
`tsc` resolves `#pass-style-symbol-impl` to the `"default"` target
(`src/symbol.js`), so ordinary `yarn lint:types`, `.d.ts` emit, and ESLint
only ever *see and typecheck the default branch*. The variant module
(`src/symbol-tagged.js`) would then **silently bit-rot**: never typechecked,
its `.d.ts` never generated, type errors invisible until someone runs it.

TypeScript's answer is the `customConditions` compiler option (supported under
`node16`/`nodenext` resolution, TS 5.0 or later, so fine at 6.0.3). Provide a
second tsconfig that types the variant branch:

```jsonc
// packages/pass-style/tsconfig.pass-style-symbol.json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "customConditions": ["pass-style-symbol"]
  }
}
```

and a lint step that runs it, so both branches are covered:

```jsonc
"lint:types": "tsc && tsc --project tsconfig.pass-style-symbol.json"
```

Constraints this imposes, which the implementation must honor so *either*
branch typechecks cleanly:

- `src/symbol.js` and `src/symbol-tagged.js` must present **structurally
  compatible** exported types for the five shared functions, so that
  `index.js` and `passStyleOf.js` (which import through the alias and are
  typed under *one* branch at a time) typecheck against whichever module the
  active `customConditions` selects. The cleanest discipline: a shared
  `symbol-impl.d.ts` (or a JSDoc `@typedef` in a shared types module) that
  both modules `@satisfies`/annotate against, so the surface cannot drift.
- The **published `.d.ts`** for the package's public API (`index.js`
  re-exports) describes the **default** (primitive `symbol`) surface, and the
  variant tsconfig is a check-only pass (`--noEmit` or a separate outDir), not
  the source of published types. This means a consumer who opts into the variant
  via `-C pass-style-symbol` would, without further action, get IDE/tsc types
  saying `symbol` while the runtime value at that call site is an object: types
  that actively vouch for the wrong shape to exactly the segment that opted in.
  **This type divergence is not solved by anything a consumer sets in its own
  tsconfig, and the design must not claim otherwise.** Three facts make a
  consumer-side `customConditions: ["pass-style-symbol"]` a non-remedy:
  - `#pass-style-symbol-impl` is a **package-private `imports` specifier**,
    resolvable by Node/TS spec only from *inside* `@endo/pass-style`'s own
    source. No consumer ever writes or resolves it, so no consumer condition set
    selects between its branches.
  - `@endo/pass-style`'s public `exports["."]` is **unconditional**
    (`./index.js`, confirmed in `packages/pass-style/package.json`), so there is
    **no conditional branch at the package boundary** for a consumer's
    `customConditions` to pick between.
  - A consumer never re-resolves the dependency's internal module graph at all.
    TypeScript consumes the dependency's **already-emitted `.d.ts`**, produced
    once in the *producing* package's own build context under whichever branch
    *that* build resolved. A downstream compiler flag cannot retroactively
    change an artifact baked at publish time.

  So the **required** fix (not an additive future refinement) is a
  variant-gated **public** `.d.ts` exposed by `@endo/pass-style` itself, through
  `exports` `types` conditions on the package boundary, the only place a
  consumer's condition set can actually select a types branch. Until that ships,
  an opted-in consumer's published types say `symbol` while the runtime value is
  an object, a silent type lie; this is not a documented-away corner but the
  gating problem the variant's public-types story must solve, and it is
  [open question 5](#open-questions).
- Because the runtime opt-in (`-C pass-style-symbol`) and any type opt-in are
  two independent switches, they can **silently diverge**: a consumer that arms
  the runtime flag but not the matching types resolution gets types that vouch
  for `symbol` while the value is an object, with no build or lint failure: the
  worst error-visibility outcome, undetectable at the point the consumer could
  act on it. A README note is not a sufficient remedy. The public `exports`
  `types` condition above is the *structural* fix (it collapses the two switches
  into the one condition Node already resolves at runtime, so there is no
  separate tsconfig flag to forget). If the two must stay separate for any
  reason, the fallback is an **enforceable check**, not prose: a dev-mode
  runtime assertion that the resolved `passableSymbolRepresentation` matches the
  representation the consumer's types were built against (surfaced as a thrown
  error under a dev flag, or a CI-checked invariant), so the mismatch fails loud
  rather than as a first-use crash.
- ESLint: `import/*` resolvers must understand the `#`-alias. ESLint runs under
  default conditions and will resolve `#pass-style-symbol-impl` to
  `src/symbol.js`; `src/symbol-tagged.js` is still linted as an ordinary file
  because it matches the `include`/lint globs directly (it is a real file on
  disk), so lint coverage of the variant module does not depend on condition
  resolution; only its *type* coverage does, which the second tsconfig
  supplies.

## Cross-variant interop

Because the wire format is invariant (a symbol is its name string on the
wire, in all three codecs), a `default` peer and a `pass-style-symbol` peer
**interoperate at the byte level**. They disagree only about the local JS
value a decoded name denotes: the default peer reifies `Symbol.for(name)` (or
a well-known symbol); the variant peer reifies the tagged object (and refuses
`@@` well-known names). This is a *semantic* divergence, chosen deliberately,
not a silent corruption:

- default to variant: a message carrying `@@iterator` (a well-known symbol
  name) decodes on the variant peer as a **rejected** name (variant refuses
  `@@`), surfacing as a decode error, not a wrong value. A registered-symbol
  name decodes to the tagged object, the intended representation.
- variant to default: the variant peer only ever *emits* names it can
  represent (no `@@`), so the default peer decodes them via `Symbol.for` and
  thereby re-introduces the registry-growth exposure **on the default peer**.
  The variant protects the *variant* peer's process; it does not retroactively
  protect a default peer it talks to. That is inherent to "not the default"
  and is the reason the condition exists as a migration lever, not a wire
  change.

The design does **not** attempt a wire discriminator between the two: the
whole point is that the name string is the wire contract and only the local
reification changes. If the maintainers later want the *wire* to forbid
well-known/`@@` names universally (so a default decoder also refuses them),
that is a separate wire-format change, noted as an open question.

## Rollout

1. Land this design (PR against `llm`).
2. Implement `src/symbol-tagged.js` + `SymbolHelper`, the `imports` alias, the
   `SymbolHelper` export added to `src/symbol.js`, the two specifier edits, the
   shared type surface, the second AVA config + `sesAvaConfigs` entry +
   world-aware tests (including the registry-growth regression, the
   cross-variant interop tests, and the `t.deepEqual` proof), and the second
   tsconfig for type coverage. Default behavior byte-identical.
3. Make `@endo/ocapn`'s `selector.js` world-agnostic (replace `typeof ===
   'symbol'` guards with passable-symbol predicates) and add its own variant
   test config, so selectors travel with the condition.
4. Only later, and separately, consider whether any consumer should make
   `pass-style-symbol` its *default* (a decision with wire-interop
   consequences, above, explicitly out of scope here), and whether the vat
   deployment path (open question 7) or the value-parameter shape (open
   question 8) supersedes the condition lever.

## Open questions

1. **`HelperTable['symbol']`: unconditional vs. swapped, and the
   classified-but-unencodable asymmetry.** This design recommends registering
   the `symbol` style unconditionally *with a `nameForPassableSymbol` probe in
   the validator* (option (b)), which keeps `passStyleOf` single-path. Bare
   unconditional registration (option (a), no probe) would let a hand-built
   tagged object classify as `passStyleOf === 'symbol'` under default while
   `nameForPassableSymbol` returns `undefined` for it, so an encoder that trusts
   the classification fails later rather than at classification time; the
   recommended probe closes that asymmetry by *rejecting* such an object under
   default instead (see [The `HelperTable['symbol']` decision: register
   unconditionally](#the-helpertablesymbol-decision-register-unconditionally)).
   Do the
   maintainers prefer (a) unconditional registration as-is, (b) unconditional
   registration with a `nameForPassableSymbol`-probe in `SymbolHelper`'s
   validator so acceptance and encodability cannot diverge, or (c) the stricter
   swapped stance where `'symbol'` is unrecognized unless the variant is armed?

2. **`unpassableSymbolForName` under the variant.** Should it remain
   `Symbol(name)` (a primitive, non-registered marker) or also become a
   non-passable tagged object? It is the "definitely not passable" escape
   hatch; keeping it a primitive is simplest, but a process that has otherwise
   abolished passable primitive symbols may want no primitive symbols in play
   at all.

3. **Well-known names on the wire.** Should the *wire* contract forbid
   `@@`-prefixed (well-known) names universally, so that even a `default`
   decoder refuses them, closing the well-known category everywhere rather
   than only in the variant's local reification? That is a wire-format change
   beyond this per-process reification swap.

4. **OCapN selector representation depth.** Beyond making `selector.js`'s
   `typeof` guards world-agnostic, does OCapN's own selector table / equality
   anywhere rely on primitive-symbol identity (`===`, `Symbol.keyFor`) in a way
   the tagged object breaks? A survey of `@endo/ocapn` selector *consumers*
   (not just `selector.js`) is needed before selectors can be declared safe
   under the variant, and before the "vector closed" claim can be extended past
   the pass-style decode leaf.

5. **Published `.d.ts` branch and a variant-gated public type export.** As
   [Typecheck](#typecheck-dts-and-eslint-under-the-non-default-condition) now
   establishes, a consumer-side `customConditions` setting **cannot** deliver
   variant types (the alias is package-private, the public `exports["."]` is
   unconditional, and a consumer consumes the producing package's pre-emitted
   `.d.ts`). So the only mechanism that gives an opted-in consumer correct types
   is a variant-gated **public** `.d.ts` exposed by `@endo/pass-style` through
   `exports` `types` conditions. This is a **required** part of the variant's
   public-types story, not an optional refinement: decide the exact shape of
   those `exports` `types` conditions and whether the package ships variant types
   at all, or whether the variant is deliberately typed as the default surface
   with the divergence documented as a known limitation. If any downstream
   package intends to *ship* under the variant, its own published types diverge
   and that needs its own decision on the same mechanism.

6. **AVA-worker end-to-end confirmation, including the union/map-order
   behavior.** The Node-level facts this design leans on (repeated `-C` unions,
   and map-key order rather than flag order picking the target) are stated as
   *expected, not yet observed in this repo* and must be observed once in the
   implementation PR against the CI Node, together with the full chain in an
   actual AVA worker: that a pass-style test running under the new config
   observes *both* the Endo harness (proving `ses-ava:endo` survived) *and* the
   tagged-object reification (proving `pass-style-symbol` took) in one worker
   process. High confidence given the already-load-bearing `ses-ava:endo` path,
   but the brief's discipline is to observe it, not assume it.

7. **Vat/bundle deployment path.** A bundled vat opts into conditions at build
   time via `@endo/bundle-source`'s `conditions` option
   (`packages/bundle-source/src/main.js`), not via a runtime `-C` flag. Should
   this design thread `pass-style-symbol` through `bundle-source`'s
   `conditions` so a vat bundle can select the variant, and is a build-time
   condition the right granularity for the multi-vat threat the Motivation
   names? (See [open question 9](#open-questions) on granularity.)

8. **Value parameter as the long-term shape.** The [Alternative considered: a
   value parameter instead of a process
   condition](#alternative-considered-a-value-parameter-instead-of-a-process-condition)
   section records a value-oriented design (a `makePassStyleOf`/`makeMarshal`
   constructor option) that decouples the representation choice from module
   resolution. Should a follow-up migrate from the condition lever to a value
   parameter once the cross-package refactor of `passStyleOf`'s module-level
   singletons and marshal's free-binding imports is scoped?

9. **Process granularity vs. vat granularity.** The condition binds the
   representation to the OS process ("a process is wholly in one world or the
   other"), but the threat model's isolation unit is the vat/compartment. A
   kernel hosting several same-process vats cannot put only an untrusted vat's
   decode path behind the hardened representation while a trusted vat keeps
   default interop. Is process granularity acceptable for the migration lever,
   with vat granularity deferred to the value-parameter shape (open question
   8), or does the multi-vat case need vat granularity from the start?

## Prompt

This design was generated from a maintainer brief. The verbatim wording was not
preserved in a durable channel; the brief's substance, reconstructed from the
directive that commissioned the design and the two empirical disciplines it
imposed (both cited above as "the brief"), was:

> Design an alternate reified representation for passable symbols, gated behind
> a custom Node resolution condition (`pass-style-symbol`) and **not** the
> default, in which a passable symbol becomes a plain hardened object
> `{ [Symbol.for('passStyle')]: 'symbol', [Symbol.toStringTag]: name }` rather
> than a primitive JavaScript symbol. The motivation is a memory-exhaustion
> vector: `passableSymbolForName`'s `Symbol.for(name)` decode leaf interns every
> incoming name into the global symbol registry, which is unbounded,
> process-lifetime, un-GC'd, and unscoped by compartment or vat, so untrusted
> content that reaches a decode can grow a durable process-global table. Ground
> the threat model in the actual sources rather than asserting it. Deliver a
> design document only (no implementation) against the `llm` branch, in the
> repository's design-document conventions.
>
> Two disciplines the design must honor rather than assume:
> 1. Do **not** assume AVA forwards a `-C` condition flag through to the worker
>    process where module resolution happens; confirm the forwarding path
>    against the actual repo and the actual CI Node.
> 2. Make the security claim (decode no longer grows the registry) an
>    executable regression test, not a prose assertion.
