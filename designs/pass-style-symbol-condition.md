# Reified Passable Symbols behind a Node Condition (`pass-style-symbol`)

| | |
|---|---|
| **Created** | 2026-09-04 |
| **Updated** | 2026-09-04 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Draft. Design only, no implementation in this change. |

## Summary

Today a passable symbol *is* a primitive JavaScript `symbol`: a well-known
symbol (`Symbol.iterator` and friends, reified on the wire as `"@@" + name`)
or a `Symbol.for(name)` registered symbol. This design introduces an
**alternate reified representation** for passable symbols, a plain hardened
object

```js
{ [Symbol.for('passStyle')]: 'symbol', [Symbol.toStringTag]: symbolName }
```

that carries *no* primitive `symbol` at all, eliminates well-known symbols
as a passable category, and never calls `Symbol.for` on incoming names. (The
object is *keyed* by two primitive symbols, `Symbol.for('passStyle')` and
`Symbol.toStringTag`, which are the existing pass-by-copy tagging convention;
the passed *value* it stands in for contains no primitive symbol. That
convention is what [The existing dispatch mechanism this rides
on](#the-existing-dispatch-mechanism-this-rides-on) explains, so the apparent
contradiction is resolved there.) The name is carried in `Symbol.toStringTag`
specifically, rather than a plain string property like `name`, because that
lets Ava's `t.deepEqual` treat two reifications of the same name as
structurally equal (see [The Ava/`t.deepEqual`
advantage](#the-avatdeepequal-advantage-with-a-worked-example)).

This representation is **not** the default. It is selected per process by a
custom Node resolution condition, `pass-style-symbol`, activated with
`node -C pass-style-symbol` (equivalently `--conditions=pass-style-symbol`).
Absent that flag, resolution falls through to `"default"` and today's behavior
is unchanged, byte for byte.

The swap is deliberately narrow: a single package-private `imports` alias
inside `@endo/pass-style`, `#pass-style-symbol-impl`, resolves either to
today's `src/symbol.js` (`default`) or to a new sibling
`src/symbol-tagged.js` (`pass-style-symbol`). The two modules present the
*same* function surface (`isPassableSymbol` / `assertPassableSymbol` /
`nameForPassableSymbol` / `passableSymbolForName` / `unpassableSymbolForName`),
so any downstream code that reaches passable symbols *through that surface*
(`passStyleOf`, and all three marshal encoders) swaps transitively with no line
of its own changing. The transitivity has one important limit: code that
inspects a passable symbol with a bare `typeof === 'symbol'` guard rather than
through `isPassableSymbol`/`nameForPassableSymbol` does **not** swap for free
and breaks under the variant (the reified value is now an object). This design
surfaces one such site (`@endo/ocapn`'s `selector.js`, see [OCapN
selectors](#ocapn-selectors-endoocapn)) but has not audited the whole tree for
other `typeof === 'symbol'` guards; every such guard is a latent break the
implementation must find and make world-agnostic.

## Motivation

### The threat model, sharpened

The brief asserts a memory-exhaustion vector; grounding it in the code
confirms and sharpens it.

`passableSymbolForName` (`packages/pass-style/src/symbol.js`) is the decode
leaf for *every* incoming passable symbol name, across all three wire codecs:

- smallcaps: `encodeToSmallcaps.js:363`, `return passableSymbolForName(encoding.slice(1))`
- capdata: `encodeToCapData.js:368`, `return passableSymbolForName(name)`
- `encodePassable` (ordered keys): `encodePassable.js:777`, `return passableSymbolForName(name)`

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
a Node condition) and its *test-harness* rollout (Ava `nodeArguments`, see
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

### Why a plain object closes it

The tagged-object representation carries the name in `Symbol.toStringTag` (an
ordinary string-valued own property) and never calls `Symbol.for` on decode.
`passableSymbolForName(name)` under the variant returns
`harden({ [PASS_STYLE]: 'symbol', [Symbol.toStringTag]: name })`: a fresh
object, immediately eligible for GC once unreferenced, touching no global
table. The unbounded-registry vector is closed at the leaf, for all three
codecs at once, because all three call the same swapped leaf. (This closes the
vector *at this leaf*; whether an equivalent intern table lives elsewhere in
OCapN is the subject of [open question 4](#open-questions), so "closed"
here means "closed at the pass-style decode leaf," not proven closed across
every downstream selector consumer.)

Well-known symbols disappear as a category: under the variant,
`assertPassableSymbol` rejects primitive symbols outright (see
[Swap unit](#what-swaps-as-one-unit)), so `Symbol.iterator` is simply not
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
  - `nameForPassableSymbol(sym)` accepts the tagged object, returns its
    `Symbol.toStringTag` string, and returns `undefined` for anything else.
  - `isPassableSymbol` / `assertPassableSymbol` are true/pass **only** for the
    tagged object; a primitive `symbol` is **not** passable under the variant.
  - `unpassableSymbolForName(name)` keeps its intent (a distinct
    non-passable marker); it may stay `Symbol(name)` or also become a
    non-registered tagged object (see [Open questions](#open-questions)).
  - Additionally exports a `SymbolHelper` (a `PassStyleHelper` with
    `styleName: 'symbol'`, validating shape: frozen, own `[PASS_STYLE] ===
    'symbol'`, own string `[Symbol.toStringTag]`, no other own enumerable
    data).

### The two consumers that change their import specifier

Only the *specifiers* change; the code does not.

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

### The `HelperTable['symbol']` decision: register unconditionally

Recommendation: **register the `symbol` style unconditionally.** Add
`symbol: undefined` to the `makeHelperTable` seed and add `SymbolHelper` to the
`makePassStyleOf([...])` list *in both branches*, sourced from
`#pass-style-symbol-impl`. Because `passStyleOf.js` sources `SymbolHelper`
through that alias, and under `default` the alias resolves to `src/symbol.js`,
**`src/symbol.js` must also export a `SymbolHelper`** (this is the one new
export noted in [The two implementation modules](#the-two-implementation-modules)).
Both modules therefore export a structurally-identical validator for the
tagged shape; only the five *behavioral* functions differ between them.
Rationale:

- It keeps `passStyleOf.js` a single code path with no condition-branching of
  its own: less risk, one thing to reason about.
- It is **harmless under `default`** in the common case: nothing in a
  `default` process ever *produces* the tagged-object shape (the default
  `passableSymbolForName` returns primitives), so `HelperTable['symbol']` is
  simply never reached by the object dispatcher. The primitive `case 'symbol':`
  continues to handle real symbols.
- It makes the representation *recognized* rather than *rejected* if a
  tagged-object symbol is ever constructed in a `default` process (for example
  a test fixture, or a value hand-built by a tool). Without the entry, such an
  object hits `Fail\`Unrecognized PassStyle: 'symbol'\``; with it, it
  classifies as `passStyleOf(val) === 'symbol'`.

That last point has a concrete asymmetry the maintainers should weigh, and it
is *not* free. `SymbolHelper`'s validation is purely structural (frozen, own
`[PASS_STYLE] === 'symbol'`, own string `[Symbol.toStringTag]`); it does not
consult whether the active world's `nameForPassableSymbol` can turn the value
back into a wire name. So under `default`, a hand-built tagged object would
classify as `passStyleOf(val) === 'symbol'` (a green light that the value is
Passable), yet `default`'s `nameForPassableSymbol` returns `undefined` for it,
so the marshal encoders that consume that function (see [The two
consumers](#the-two-consumers-that-change-their-import-specifier)) would fail to
encode a value `passStyleOf` just certified as valid. Registering
unconditionally therefore trades a clean `Unrecognized PassStyle` at
classification time for a later "classified-but-unencodable" state: worse for
consumers that lean on `passStyleOf`/`assertPassable` as a *complete* predicate
(CopyMap/CopySet key admission, `sameStructure`, remote-argument gating)
without ever calling encode. The choice is genuine and is [open question
1](#open-questions). If the maintainers keep unconditional registration and
want to avoid the divergence, `SymbolHelper`'s validator can additionally probe
`nameForPassableSymbol(val) !== undefined` under the active world, so
`passStyleOf` acceptance and marshal encodability cannot diverge.

The alternative, making `HelperTable` itself part of the swap so `'symbol'`
exists *only* under the variant, is viable but adds a second conditional
surface. It is recorded as an open question to the extent the maintainers
prefer the stricter "the shape is meaningless unless armed" stance, which also
sidesteps the classified-but-unencodable asymmetry above.

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

The brief insists we not *assume* that Ava forwards a `-C` flag to whatever
process ultimately resolves the conditional import, but confirm it. **The
forwarding path is already load-bearing in this very repo**, by a mechanism the
pass-style suite depends on today:

- Every endo Ava config sets `nodeArguments: ['-C', 'ses-ava:endo']`
  (`ava-endo-lockdown.config.mjs` and siblings). Ava applies `nodeArguments`
  to the Node worker processes it spawns to run test files.
- `@endo/ses-ava`'s `package.json` `exports` for `./test.js` has a
  `"ses-ava:endo"` conditional branch resolving to `./prepare-endo.js`. That
  branch is selected **only** because the `-C ses-ava:endo` in `nodeArguments`
  reaches the worker where module resolution happens.
- The pass-style test suite imports `@endo/ses-ava/test.js` and gets the endo
  prepared harness today, which is only possible if the condition reached the
  worker. So the forwarding path (`ava nodeArguments`, then worker `execArgv`,
  then conditional resolution) is a **load-bearing, already-exercised** fact,
  not an assumption.

This also tells us *where* to inject `pass-style-symbol`: through an Ava
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

3. **The test files must be world-aware.** Because a given worker is wholly in
   one world, a shared test file cannot assert "primitive under default AND
   tagged under variant" in one run. The clean split:
   - Keep the existing symbol tests asserting **default** (primitive) behavior;
     they run under the default configs and, under the variant config, the
     assertions that a passable symbol is a primitive `symbol` would **fail**,
     so they must be gated. Gate on a tiny runtime probe rather than trying to
     read the condition (Node exposes no "is condition X active" API): probe by
     the *shape* `passableSymbolForName('x')` returns (`typeof === 'symbol'`
     means default; object with `[PASS_STYLE] === 'symbol'` means variant).
     Branch the assertions on that probe, or split into `symbol.test.js` (runs
     default config only) and `symbol-tagged.test.js` (runs variant config
     only) via Ava's per-config `files` globs.
   - Add variant-only tests asserting: `passableSymbolForName` returns the
     tagged object; it never grows the registry (see the registry-growth
     regression test below); primitive symbols are **not** passable;
     `passStyleOf(tagged) === 'symbol'`; and a full marshal round-trip
     (`toCapData`/`fromCapData`, smallcaps, `encodePassable`) reifies to the
     tagged object.

4. **A registry-growth regression test** (variant world) makes the security
   claim executable rather than asserted:

   ```js
   const before = Symbol.for(freshName); // interns once
   // decode many distinct fresh names via passableSymbolForName / fromCapData
   // assert none of them are found by Symbol.keyFor on the decoded values
   // (decoded values are objects, keyFor(object) throws/undefined), and that
   // Symbol.for(sameName) still returns a *fresh-to-the-registry* entry,
   // i.e. decode did not pre-intern it.
   ```

   Contrast with the default world, where decoding those names *does* intern
   them (`Symbol.keyFor(decoded) === name`). The two tests together are the
   worked proof of the threat model and its fix.

5. **Cross-variant interop tests** (the two claims [Cross-variant
   interop](#cross-variant-interop) makes are testable in-process today, with
   literal wire payloads, no live two-peer setup):
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

6. **CI** runs the whole matrix by virtue of `ses-ava` iterating all
   `sesAvaConfigs`. No CI YAML change is required beyond ensuring pass-style's
   `test` script stays `ses-ava` (it does). Optionally add an explicit
   `test:pass-style-symbol` job for signal isolation, but it is redundant with
   the default `test`.

## The Ava/`t.deepEqual` advantage, with a worked example

This section is an *ergonomics* property of the tagged representation, distinct
from the security motivation above; it is a reason the variant is nicer to
assert on, not itself a reason the DoS closes. Because the reified value is a
plain object, Ava's `t.deepEqual` structurally compares two instances by their
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
makes "same conceptual symbol" a *structural* fact Ava can see. This should be
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

Recommendation: **bring OCapN selectors under the same condition, but treat
`selector.js`'s `typeof === 'symbol'` guards as code that must be made
world-agnostic as part of arming the variant.** That is, validate "is this a
passable symbol" via `isPassableSymbol` / `nameForPassableSymbol` returning a
string, not via `typeof === 'symbol'`. Since OCapN alignment is a *stated
motivation* for this whole effort, leaving selectors on primitive symbols
while pass-style moves would be self-defeating. However, the concrete edits to
`selector.js` are **implementation**, out of scope for this design; this
document's job is to flag that selectors are on the path and that their
`typeof` guards are the specific breakage. Whether OCapN's own wire/table
representation needs any further change is an open question below.

## Typecheck, `.d.ts`, and eslint under the non-default condition

`moduleResolution` is `NodeNext` (root `tsconfig.eslint-base.json`) and
TypeScript is `~6.0.3`. NodeNext TypeScript **does** resolve package `imports`
maps, and it picks the branch according to its own condition set. By default
`tsc` resolves `#pass-style-symbol-impl` to the `"default"` target
(`src/symbol.js`), so ordinary `yarn lint:types`, `.d.ts` emit, and eslint
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
  the source of published types. This means a consumer who opts into the
  variant via `-C pass-style-symbol` would, without further action, get IDE/tsc
  types saying `symbol` while the runtime value at that call site is an object:
  types that actively vouch for the wrong shape to exactly the segment that
  opted in. The design resolves this with a concrete mechanism rather than a
  "record it" deferral: variant consumers **must set `customConditions:
  ["pass-style-symbol"]` in their own tsconfig**, exactly as this package's
  variant tsconfig does, so that NodeNext resolution picks the variant branch's
  types for them too. This works because `@endo/pass-style` ships *both* module
  sources (`src/symbol.js` and `src/symbol-tagged.js` are real files in the
  published package) and the package-private `imports` alias resolves under the
  consumer's condition set. The implementation should document this
  `customConditions` requirement in the package README's opt-in section, so the
  opt-in is "set the `-C` runtime flag *and* the `customConditions` tsconfig
  option," not the runtime flag alone. (A future refinement could publish a
  variant-gated public `.d.ts` via `exports` `types` conditions; that is
  additive and recorded as part of [open question 5](#open-questions).)
- eslint: `import/*` resolvers must understand the `#`-alias. eslint runs under
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
   shared type surface, the second Ava config + `sesAvaConfigs` entry +
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
   the `symbol` style unconditionally (harmless in the common case under
   default, keeps `passStyleOf` single-path), but unconditional registration
   means a hand-built tagged object classifies as `passStyleOf === 'symbol'`
   under default while `nameForPassableSymbol` returns `undefined` for it, so
   an encoder that trusts the classification fails later rather than at
   classification time (see [the decision
   section](#the-helpertablesymbol-decision-register-unconditionally)). Do the
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

5. **Published `.d.ts` branch and a variant-gated public type export.** This
   design has variant consumers set `customConditions` in their own tsconfig to
   get variant types (see [Typecheck](#typecheck-dts-and-eslint-under-the-non-default-condition)).
   Confirm that is the intended contract, and decide whether to additionally
   publish a variant-gated public `.d.ts` through `exports` `types` conditions
   so consumers need not touch `customConditions` at all. If any downstream
   package intends to *ship* under the variant, its own published types diverge
   and that needs its own decision.

6. **Ava-worker end-to-end confirmation, including the union/map-order
   behavior.** The Node-level facts this design leans on (repeated `-C` unions,
   and map-key order rather than flag order picking the target) are stated as
   *expected, not yet observed in this repo* and must be observed once in the
   implementation PR against the CI Node, together with the full chain in an
   actual Ava worker: that a pass-style test running under the new config
   observes *both* the endo harness (proving `ses-ava:endo` survived) *and* the
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

8. **Value parameter as the long-term shape.** The [alternative
   considered](#alternative-considered-a-value-parameter-instead-of-a-process-condition)
   section records a value-oriented design (a `makePassStyleOf`/`makeMarshal`
   constructor option) that decouples the representation choice from module
   resolution. Should a follow-up migrate from the condition lever to a value
   parameter once the cross-package refactor of `passStyleOf`'s module-level
   singletons and marshal's free-binding imports is scoped?

9. **Process granularity vs vat granularity.** The condition binds the
   representation to the OS process ("a process is wholly in one world or the
   other"), but the threat model's isolation unit is the vat/compartment. A
   kernel hosting several same-process vats cannot put only an untrusted vat's
   decode path behind the hardened representation while a trusted vat keeps
   default interop. Is process granularity acceptable for the migration lever,
   with vat granularity deferred to the value-parameter shape (open question
   8), or does the multi-vat case need vat granularity from the start?
