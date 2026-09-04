# Reified Passable Symbols behind a Node Condition (`pass-style-symbol`)

| | |
|---|---|
| **Created** | 2026-09-04 |
| **Updated** | 2026-09-04 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Draft — design only, no implementation in this change |

## Summary

Today a passable symbol *is* a primitive JavaScript `symbol`: a well-known
symbol (`Symbol.iterator` and friends, reified on the wire as `"@@" + name`)
or a `Symbol.for(name)` registered symbol. This design introduces an
**alternate reified representation** for passable symbols — a plain hardened
object

```js
{ [Symbol.for('passStyle')]: 'symbol', [Symbol.toStringTag]: symbolName }
```

— that carries *no* primitive `symbol` at all, eliminates well-known symbols
as a passable category, and never calls `Symbol.for` on incoming names. It is
**not** the default. It is selected per process by a custom Node
resolution condition, `pass-style-symbol`, activated with
`node -C pass-style-symbol` (equivalently `--conditions=pass-style-symbol`).
Absent that flag, resolution falls through to `"default"` and today's behavior
is unchanged, byte for byte.

The swap is deliberately narrow: a single package-private `imports` alias
inside `@endo/pass-style`, `#pass-style-symbol-impl`, resolves either to
today's `src/symbol.js` (`default`) or to a new sibling
`src/symbol-tagged.js` (`pass-style-symbol`). The two modules present the
*same* function surface (`isPassableSymbol` / `assertPassableSymbol` /
`nameForPassableSymbol` / `passableSymbolForName` / `unpassableSymbolForName`),
so everything downstream — `passStyleOf`, and all three marshal encoders —
swaps transitively without a line of its own changing.

## Motivation

### The threat model, sharpened

The brief asserts a memory-exhaustion vector; grounding it in the code
confirms and sharpens it.

`passableSymbolForName` (`packages/pass-style/src/symbol.js`) is the decode
leaf for *every* incoming passable symbol name, across all three wire codecs:

- smallcaps — `encodeToSmallcaps.js:363`, `return passableSymbolForName(encoding.slice(1))`
- capdata — `encodeToCapData.js:368`, `return passableSymbolForName(name)`
- `encodePassable` (ordered keys) — `encodePassable.js:777`, `return passableSymbolForName(name)`

Its terminal line is `return Symbol.for(name)`. `Symbol.for` interns into the
**global symbol registry**: a process-wide, string-keyed table with **no
eviction and no per-realm/per-compartment scoping**. Once `Symbol.for('x')`
runs, the entry for `'x'` lives for the lifetime of the process and is shared
by every compartment and vat in it. There is no API to remove an entry and it
is never garbage-collected — the registry deliberately keeps the symbol alive
so that a later `Symbol.for('x')` returns the *same* symbol.

So any path by which untrusted content chooses the string handed to
`passableSymbolForName` is a path by which untrusted content grows an
unbounded, permanent, process-global table. Decoding an inbound message that
carries `N` distinct never-before-seen registered-symbol names adds `N`
permanent registry entries. This is:

- **not compartment-scoped** — a confined guest that can cause a decode grows
  a table shared by the whole process, escaping its memory allotment;
- **not vat-scoped** — the same in an Agoric-style multi-vat process;
- **durable** — surviving GC, compartment disposal, and vat termination.

An attacker who can get a peer to decode attacker-chosen symbol names — e.g.
by sending messages, or by getting content reflected into a decode — has a
cheap, durable denial-of-service against total process memory. The cost to the
attacker is one string per entry on the wire; the cost to the victim is a
permanent registry slot per distinct name, forever.

Well-known symbols carry a smaller but related problem: they widen the passable
symbol category to a fixed set of engine-defined identities (`Symbol.iterator`,
`Symbol.asyncIterator`, …) whose membership is a moving target across
JavaScript versions, encoded through the reserved-`@@` "Hilbert Hotel" escape
in `symbol.js`. For OCapN alignment we want passable symbols to be *exactly*
"a name," nothing engine-defined and nothing that touches a global registry.

### Why a plain object closes it

The tagged-object representation carries the name in `Symbol.toStringTag` (an
ordinary string-valued own property) and never calls `Symbol.for` on decode.
`passableSymbolForName(name)` under the variant returns
`harden({ [PASS_STYLE]: 'symbol', [Symbol.toStringTag]: name })` — a fresh
object, immediately eligible for GC once unreferenced, touching no global
table. The unbounded-registry vector is closed at the leaf, for all three
codecs at once, because all three call the same swapped leaf.

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
   `HelperTable['symbol']` — the only thing missing is a helper registered
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
only two edits inside `passStyleOf.js` itself, and — critically — they are
**condition-independent** (see next section).

## What swaps as one unit

The unit swapped by the condition is exactly the `#pass-style-symbol-impl`
module. Everything else swaps transitively because it imports the function
surface from that alias rather than from `./symbol.js` directly.

### The two implementation modules

- **`src/symbol.js`** (unchanged; the `"default"` target). Primitive-symbol
  semantics exactly as today.

- **`src/symbol-tagged.js`** (new; the `"pass-style-symbol"` target). Same five
  exports, tagged-object semantics:
  - `passableSymbolForName(name)` → `harden({ [PASS_STYLE]: 'symbol',
    [Symbol.toStringTag]: name })`. No `Symbol.for`. No `@@` escape. `name`
    must be a well-formed string; names beginning `@@` are **rejected**
    (well-known symbols are not representable), which also removes the Hilbert
    Hotel escape entirely.
  - `nameForPassableSymbol(sym)` → accepts the tagged object, returns its
    `Symbol.toStringTag` string; returns `undefined` for anything else.
  - `isPassableSymbol` / `assertPassableSymbol` → true/pass **only** for the
    tagged object; a primitive `symbol` is **not** passable under the variant.
  - `unpassableSymbolForName(name)` → unchanged intent (a distinct
    non-passable marker); it may stay `Symbol(name)` or also become a
    non-registered tagged object — see [Open questions](#open-questions).
  - Additionally exports a `SymbolHelper` (a `PassStyleHelper` with
    `styleName: 'symbol'`, validating shape: frozen, own `[PASS_STYLE] ===
    'symbol'`, own string `[Symbol.toStringTag]`, no other own enumerable
    data). Under `default`, `symbol.js` exports a `SymbolHelper` too, but see
    below on whether it is *used*.

### The two consumers that change their import specifier

Only the *specifiers* change; the code does not.

- `packages/pass-style/index.js` currently re-exports the five functions
  `from './src/symbol.js'`. Change that to `from '#pass-style-symbol-impl'`.
  Because marshal's encoders import `nameForPassableSymbol` /
  `passableSymbolForName` from `@endo/pass-style` (the public entry), this one
  edit swaps the entire marshal encode/decode chain — `encodeToSmallcaps.js`,
  `encodeToCapData.js`, `encodePassable.js` — with **no change to marshal at
  all**. The wire format is *invariant*: on the wire a symbol is still its
  name string; only the in-memory value that name reifies to changes. A
  `default` sender and a `pass-style-symbol` receiver therefore interoperate
  on the wire — they disagree only about the *local* JS value a name denotes,
  which is exactly the intended semantic difference and never a silent
  corruption (see [Cross-variant interop](#cross-variant-interop)).

- `packages/pass-style/src/passStyleOf.js` currently imports
  `assertPassableSymbol` `from './symbol.js'`. Change that to
  `from '#pass-style-symbol-impl'`. This makes the primitive `case 'symbol':`
  arm swap for free: under `default`, `assertPassableSymbol` accepts primitive
  passable symbols (today's behavior); under the variant, it throws, so
  primitive symbols are not passable and the `Symbol.for`-registry classify
  path is closed on this side too.

### The `HelperTable['symbol']` decision — register unconditionally

Recommendation: **register the `symbol` style unconditionally.** Add
`symbol: undefined` to the `makeHelperTable` seed and add `SymbolHelper` to the
`makePassStyleOf([...])` list *in both branches*, sourced from
`#pass-style-symbol-impl`. Rationale:

- It keeps `passStyleOf.js` a single code path with no condition-branching of
  its own — less risk, one thing to reason about.
- It is **harmless under `default`**: nothing in a `default` process ever
  *produces* the tagged-object shape (the default `passableSymbolForName`
  returns primitives), so `HelperTable['symbol']` is simply never reached by
  the object dispatcher. The primitive `case 'symbol':` continues to handle
  real symbols.
- It makes the representation *recognized* rather than *rejected* if a
  tagged-object symbol is ever constructed in a `default` process (e.g. a test
  fixture, or a value hand-built by a tool). Without the entry, such an object
  hits `Fail\`Unrecognized PassStyle: 'symbol'\``; with it, it classifies as a
  symbol. Recognizing-not-rejecting is the safer default and costs nothing.

The alternative — making `HelperTable` itself part of the swap so `'symbol'`
exists *only* under the variant — is viable but buys nothing and adds a second
conditional surface. It is recorded as an open question only to the extent the
maintainers prefer the stricter "the shape is meaningless unless armed"
stance.

Note the two `'symbol'`-producing paths **coexist by construction and never
collide**: within a single process the condition is fixed, so at most one of
`{ primitive path produces passable symbols, tagged path produces passable
symbols }` is *active* — under `default` only primitives are passable and the
tagged path is dormant-but-present; under the variant only tagged objects are
passable and the primitive `case 'symbol':` throws. They are not two live
producers racing; they are one live producer and one inert-but-registered
fallback.

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
`"default"` matches → `./src/symbol.js`, today's behavior. With
`node -C pass-style-symbol`, the `"pass-style-symbol"` key matches first →
`./src/symbol-tagged.js`.

### The load-bearing caveat: resolution is per-process, once, at startup

Node resolves conditional `imports`/`exports` **once per process, for the
whole module graph, at load time** — it is not a per-call, per-package, or
per-import runtime toggle. There is no supported way to load *both* branches in
one process, and no way to flip mid-run. Consequences that must be designed
around, not glossed:

- Turning the condition on affects **every** consumer transitively loaded in
  that process — not just `@endo/pass-style`'s own tests, but any package
  whose test process imports pass-style symbols indirectly (marshal, ocapn,
  and anything downstream). A process is wholly in one world or the other.
- Therefore "test both branches" means **two processes**, never one. You
  cannot assert default and variant behavior in the same test file.
- A mixed deployment (some peers default, some variant) is a *wire*
  interoperation question, answered in [Cross-variant interop](#cross-variant-interop),
  not an in-process one.

## Test and CI strategy — and the empirical check the brief demanded

The brief insists we not *assume* that Ava forwards a `-C` flag to whatever
process ultimately resolves the conditional import, but confirm it. **It is
already confirmed, in this very repo**, by a mechanism the pass-style suite
depends on today:

- Every endo Ava config sets `nodeArguments: ['-C', 'ses-ava:endo']`
  (`ava-endo-lockdown.config.mjs` and siblings). Ava applies `nodeArguments`
  to the Node worker processes it spawns to run test files.
- `@endo/ses-ava`'s `package.json` `exports` for `./test.js` has a
  `"ses-ava:endo"` conditional branch resolving to `./prepare-endo.js`. That
  branch is selected **only** because the `-C ses-ava:endo` in `nodeArguments`
  reaches the worker where module resolution happens.
- The pass-style test suite imports `@endo/ses-ava/test.js` and gets the endo
  prepared harness today — which is only possible if the condition reached the
  worker. So the forwarding path (`ava nodeArguments` → worker `execArgv` →
  conditional resolution) is a **load-bearing, already-exercised** fact, not an
  assumption.

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

   (Both `-C` flags are passed; `ses-ava:endo` is still needed for the harness.
   Node **unions** repeated `-C`/`--conditions` — confirmed empirically: with
   `node -C a -C b` against an `imports` map listing both `a` and `b`, *both*
   conditions are active. Which *target* a given alias resolves to is decided
   by **the order of keys in the `imports` map, first match wins — not the
   order of the flags**. `ses-ava:endo` and `pass-style-symbol` sit on
   *different* aliases (`@endo/ses-ava`'s `exports` vs. pass-style's `imports`),
   so they never compete; each resolves independently.)

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
     assertions that a passable symbol is a primitive `symbol` would **fail** —
     so they must be gated. Gate on a tiny runtime probe rather than trying to
     read the condition (Node exposes no "is condition X active" API):
     `passStyleOf` of a known-passable value, or simpler, feature-detect by the
     *shape* `passableSymbolForName('x')` returns (`typeof === 'symbol'` →
     default; object with `[PASS_STYLE] === 'symbol'` → variant). Branch the
     assertions on that probe, or split into `symbol.test.js` (runs default
     config only) and `symbol-tagged.test.js` (runs variant config only) via
     Ava's per-config `files` globs.
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
   // Symbol.for(sameName) still returns a *fresh-to-the-registry* entry —
   // i.e. decode did not pre-intern it.
   ```

   Contrast with the default world, where decoding those names *does* intern
   them (`Symbol.keyFor(decoded) === name`). The two tests together are the
   worked proof of the threat model and its fix.

5. **CI** runs the whole matrix by virtue of `ses-ava` iterating all
   `sesAvaConfigs`. No CI YAML change is required beyond ensuring pass-style's
   `test` script stays `ses-ava` (it does). Optionally add an explicit
   `test:pass-style-symbol` job for signal isolation, but it is redundant with
   the default `test`.

## The Ava/`t.deepEqual` advantage — with a worked example

Because the reified value is a plain object, Ava's `t.deepEqual` structurally
compares two instances by their own properties — `[Symbol.toStringTag]` and
`[PASS_STYLE]` — which is exactly pass-by-copy identity ("same name ⇒ same
symbol"). Primitive symbols cannot do this: two independently produced symbols
are `===`-unequal unless they happen to share a registry entry, and
`t.deepEqual` on primitive symbols compares them by identity, so a genuine
pass-by-copy equivalence reads as *unequal*.

Worked example (variant world):

```js
import { passableSymbolForName } from '@endo/pass-style';

// Two independently decoded "foo" selectors from two different messages:
const a = passableSymbolForName('foo');
const b = passableSymbolForName('foo');

// Variant: fresh objects each time, but structurally identical.
t.not(a, b);            // not === (fresh objects) — as with fresh symbols
t.deepEqual(a, b);      // ✅ structurally equal by [toStringTag]/[PASS_STYLE]
t.deepEqual(a, {
  [Symbol.for('passStyle')]: 'symbol',
  [Symbol.toStringTag]: 'foo',
});                     // ✅ the reified shape is inspectable and assertable
```

Contrast default world, where `passableSymbolForName('foo')` is
`Symbol.for('foo')`: there `a === b` (registry-interned), but a *non-registered*
conceptual duplicate — `Symbol('foo')` — is neither `===` nor `t.deepEqual` to
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
world-agnostic as part of arming the variant** — i.e. validate "is this a
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
(`src/symbol.js`) — so ordinary `yarn lint:types`, `.d.ts` emit, and eslint
only ever *see and typecheck the default branch*. The variant module
(`src/symbol-tagged.js`) would then **silently bit-rot**: never typechecked,
its `.d.ts` never generated, type errors invisible until someone runs it.

TypeScript's answer is the `customConditions` compiler option (supported under
`node16`/`nodenext` resolution, TS ≥ 5.0, so fine at 6.0.3). Provide a second
tsconfig that types the variant branch:

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
  `index.js` and `passStyleOf.js` — which import through the alias and are
  typed under *one* branch at a time — typecheck against whichever module the
  active `customConditions` selects. The cleanest discipline: a shared
  `symbol-impl.d.ts` (or a JSDoc `@typedef` in a shared types module) that
  both modules `@satisfies`/annotate against, so the surface can't drift.
- `.d.ts` **emit** for the package's public API (`index.js` re-exports) must
  be decided: the published types describe *one* branch. Since the variant is
  not the default and not published-as-default, the published `.d.ts` should
  describe the **default** (primitive `symbol`) surface; the variant tsconfig
  is a *check-only* pass (`--noEmit` or a separate outDir), not the source of
  published types. Record this so a consumer's types match the default they'll
  actually resolve unless they too opt in.
- eslint: `import/*` resolvers must understand the `#`-alias. eslint runs under
  default conditions and will resolve `#pass-style-symbol-impl` to
  `src/symbol.js`; `src/symbol-tagged.js` is still linted as an ordinary file
  because it matches the `include`/lint globs directly (it is a real file on
  disk), so lint coverage of the variant module does not depend on condition
  resolution — only its *type* coverage does, which the second tsconfig
  supplies.

## Cross-variant interop

Because the wire format is invariant (a symbol is its name string on the
wire, in all three codecs), a `default` peer and a `pass-style-symbol` peer
**interoperate at the byte level**. They disagree only about the local JS
value a decoded name denotes: the default peer reifies `Symbol.for(name)` (or
a well-known symbol); the variant peer reifies the tagged object (and refuses
`@@` well-known names). This is a *semantic* divergence, chosen deliberately,
not a silent corruption:

- default → variant: a message carrying `@@iterator` (a well-known symbol name)
  decodes on the variant peer as a **rejected** name (variant refuses `@@`),
  surfacing as a decode error, not a wrong value. A registered-symbol name
  decodes to the tagged object — the intended representation.
- variant → default: the variant peer only ever *emits* names it can
  represent (no `@@`), so the default peer decodes them via `Symbol.for` — and
  thereby re-introduces the registry-growth exposure **on the default peer**.
  The variant protects the *variant* peer's process; it does not retroactively
  protect a default peer it talks to. That is inherent to "not the default"
  and is the reason the condition exists as a migration lever, not a wire
  change.

The design does **not** attempt a wire discriminator between the two — the
whole point is that the name string is the wire contract and only the local
reification changes. If the maintainers later want the *wire* to forbid
well-known/`@@` names universally (so a default decoder also refuses them),
that is a separate wire-format change, noted as an open question.

## Rollout

1. Land this design (PR against `llm`).
2. Implement `src/symbol-tagged.js` + `SymbolHelper`, the `imports` alias, the
   two specifier edits, the shared type surface, the second Ava config +
   `sesAvaConfigs` entry + world-aware tests (incl. the registry-growth
   regression and the `t.deepEqual` proof), and the second tsconfig for type
   coverage. Default behavior byte-identical.
3. Make `@endo/ocapn`'s `selector.js` world-agnostic (replace `typeof ===
   'symbol'` guards with passable-symbol predicates) and add its own variant
   test config, so selectors travel with the condition.
4. Only later, and separately, consider whether any consumer should make
   `pass-style-symbol` its *default* — a decision with wire-interop
   consequences (above), explicitly out of scope here.

## Open questions

1. **`HelperTable['symbol']`: unconditional vs. swapped.** This design
   recommends registering the `symbol` style unconditionally (harmless under
   default, keeps `passStyleOf` single-path). Do the maintainers prefer the
   stricter stance where `'symbol'` is unrecognized unless the variant is
   armed? The trade is "recognize-not-reject a stray tagged object" vs. "the
   shape is meaningless unless armed."

2. **`unpassableSymbolForName` under the variant.** Should it remain
   `Symbol(name)` (a primitive, non-registered marker) or also become a
   non-passable tagged object? It is the "definitely not passable" escape
   hatch; keeping it a primitive is simplest, but a process that has otherwise
   abolished passable primitive symbols may want no primitive symbols in play
   at all.

3. **Well-known names on the wire.** Should the *wire* contract forbid
   `@@`-prefixed (well-known) names universally, so that even a `default`
   decoder refuses them — closing the well-known category everywhere rather
   than only in the variant's local reification? That is a wire-format change
   beyond this per-process reification swap.

4. **OCapN selector representation depth.** Beyond making `selector.js`'s
   `typeof` guards world-agnostic, does OCapN's own selector table / equality
   anywhere rely on primitive-symbol identity (`===`, `Symbol.keyFor`) in a way
   the tagged object breaks? A survey of `@endo/ocapn` selector *consumers*
   (not just `selector.js`) is needed before selectors can be declared safe
   under the variant.

5. **Published `.d.ts` branch.** Confirm the published types should describe
   the default (primitive) surface, with the variant tsconfig as a check-only
   pass. If any downstream package intends to *ship* under the variant, its
   own published types diverge and that needs its own decision.

6. **Ava-worker end-to-end confirmation.** The Node-level facts are settled
   (repeated `-C` unions; map-key order, not flag order, picks the target —
   both confirmed empirically on Node 22). The one remaining check is the full
   chain in an actual Ava worker: that a pass-style test running under the new
   config observes *both* the endo harness (proving `ses-ava:endo` survived)
   *and* the tagged-object reification (proving `pass-style-symbol` took) in one
   worker process. High confidence given the already-load-bearing `ses-ava:endo`
   path, but the brief's discipline is to observe it once, in the implementation
   PR, not assume it.
