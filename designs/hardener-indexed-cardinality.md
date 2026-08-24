# TypedArray Indexed-Cardinality Fast Path for `harden`

| | |
|---|---|
| **Created** | 2026-08-24 |
| **Updated** | 2026-08-24 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |

## What is the Problem Being Solved?

`harden` is a transitive freeze: it tamper-proofs an object graph so that
confined code can be handed a reference without being able to mutate it or the
objects it can reach. `baseFreezeAndTraverse` walks the graph, making each
reachable object non-extensible and each own property read-only and
non-configurable, then enqueues every outbound reference (own property values,
and the prototype when the `traversePrototypes` option of `makeHardener` is
enabled) so the walk continues.

On `master` at commit
[`6ee3fda77b`](https://github.com/endojs/endo/commit/6ee3fda77b),
`packages/harden/make-hardener.js` special-cases *genuine TypedArrays* (views
whose intrinsic TypedArray brand check passes, as opposed to Arrays, DataViews,
ordinary objects imitating a view, or Proxies around a view) because
`Object.freeze` rejects a non-empty view (the integer-indexed exotic rules
forbid making an in-range element non-writable). `freezeTypedArray` instead
prevents extensions and walks every own key, fetching a descriptor and
redefining each non-indexed *expando* as read-only and non-configurable. An
expando is an own property whose key is not a canonical integer index: any
property added to a view beyond its elements. A *canonical integer
index* is the string form of a non-negative integer with no redundant
representation: `"0"` and `"12"` are canonical integer indices, while `"00"`,
`"1.0"`, `"-0"`, `"length"`, and any symbol are not. After `freezeTypedArray`
returns, `baseFreezeAndTraverse` obtains every own descriptor a second time to
discover outbound references.

For the common case of a dense TypedArray with no expandos, all own properties
are integer-indexed elements. Their values are necessarily Number or BigInt
primitives, and the integer-indexed exotic rules already fix their descriptors,
so there is no per-key hardening or traversal work to perform. Large byte arrays
nevertheless pay for both descriptor passes today.

The prompt (reproduced at the end) frames the task as a *cardinality-equality*
test: skip the linear work exactly when the total own-property cardinality
equals the indexed own-property cardinality, provided that indexed cardinality
has a genuine O(1) source. That equality is the right condition (it holds
precisely when the view is purely indexed), but it need not be decided by
counting. Section 10.4.5.7 of ECMA-262 orders all integer indices of a
TypedArray before any string or symbol key, and a genuine in-bounds TypedArray
is dense, so a single `Reflect.ownKeys` result already answers the question at
one instant: the view is purely indexed exactly when its **last own key is a
canonical integer index** (or it has no own keys at all). This design adopts
that single-instant ordering test as its primary mechanism. The equivalent
counting formulation, which reads an O(1) intrinsic length as the prompt's
literal framing suggests, is retained under *Alternatives Considered* as a
behaviorally identical but heavier variant.

Either way, materializing the own keys still costs one O(n) `Reflect.ownKeys`
allocation. This is a reduction in constant-factor work (two descriptor passes
down to none for the pure case), not an asymptotic change, and the design
claims no more than that.

This proposal is independent of
[PR #475](https://github.com/endojs/endo/pull/475) and its byte-array changes;
the later implementation must branch from `master` (the release line PR #475
also targets), not from the `endo-but-for-bots` `llm` line where most designs
land.

## Design

The fast path is restricted to values accepted by the existing intrinsic
TypedArray brand check. Arrays, DataViews, ordinary objects that imitate a
TypedArray, and Proxies around TypedArrays continue through the generic path.

### The purely indexed decision

`freezeTypedArray` materializes the own keys once and tests whether the last one
is a canonical integer index, reusing `isCanonicalIntegerIndexString`, which the
file already defines (`packages/harden/make-hardener.js:282`):

```js
const freezeTypedArray = array => {
  preventExtensions(array);
  const keys = ownKeys(array);
  const purelyIndexed =
    keys.length === 0 ||
    isCanonicalIntegerIndexString(keys[keys.length - 1]);
  if (purelyIndexed) {
    // No expandos: every own key is a primitive-valued element, already
    // permanently writable and non-configurable by the exotic rules, so
    // there is nothing to downgrade and no own outbound reference to enqueue.
    return true;
  }
  // Slow path: at least one expando. Downgrade each non-indexed expando to
  // read-only and non-configurable, exactly as today.
  arrayForEach(keys, name => {
    const desc = getOwnPropertyDescriptor(array, name);
    assert(desc);
    if (!isCanonicalIntegerIndexString(name)) {
      defineProperty(array, name, { ...desc, writable: false, configurable: false });
    }
  });
  return false;
};
```

The helper returns a single, uniform value: a boolean reporting whether the view
was purely indexed. That is the one fact the caller newly consumes. When it is
`true`, `baseFreezeAndTraverse` skips its second descriptor pass for this object
(there are no own outbound references to enqueue); it still enqueues the
prototype when `traversePrototypes` is enabled. When it is `false`, the caller
runs its existing generic descriptor traversal unchanged. The boolean is
deliberately *not* the list of keys: handing the freshly materialized keys back
to the caller would let a later refinement feed them into
`getOwnPropertyDescriptors`, reintroducing exactly the GraalJS skew the current
per-key `getOwnPropertyDescriptor` re-derivation is written to defend against
(`packages/harden/make-hardener.js:296`). Keeping the return to the one
consumed fact leaves the descriptor traversal (and its fail-safe) untouched.

Combining the expando-freezing pass and the outbound-reference traversal into a
single descriptor walk on the slow path is a possible later refinement, but it
is out of scope here: the slow path is unchanged from today and does not depend
on this optimization.

Why the last key alone decides it: ECMA-262 section 10.4.5.7,
[TypedArray `[[OwnPropertyKeys]]`](https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-typedarray-exotic-objects-ownpropertykeys),
emits every valid integer index from zero through `length - 1`, then ordinary
string keys, then symbol keys.
Genuine in-bounds TypedArrays are dense (they cannot have holes among those
indices), so if any expando exists it sorts after every index and the final key
is a string or a symbol, which is not a canonical integer index. Conversely, if
the final key is a canonical integer index there can be no trailing string or
symbol expando, and density rules out an interior gap, so the view is purely
indexed. This is an O(1) decision over the already-materialized key list: the
win is not "examine no keys"; it is "read no descriptors".

`Reflect.ownKeys(array)` remains O(n): the tension the prompt names. No
ordinary JavaScript operation exposes the total number of own properties in
O(1): `Reflect.ownKeys`, `Object.getOwnPropertyNames`, and
`Object.getOwnPropertyDescriptors` each materialize a result proportional to the
number of keys, and a Proxy can synthesize an arbitrary key list. A truly O(1)
end-to-end test would require a new engine intrinsic for own-property
cardinality and is outside this portable implementation. The gain here is that a
purely indexed view avoids per-key descriptor reads, per-key redefinitions, and
the second descriptor enumeration.

## Correctness Argument

The fast path *skips work*, so it fails open: wrongly classifying a view with an
expando as purely indexed would leave that expando writable and its outbound
reference un-hardened, defeating the confinement guarantee `harden` exists to
provide. Safety therefore rests on the classification never reporting "purely
indexed" in the presence of an expando.

The decision reads a single `Reflect.ownKeys` snapshot. `[[OwnPropertyKeys]]`
is one synchronous internal operation with no user-code interposition point (the
brand check excludes Proxies, whose traps could otherwise run), so the returned
list is a single-instant view of the object's keys. There is no second read to
race against and no ordering to prove skew-conservative; the design reasons about
exactly one key list. By the ordering and density of section 10.4.5.7, that list
ends in a canonical integer index if and only if the view carries no expando.
The behavior-preservation cases follow:

- A plain TypedArray has exactly `length` own keys, all canonical integer
  indices, so the last key is a canonical integer index and the fast path
  applies. Skipping is safe because every indexed value is a primitive and the
  integer-indexed exotic rules make in-range elements permanently writable and
  `configurable: true` (since the ES2021 resizable-buffer change). `harden`
  carves them out as analogous to the data slots of a hardened Map or Set.
- Any string expando, including an own shadowing `length`, sorts after every
  index, so the last key is a non-index string and the slow path applies. Data
  expandos are downgraded and traversed; accessor expandos retain the existing
  thrown outcome.
- Every symbol expando sorts after all string keys, so the last key is a symbol.
  `isCanonicalIntegerIndexString` returns `false` for a symbol (`String(sym)` is
  not a canonical integer string), so the slow path applies and symbol-keyed
  outbound references are preserved.
- Accessor expandos cannot occupy an integer index: ECMA-262 section 10.4.5.3,
  [TypedArray `[[DefineOwnProperty]]`](https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-typedarray-exotic-objects-defineownproperty),
  rejects accessors at valid integer indices. An accessor can exist only under a
  non-index key, which lands last and forces the slow path. A Proxy that could
  synthesize index accessors fails the intrinsic brand check and never enters
  this path.
- Detached and out-of-bounds views expose no valid indexed own keys. If such a
  view has no expandos, `keys.length === 0` and the fast path correctly does
  nothing; any expando makes the last (and only) keys non-index, forcing the
  slow path. Length-tracking resizable views expose their current indices at the
  instant `ownKeys` runs, and the same last-key test applies to that snapshot.

The proof depends on the genuine TypedArray density invariant. The fast path
must not be generalized to Arrays, whose `length` is an own property and whose
indexed elements may have holes or accessor descriptors. Ordinary and emulated
typed-array-like objects likewise retain the generic path, including all hole
and accessor traversal.

Note (out of scope): whether `Object.preventExtensions` should succeed at all on
a length-tracking view over a resizable buffer (V8 allows it today, after which
growth still adds indices to a hardened array) is a pre-existing `harden`
question this design does not create and does not absorb; it belongs on its own
issue.

## Implementation and Test Plan

The change touches two near-identical copies of the hardener that must move in
lockstep: `packages/harden/make-hardener.js` and the SES copy
`packages/ses/src/make-hardener.js`, from which `packages/ses/src/lockdown.js`
builds `safeHarden`. Both carry their own `freezeTypedArray`; the optimization
does not reach the `harden` that SES consumers actually call unless the SES copy
is changed too. Because the single-instant test has no read-ordering to get
wrong, there is no race-dependent invariant to keep aligned by hand across the
two copies: the decision is a one-line last-key test in each. Both get the same
edit, the same proof, and the same regression matrix. The regression tests live
in `packages/harden/test/make-hardener.test.js` and the matching SES tests.

Drive-by (its own commit, per changeset discipline): the `freezeTypedArray`
comment at `packages/harden/make-hardener.js:304` says in-range indices are
"permanently writable and non-configurable"; the "non-configurable" clause is a
stale pre-ES2021 remark, since in-range indices are `configurable: true` today.
Correct the comment in the same PR but as a separate commit from the
optimization.

Tests must cover:

- empty and large Number/BigInt TypedArrays;
- string, symbol, and accessor expandos;
- an own `length` expando;
- detached and resizable-buffer views, when the runtime supports them;
- a TypedArray subclass;
- a Proxy around a TypedArray;
- holey and accessor-bearing Arrays and ordinary objects (must retain the
  generic path).

Both `makeHardener()` and `makeHardener({ traversePrototypes: true })` must be
exercised, since the change sits on exactly that control flow. Slow-path cases
must prove that referenced data values are hardened and that accessor expandos
retain the baseline thrown outcome, not merely that the root becomes
non-extensible. Tests that attempt to define an accessor at an in-range
TypedArray index must confirm that the engine rejects the definition before
`harden` runs. Every listed case is a deterministic single-instant assertion:
because the design reads one key snapshot and never a second, there is no
concurrent-mutation timing to reproduce, so no test is flaky or vacuous.

Add a focused benchmark comparing the current and proposed hardener on large
pure TypedArrays and on TypedArrays with one expando, run on the engines the
portability claim rests on (at minimum V8; SpiderMonkey, JavaScriptCore, XS, and
GraalJS where available in CI). Acceptance requires a repeatable reduction for
the pure case without a material regression for the slow case. The benchmark
report must describe the remaining O(n) `Reflect.ownKeys` allocation so the
result is not presented as an asymptotic improvement.

These figures are preliminary single-harness estimates, not yet reproduced, and
the implementation PR must replace them with committed-harness measurements. On
a 64 KiB `Uint8Array` (Node v22, median of 60 runs) an early harness measured
the current hardener at roughly 15 ms and a bare `Reflect.ownKeys(array)` at
roughly 3.5 ms. Since the fast path cannot go below that `ownKeys` floor, the
achievable speedup is bounded by baseline over floor, about 4.4x, and the fast
path is expected to approach the floor because it does no per-key descriptor
work beyond materializing the keys.

## Alternatives Considered

- **Cardinality-equality via a captured intrinsic length getter.** Capture the
  `length` getter from `%TypedArray%.prototype` at module load, read
  `apply(getTypedArrayLength, array, [])` as an O(1) indexed cardinality, and
  compare it against `ownKeys(array).length`. This is the prompt's literal
  framing: a genuine O(1) *count* source, with equality recognizing the
  no-expando case. It is behaviorally equivalent to the adopted last-key test but
  strictly heavier: it adds a second captured intrinsic to `harden`'s trusted
  base; and, because the count and the key list are two independent reads of a
  possibly-growable view, its safety rests on a read-ordering argument (read the
  length first, so concurrent growth of a growable `SharedArrayBuffer` can only
  inflate the key count and select the slow path, never mask an expando) that
  the single-instant test does not need at all. It is retained here only as the
  faithful reading of the prompt; the last-key test decides the same equality at
  one instant with less trusted-base surface and no concurrency lemma, so it is
  preferred. See *Open questions*.
- **`TypedArray.prototype.byteLength` as the count source.** Rejected in favor of
  the direct length getter (were a count used at all) because it needs
  element-width recovery and offers no stronger guarantee.
- **`ArrayBuffer.isView`.** Rejected because it yields no cardinality and admits
  DataView.
- **A general object or Array fast path.** Rejected because JavaScript exposes no
  O(1) own-property count, and array length does not imply density or data-only
  elements.
- **An engine-specific own-property-cardinality intrinsic.** Deferred. It is the
  only route to a genuinely O(1) end-to-end purely indexed predicate, but
  `@endo/harden` must remain portable across V8, SpiderMonkey, JavaScriptCore,
  XS, and GraalJS.

## Open questions

- **Last-key ordering test versus cardinality-equality.** This revision adopts
  the single-instant last-key ordering test as the primary mechanism and demotes
  the prompt's literal cardinality-equality-with-O(1)-length-source formulation
  to an alternative, on the grounds that the two are behaviorally equivalent and
  the ordering test is strictly simpler (no second captured intrinsic, no
  two-read race, no `SharedArrayBuffer` monotonicity argument). The prompt asked
  specifically for the cardinality-equality shape. If the maintainer wants the
  implementation to establish and use the O(1) length source as literally
  prompted (for example to demonstrate that construction), the two forms can be
  swapped back with the correctness argument restored to the read-ordering proof.
  Please confirm which form the implementation should carry.

## Prompt

> Propose a change based on `master` that avoids the linear own-keys work in
> `make-hardener` when total own-property cardinality equals indexed
> own-property cardinality, provided the latter has a genuine O(1) source.
> Establish the source and prove behavior is unchanged for expandos,
> accessors, symbols, and holes.
