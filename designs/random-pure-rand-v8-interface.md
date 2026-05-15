# `@endo/random-fast-check` Package and `pure-rand` v8 `RandomGenerator` Interface

| | |
|---|---|
| **Created** | 2026-05-06 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |

## What is the Problem Being Solved?

PR #75 (`feat(random,chacha12): factor @endo/random from
@endo/chacha12`) originally shipped a `@endo/random/fast-check.js`
module whose `adaptToPureRandomGenerator` and `makeRandomTypeFromSeed`
produce a `pure-rand` **v5** / v6 / v7 -shaped `RandomGenerator`.
That is the shape `fast-check@^3` consumes; `yarn.lock` resolves
`fast-check@^3` to `3.1.1` via `@fast-check/ava@^1.1.5` and
`pure-rand@^5` to `5.0.1` as the consequent transitive pin. PR #75
in its current form also lands a `@endo/chacha12-fast-check-test`
workspace that depends directly on `fast-check@^4`, so `yarn.lock`
now additionally resolves `fast-check@^4` to `4.7.0` and `pure-rand@^8`
to `8.4.0`. The v8 shape is therefore already present in the lockfile,
which is one reason this PR can scaffold a v8 adapter today without
adding a new direct dependency.

A subsequent maintainer direction on PR #75 (comment id
4393030139, 2026-05-06):

> Please remove the fast-check adapter from this change and add it to
> the scope of #107, where it will have its own package or packages,
> assuming we use it in conjunction with fast-check in this project.

This PR therefore (a) introduces the new sibling package
**`@endo/random-fast-check`** containing both the v5 and the v8
adapters, and (b) defines the v8 interface scaffold for that
package.
PR #75 in its current form no longer ships a `fast-check.js` subpath
at all; `@endo/random` stays focused on source-agnostic sampling.
PR #75 also reshaped `@endo/chacha12` so that `makeChaCha12(seed)`
returns a `ChaCha12Generator` record `{ next, getState, clone,
fillRandomBytes }` rather than a bare `RandomSource`; the
`fillRandomBytes` method is the `(out: Uint8Array) => void` entry
point this package consumes wherever it needs a `RandomSource`.

`fast-check@^4`, however, depends on `pure-rand@^8.0.0`, and v8 made
breaking changes to the `RandomGenerator` interface.
A maintainer note on PR #75 (review id 4232654800, `random.types.d.ts:36`)
flagged that the in-PR adapter was still pinned to the v5 shape.
The PR comment-thread deferred the v8 question to a follow-up so the
PR could land on its existing scope.
This design is that follow-up.
The maintainer's direction (PR #75 comment id 4385614416, 2026-05-06):

> Please design and implement a follow-up PR to address the pure-rand
> v8 interface.
> I would like to see that before deciding whether to fold that into
> this change.

The substance the maintainer needs is small: name the shape change,
say what we propose to do about it, and demonstrate enough code to
prove the proposal is workable.

## The Two Interfaces

### `pure-rand` v5/v6/v7 (current PR #75 target)

```ts
export interface RandomGenerator {
  clone(): RandomGenerator;
  next(): [number, RandomGenerator];
  jump?(): RandomGenerator;
  unsafeNext(): number;
  unsafeJump?(): void;
  getState(): readonly number[];
}
```

`next()` is pure: it returns the value plus a new generator that holds
the post-step state.
`unsafeNext()` mutates and returns just the value.
`clone()` may return an alias when the underlying state is not
snapshot-friendly (which is what PR #75 does for serial keystreams).

### `pure-rand` v8

```ts
export interface RandomGenerator {
  clone(): RandomGenerator;
  next(): number;
  getState(): readonly number[];
}

export interface JumpableRandomGenerator extends RandomGenerator {
  clone(): JumpableRandomGenerator;
  jump(): void;
}
```

The breaking changes that affect `@endo/random`:

1. `next(): number` (was `[number, RandomGenerator]`).
   The tuple form is gone.
   `unsafeNext` collapsed into `next`; mutation is now the only model.
2. `clone()` is documented as "produce a fully independent clone";
   the v5 alias-returning behavior no longer satisfies the contract.
3. `getState(): readonly number[]` is mandatory rather than optional.
4. `min()` and `max()` were removed; values are unconditionally in
   `[-0x80000000, 0x7fffffff]`.
5. `jump` / `unsafeJump` moved to the separate `JumpableRandomGenerator`
   interface.
6. The package exports only subpath imports; barrel imports are gone
   (`pure-rand/generator/xoroshiro128plus`, etc.).

`fast-check@4`'s `randomType` parameter still accepts
`(seed: number) => RandomGenerator`; the documented contract remains
"values between `-0x80000000` and `0x7fffffff`", so the seed-builder
shape on the `fast-check` side is stable across the v3 -> v4 jump.
What changes is the `RandomGenerator` we hand back.

## Proposal

### Package extraction

The maintainer's direction on PR #75 (comment id 4393030139) moves
the adapter out of `@endo/random` entirely.
This PR introduces a new sibling package
**`@endo/random-fast-check`** (`packages/random-fast-check/`).
PR #75 drops `packages/random/fast-check.js`, the `@fast-check/ava`
devDep, and the `./fast-check.js` subpath export. PR #75's own
reshape also moved `@endo/random`'s types file from
`packages/random/random.types.d.ts` to `packages/random/types.d.ts`
and renamed the `read-uint.js` subpath to `uint.js`; the
`PureRandomGenerator` typedef that previously rode in the types file
relocates to this package's own
`packages/random-fast-check/random-fast-check.types.d.ts` (see
*Type definitions* below) rather than tracking the rename.

The new package takes:

- `adaptToPureRandomGenerator`,
  `adaptFromPureRandomGenerator`, and `makeRandomTypeFromSeed`
  (the v5 / v6 / v7 surface that previously lived in
  `@endo/random/fast-check.js`).
- `adaptToPureRandomGeneratorV8`,
  `adaptFromPureRandomGeneratorV8`, and
  `makeRandomTypeFromSeedV8` (the v8 surface this design adds).
- The `PureRandomGenerator` and `PureRandomGeneratorV8` interfaces
  in `packages/random-fast-check/random-fast-check.types.d.ts`.

Runtime dependencies are `@endo/harden` (for hardening the returned
generators and adapters) and `@endo/random` (for `randomUint32`,
imported from the `@endo/random/uint.js` subpath; this is the
byte-pumping primitive both adapters use to read 4 bytes from a
`RandomSource`).
The package depends on neither `pure-rand` nor `fast-check` at
runtime; it depends only on those interfaces being structurally
compatible.

`@fast-check/ava` is a devDep of `@endo/random-fast-check` (used
by the `fast-check@3` smoke test) but not of `@endo/random`.

### Adapter shape: ship both generations in one module

Ship a parallel v8-shaped builder alongside the v5-shaped one.
Both adapters live in `@endo/random-fast-check`'s `index.js`, both
depend on nothing from `pure-rand` itself (we restate the structural
contract locally).
Consumers select the variant that matches their `fast-check` /
`pure-rand` major.
This is the smallest cut that lets the package serve both `fast-check@3`
and `fast-check@4` from the same source tree.

### Naming

| v5 / v6 / v7 (current) | v8 (new) |
|---|---|
| `adaptToPureRandomGenerator` | `adaptToPureRandomGeneratorV8` |
| `adaptFromPureRandomGenerator` | `adaptFromPureRandomGeneratorV8` |
| `makeRandomTypeFromSeed` | `makeRandomTypeFromSeedV8` |
| `PureRandomGenerator` (type) | `PureRandomGeneratorV8` (type) |

Versioned suffixes rather than namespaces because the v5 surface is
the one already shipping in PR #75 and rename-on-the-shipping-PR is
disruptive.
When `fast-check@3` support is dropped (whenever that is) the v5
exports go away by name, and a tree-shaking or alias migration can
collapse `*V8` to the unsuffixed names.

The `V8` suffix is exact (matches the npm major) rather than vague
("Mutating", "Single", etc.) because the wire we are conforming to
is `pure-rand`'s shape; if `pure-rand@9` happens, a `*V9` follows
the same pattern.

### Adapter shapes

```js
// @endo/random-fast-check/index.js (v8 additions)

/**
 * Wraps a `RandomSource` as a `pure-rand` v8 `RandomGenerator`.
 * `next()` reads 4 bytes through the source and returns a 32-bit
 * signed integer.  State advances in place; there is no separate
 * "unsafe" entry point in v8.
 *
 * `clone()` here returns an alias of this generator: `RandomSource`
 * has no general state-snapshot facility, so the alias shares
 * keystream state with the original.  Sufficient for `fast-check`'s
 * forward sampling; degrades shrinking quality.
 *
 * `getState()` returns an empty array because `RandomSource` does
 * not expose its state.  Consumers that need a real snapshot drive
 * a fresh source from a freshly-derived seed; this adapter is for
 * `fast-check`'s `randomType` use, where `getState` is not consulted.
 */
export const adaptToPureRandomGeneratorV8 = source => {
  const next = () => randomUint32(source) | 0;
  const rg = {
    next,
    clone() { return rg; },
    getState() { return harden([]); },
  };
  return harden(rg);
};

/**
 * Wraps a `pure-rand` v8 `RandomGenerator` as a `RandomSource`.
 * Each `next()` call yields one 32-bit value; the adapter unpacks
 * it into 4 little-endian bytes.
 */
export const adaptFromPureRandomGeneratorV8 = rg => {
  let pending = 0;
  let pendingBits = 0;
  const fillBytes = out => {
    for (let i = 0; i < out.length; i += 1) {
      if (pendingBits === 0) {
        pending = rg.next() >>> 0;
        pendingBits = 32;
      }
      out[i] = pending & 0xff;
      pending >>>= 8;
      pendingBits -= 8;
    }
  };
  return harden(fillBytes);
};

export const makeRandomTypeFromSeedV8 = makeSourceFromSeed => {
  const randomType = int32Seed => {
    const seed = new Uint8Array(32);
    const view = new DataView(seed.buffer);
    for (let i = 0; i < 8; i += 1) {
      view.setInt32(i * 4, int32Seed | 0, true);
    }
    return adaptToPureRandomGeneratorV8(makeSourceFromSeed(seed));
  };
  return harden(randomType);
};
```

The implementations are deliberately near-identical to their v5
siblings.
The shape difference is local to the returned object; the seed-broadcast
and byte-unpack code paths are the same.

### Where the contract relaxations go

- **`clone()` returning an alias.**
  v8's "fully independent" wording is stricter than v5's.
  The same caveat we documented for v5 (alias suffices for forward
  sampling, shrinking degrades) applies; we restate it on the v8
  adapter.
  A real snapshot facility is the same scope question as PR #75's
  "Out of scope" item on `RandomSource` state-snapshot independence,
  which is itself a `@endo/chacha12` capability question, not a
  `@endo/random` one.
- **`getState()` returning an empty array.**
  v5 made `getState` optional; v8 makes it mandatory.
  `fast-check` does not consult `getState()` on a `randomType` -built
  generator (it uses its own seeding path), so an empty-array
  placeholder satisfies the type without misleading.
  Document the placeholder explicitly so a future maintainer does not
  treat it as a serializable state.
  Consumers that *do* depend on `getState` need a `RandomSource` with
  real snapshot support, same as the `clone()` story.
- **`min()`, `max()`, `unsafeNext`, `jump`, `unsafeJump` removed.**
  Nothing for the adapter to do; the v8 surface is strictly smaller.

### Type definitions

`packages/random-fast-check/random-fast-check.types.d.ts` ships
both `PureRandomGenerator` and `PureRandomGeneratorV8`.
The v5 interface (which previously rode in `@endo/random`'s types
file, before PR #75's rename to `packages/random/types.d.ts`)
moves with the adapter into the new package; the v8 interface is
new:

```ts
/**
 * The shape of a `pure-rand` v8 `RandomGenerator`, the contract used
 * by `fast-check@4` to drive property-based tests via the
 * `randomType` parameter.  We restate it locally rather than depend
 * on `pure-rand` directly so `@endo/random-fast-check` stays
 * standalone.
 *
 * `next()` returns a 32-bit signed integer in
 * `[-0x80000000, 0x7fffffff]` and mutates the generator state.
 * `clone()` is required to return a fully independent clone; for
 * serial keystreams without state-snapshot support the adapter
 * returns an alias whose state is shared with the original
 * (sufficient for forward sampling; shrinking quality may degrade).
 * `getState()` returns the generator's internal state as a
 * `readonly number[]`; for sources without snapshot support the
 * adapter returns an empty array.
 */
export interface PureRandomGeneratorV8 {
  next(): number;
  clone(): PureRandomGeneratorV8;
  getState(): readonly number[];
}
```

### Subpath exports

`@endo/random-fast-check`'s default entry point (`./index.js`)
exports both adapter generations.
Callers writing a single conditional
(`process.env.PURE_RAND_MAJOR === '8'`) can import both names in
one statement.
No additional subpath export is needed; the package's surface is
small enough to fit in one module.

### What the implementation scaffold in this PR contains

The scaffold is a proof of surface, not a full port.

- The new `packages/random-fast-check/` package, containing both
  adapter generations and the `PureRandomGenerator` /
  `PureRandomGeneratorV8` type interfaces.
- `packages/random-fast-check/test/pure-rand.test.js` (the v5
  unit tests, relocated from PR #75's
  `packages/random/test/pure-rand.test.js`).
- `packages/random-fast-check/test/fast-check.test.js` (the
  `fast-check@3` smoke test, relocated from PR #75).
- A new test file
  `packages/random-fast-check/test/pure-rand-v8.test.js` that
  exercises:
  - `adaptToPureRandomGeneratorV8` returns values in
    `[-0x80000000, 0x7fffffff]` and `next()` returns a number
    (not a tuple).
  - `clone()` returns a generator that is an alias by design
    (documented), and the adapter's `getState()` returns `[]`.
  - Round trip: `source -> adaptToV8 -> adaptFromV8 -> source`
    yields the same byte stream as the unwrapped source.
  - `adapter` byte stream matches the v5 adapter's byte stream when
    fed the same source (cross-check that the `next` pack/unpack
    is bit-identical between the two adapter generations).

The scaffold deliberately does **not**:

- Add `pure-rand@^8` as a direct dependency. The adapter
  consumes only the structural contract; `@endo/random-fast-check`
  remains pure-rand-free at runtime.
- Build a `fast-check@4` -driven test. `@fast-check/ava@^1` pins
  `fast-check@^3`; switching `fast-check` major in this monorepo is
  its own change and is not the maintainer's ask.
  The v8 adapter is exercised through unit tests against the
  structural contract; once `fast-check@4` lands in the workspace
  (its own PR), a `fast-check.test.js`-style integration test for
  the v8 path can be added.
- Drop the v5 adapter. Both ship until `fast-check@3` support
  is dropped.

## Test Plan

- `packages/random-fast-check/test/pure-rand-v8.test.js` (new)
  covers the scaffold's claimed surface in unit form.
- `packages/random-fast-check/test/pure-rand.test.js` (relocated
  from `packages/random/test/pure-rand.test.js` in PR #75) covers
  the v5 adapter and round-trip.
- `packages/random-fast-check/test/fast-check.test.js` (relocated
  from PR #75) drives `fc.assert` through the v5 path.
- Once `fast-check@4` is in the workspace (separate PR), add the
  same `fc.assert` smoke test against `makeRandomTypeFromSeedV8`.
- Type-coverage: `random-fast-check.types.d.ts` exports both
  interfaces; `tsc --build` validates that the v8 adapter conforms
  structurally.

## Open Questions (for maintainer-taste resolution)

1. **Naming.** `*V8` suffix versus a `pureRandV8.*` namespace
   (`packages/random-fast-check/pure-rand-v8.js`) versus naming for
   *content* ("`Mutating`", "`Single`", etc.).
   Suffix wins on minimum churn (the v5 names are the names already
   reviewed in PR #75); namespace wins on tab-completion ergonomics;
   content wins on age-resilience.
   No default chosen here.

2. **Scope of `getState` placeholder.**
   The proposal returns an empty array, satisfying the v8 type but
   shipping no real state.
   An alternative is to throw `TypeError('getState not supported')`
   on the v8 adapter, which is more honest but breaks any consumer
   that holds a generator and asks for its state without
   discriminating.
   Empty-array is the path of least surprise for `fast-check`'s
   single-call use; the throwing variant is correct for
   library-author use.
   Maintainer call.

3. **Fold or sequel.**
   The maintainer's first prompt (PR #75 comment id 4385614416)
   asked for the v8 work to land before deciding fold-vs-sequel.
   The follow-up direction (PR #75 comment id 4393030139) moved the
   adapter out of `@endo/random` entirely, which makes "fold into
   PR #75" mechanically inconsistent with PR #75's narrowed scope
   (the new `@endo/random-fast-check` package would not exist on the
   PR #75 path).
   The remaining decision is whether `@endo/random-fast-check` lands
   as part of this PR (which is what this PR is now structured to do)
   or as a sequel after PR #75 merges.
   This PR is structured to land both the package and the v8 adapter
   atomically; if the maintainer prefers a smaller PR, the v8
   additions can be split into a third PR after this PR's
   v5-package-extraction lands.

4. **`@endo/chacha12` snapshot facility.**
   The "real `clone()` independence" question is downstream of
   `@endo/chacha12` exposing keystream state.
   PR #75's reshape now returns a `ChaCha12Generator` record from
   `makeChaCha12(seed)` with `getState`, `clone`, and `next` already
   exposed; in principle a snapshot-respecting v8 adapter could
   consult `getState()` on the generator and pair it with
   `makeChaCha12FromState(state)` (also exported on the new base).
   Wiring that through `RandomSource`-shaped adapters is its own
   design (the `RandomSource` shape itself has no snapshot facility,
   so the adapter would need to take the `ChaCha12Generator` record
   directly rather than its `fillRandomBytes` method).
   Flag here, not a blocker for this PR.

## Dependencies

- PR #75 (`endojs/endo-but-for-bots#75`,
  `feat(random,chacha12): factor @endo/random from @endo/chacha12`)
  is the parent.
  This PR's branch is rooted at PR #75's head so the `packages/random/`
  tree exists for `@endo/random-fast-check` to depend on.
  When PR #75 lands first, this rebases onto `bots-ssh/llm`.

## Prompts

> Please design and implement a follow-up PR to address the pure-rand
> v8 interface.
> I would like to see that before deciding whether to fold that into
> this change.
>
> -- kriskowal, PR #75 comment id 4385614416, 2026-05-06T06:24:52Z

> Please remove the fast-check adapter from this change and add it to
> the scope of #107, where it will have its own package or packages,
> assuming we use it in conjunction with fast-check in this project.
>
> -- kriskowal, PR #75 comment id 4393030139, 2026-05-06T23:50:08Z
