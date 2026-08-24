# TypedArray Indexed-Cardinality Fast Path for `harden`

| | |
|---|---|
| **Created** | 2026-08-24 |
| **Updated** | 2026-08-24 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |

## What is the Problem Being Solved?

`harden` is a transitive freeze: `baseFreezeAndTraverse` walks the object graph,
making each reachable object non-extensible and each own property read-only and
non-configurable, then enqueues every outbound reference (own property values,
and the prototype when `traversePrototypes` is enabled) so the walk continues.

On `master` at commit
[`6ee3fda77b`](https://github.com/endojs/endo/commit/6ee3fda77b),
`packages/harden/make-hardener.js` special-cases *genuine TypedArrays* (views
whose intrinsic TypedArray brand check passes, as opposed to Arrays, DataViews,
ordinary objects imitating a view, or Proxies around a view) because
`Object.freeze` rejects a non-empty view (the integer-indexed exotic rules
forbid making an in-range element non-writable). `freezeTypedArray` instead
prevents extensions and walks every own key, fetching a descriptor and
redefining each non-indexed *expando* (an own property whose key is not a
canonical integer index, that is, any property added to a view beyond its
elements) as read-only and non-configurable. `baseFreezeAndTraverse` then
obtains every own descriptor a second time to discover outbound references.

For the common case of a dense TypedArray with no expandos, all own properties
are integer-indexed elements. Their values are necessarily Number or BigInt
primitives, and the integer-indexed exotic rules already fix their descriptors,
so there is no per-key hardening or traversal work to perform. Large byte arrays
nevertheless pay for both descriptor passes today.

The criterion this design searches for is a *genuine constant-time source for
the count of indexed own properties*: a value the code can read in O(1),
independent of the number of keys, that equals the number of integer-indexed
elements of a genuine TypedArray. Given such a source, comparing it against the
total own-key count recognizes the no-expando common case and skips the per-key
downgrade loop and the second descriptor enumeration. Materializing the total
own-key count still costs one O(n) `Reflect.ownKeys` allocation: this is a
reduction in constant-factor work (two descriptor passes to none), not an
asymptotic change, and the problem statement claims no more than that.

This proposal is independent of
[PR #475](https://github.com/endojs/endo/pull/475) and its byte-array changes;
the later implementation must branch from `master` (the release line PR #475
also targets), not from the `endo-but-for-bots` `llm` line where most designs
land.

## Design

### Capture the intrinsic length getter

At module initialization, obtain the `length` getter from the intrinsic
`%TypedArray%.prototype`, alongside the existing captured `@@toStringTag`
getter. The capture pair is spelled to match the sibling
`typedArrayToStringTag` / `getTypedArrayToStringTag` already in the file (no
`Desc` suffix on the descriptor binding):

```js
const typedArrayLength = getOwnPropertyDescriptor(
  typedArrayPrototype,
  'length',
);
assert(typedArrayLength);
const getTypedArrayLength = typedArrayLength.get;
assert(getTypedArrayLength);
```

The indexed-own-property cardinality of a genuine TypedArray is then:

```js
const indexedPropertyCount = apply(getTypedArrayLength, array, []);
```

This is the constant-time source the problem statement requires. ECMA-262
section 23.2.3.21,
[get `%TypedArray%.prototype.length`](https://tc39.es/ecma262/multipage/indexed-collections.html#sec-get-%typedarray%.prototype.length),
reads TypedArray and backing-buffer metadata and returns the current view
length (or zero when detached or out of bounds). It does not enumerate
elements. The captured getter is non-generic, so it also provides a genuine
TypedArray brand check and cannot be confused by an own `length` expando or a
mutated prototype.

`byteLength / BYTES_PER_ELEMENT` is a correct but inferior equivalent: it
requires two captured intrinsics or a per-flavor element-size table and adds
division and out-of-bounds handling. `ArrayBuffer.isView` supplies only a brand
predicate, not a count, and also includes DataView. Reading `array.length` is
not acceptable because an own expando can shadow it. No ordinary JavaScript
operation exposes the total number of own properties in O(1);
`Reflect.ownKeys`, `Object.getOwnPropertyNames`, and
`Object.getOwnPropertyDescriptors` must materialize a result proportional to
the number of keys, and a Proxy can synthesize an arbitrary key list.

Consequently, this is an O(1) *indexed-cardinality source and equality
decision*, not an O(1) end-to-end hardening operation. The required
`Reflect.ownKeys(array)` remains O(n) (the tension named in the problem
statement: the win is not "examine no keys", it is "read no descriptors"). The
gain is that a purely indexed view avoids per-key descriptor reads,
redefinitions, and the second descriptor enumeration. A truly O(1) end-to-end
test would require a new engine intrinsic for own-property cardinality and is
outside this portable implementation.

### Cardinality equality

The order of the two reads is load-bearing for safety. `freezeTypedArray` reads
the intrinsic length **first**, then materializes the own keys:

```js
const freezeTypedArray = array => {
  preventExtensions(array);
  // Read the O(1) indexed cardinality BEFORE materializing keys. See the
  // Correctness Argument: this ordering makes concurrent growth of a growable
  // SharedArrayBuffer select the slow path rather than hide an expando.
  const indexedPropertyCount = apply(getTypedArrayLength, array, []);
  const keys = ownKeys(array);
  if (keys.length === indexedPropertyCount) {
    return undefined; // purely indexed: no own outbound references
  }
  // ... slow path (below) ...
  return keys;
};
```

The helper returns a *fact about its argument*, not an instruction to its
caller: the contract is

```
freezeTypedArray(array) => Array<string | symbol> | undefined
```

`undefined` on the fast path means "purely indexed: this view has no own
outbound references, so skip the descriptor pass"; the caller still enqueues the
prototype when `traversePrototypes` is enabled. On the slow path it returns the
own `keys` it already materialized, so `baseFreezeAndTraverse` reuses that one
`ownKeys` result for its outbound-reference traversal instead of enumerating a
second time. The call site therefore reads as
`const keys = freezeTypedArray(obj); if (keys) { /* traverse keys */ }`, not as
`if (freezeTypedArray(obj))` (which would read as "if freezing succeeded").

On the slow path the implementation retains the existing behavior: inspect the
captured `keys`, apply the existing descriptor rewrite to every non-indexed
expando, and hand the keys back for descriptor traversal. This includes
preserving the current failure behavior for an accessor expando, whose rewrite
supplies the incompatible `writable` field and throws. A minimal first
implementation may leave the generic descriptor traversal unchanged on this slow
path. A later measured refinement may combine the TypedArray expando-freezing
and traversal passes, but that is not required for this optimization.

The fast path is restricted to values accepted by the existing intrinsic
TypedArray brand check. Arrays, DataViews, ordinary objects that imitate a
TypedArray, and Proxies around TypedArrays continue through the generic path.

## Correctness Argument

The fast path *skips work*, so it fails open: a miscount that under-counts keys
or over-reports the length would skip an expando and leave it writable and its
outbound reference un-hardened. Safety therefore rests on the equality never
holding in the presence of an expando. The read order is what secures that
direction, and the argument makes it explicit.

ECMA-262 section 10.4.5.7,
[TypedArray `[[OwnPropertyKeys]]`](https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-typedarray-exotic-objects-ownpropertykeys),
emits every valid integer index from zero through `length - 1`, followed by
ordinary string keys and then symbol keys. Genuine in-bounds TypedArrays are
dense: they cannot have holes among those indices. Therefore, at any single
instant, the own-key count is exactly the intrinsic length plus the number of
non-indexed expandos, and equality with the intrinsic length holds exactly when
there are no expandos.

Two independent reads of a mutable view do not, on their own, carry a
single-instant invariant, so the read order must be shown to skew conservatively.
Let `L1` be the intrinsic length read first and `Lk` the length in effect when
`ownKeys` runs, so `keys.length = Lk + e` where `e >= 0` is the expando count.
The only way a live view's length can change concurrently is growth of a
*growable* `SharedArrayBuffer` by another agent (a non-shared resizable buffer
can only be resized by the current agent, which is not resizing it during this
synchronous sequence), and `SharedArrayBuffer.prototype.grow` is monotone, so
`Lk >= L1`. Hence `keys.length = Lk + e >= L1`, with equality only when
`Lk === L1` and `e === 0`. Equality therefore holds only when there are no
expandos, so the fast path is safe. Growth that races between the two reads can
only inflate `keys.length` past `L1` and select the slow path; it can never
hide an expando. (Reading `ownKeys` first would invert this: growth could then
raise the later length read up to `keys.length` and mask an expando, the defect
this ordering corrects.)

That yields the behavior-preservation cases:

- A plain TypedArray has exactly `length` own keys. Skipping is safe because
  every indexed value is a primitive and the hardener deliberately leaves
  indexed descriptors writable. Integer-indexed exotic objects make in-range
  elements permanently writable (and, since the ES2021 resizable-buffer change,
  `configurable: true`); `harden` carves them out as analogous to the data slots
  of a hardened Map or Set, per `packages/harden/make-hardener.js` (the
  `freezeTypedArray` comment; note that its "and non-configurable" clause is a
  stale pre-ES2021 remark (in-range indices are configurable today) worth a
  drive-by correction in the implementation PR).
- Any string expando, including an own shadowing `length`, increases the total
  count and selects the slow path. Data expandos are still downgraded and
  traversed; accessor expandos retain the existing thrown outcome.
- Every symbol expando also increases the total count and selects the slow
  path, so symbol-keyed outbound references are preserved.
- Accessor expandos cannot occupy an integer index: ECMA-262 section 10.4.5.3,
  [TypedArray `[[DefineOwnProperty]]`](https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-typedarray-exotic-objects-defineownproperty),
  rejects accessors at valid integer indices. Accessors can exist only under a
  non-index key, which defeats equality and preserves the existing slow-path
  outcome. A Proxy that could synthesize index accessors fails the intrinsic
  brand check and never enters this path.
- Detached and out-of-bounds views have intrinsic length zero and expose no
  valid indexed own keys. Equality therefore holds only when they also have no
  expandos, so the fast path is safe for these views; any expando makes
  `keys.length` nonzero, forcing the slow path. Length-tracking resizable views
  use their current intrinsic length, read before the keys under the ordering
  above.

The proof depends on the genuine TypedArray density invariant. It must not be
generalized to Arrays, whose `length` is an own property and whose indexed
elements may have holes or accessor descriptors. Ordinary and emulated
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
is changed too. Both get the same edit, the same proof, and the same regression
matrix, in `packages/harden/test/make-hardener.test.js` and the matching SES
tests.

Tests must cover empty and large Number/BigInt TypedArrays; string, symbol, and
accessor expandos; an own `length` expando; detached and resizable-buffer views
when the runtime supports them; a length-tracking view over a growable
`SharedArrayBuffer` grown between the length read and the key read (the
concurrent-grow case that motivates the read order, asserting the grown view
with an expando still selects the slow path and hardens the expando); a
TypedArray subclass; a Proxy around a TypedArray; and holey/accessor-bearing
Arrays and ordinary objects. Both `makeHardener()` and
`makeHardener({ traversePrototypes: true })` must be exercised, since the change
sits on exactly that control flow. Slow-path cases must prove that referenced
data values are hardened and that accessor expandos retain the baseline thrown
outcome, not merely that the root becomes non-extensible. Tests that attempt to
define an accessor at an in-range TypedArray index must confirm that the engine
rejects the definition before `harden` runs.

Add a focused benchmark comparing the current and proposed hardener on large
pure TypedArrays and on TypedArrays with one expando, run on the engines the
portability claim rests on (at minimum V8; SpiderMonkey, JavaScriptCore, XS, and
GraalJS where available in CI). Acceptance requires a repeatable reduction for
the pure case without a material regression for the slow case. The benchmark
report must describe the remaining O(n) `Reflect.ownKeys` allocation so the
result is not presented as an asymptotic improvement; measured on a 64 KiB
`Uint8Array` (Node v22, median of 60) the current hardener runs ~15.4 ms and
this proposal ~3.25 ms against a bare-`ownKeys` floor of ~3.49 ms, so the
unavoidable allocation caps the achievable speedup near 4.7x.

## Alternatives Considered

- **Single-pass last-key ordering test.** Because section 10.4.5.7 orders all
  integer indices before any string or symbol key, the purely-indexed question
  is decidable from the single `keys` value at one instant, with no second read
  and no captured length getter:
  `keys.length === 0 || isCanonicalIntegerIndexString(keys[keys.length - 1])`.
  The final key is a canonical integer index exactly when there are no expandos
  (string and symbol expandos sort last, and `[[DefineOwnProperty]]` rejects
  out-of-range numeric-string keys). This is strictly simpler (one value, one
  instant, no two-snapshot race, and one fewer intrinsic `getTypedArrayLength`
  in `harden`'s trusted base) and reuses `isCanonicalIntegerIndexString`, which
  the file already defines. Measured at ~4.59 ms on the 64 KiB workload above,
  it captures most of the win (the ~3.5 ms `ownKeys` floor dominates either
  way). It is not adopted here only because the prompt frames the task as a
  cardinality-equality test with an O(1) indexed-cardinality source; a future
  revision unconstrained by that framing should prefer it, and the two variants
  are behaviorally equivalent.
- `TypedArray.prototype.byteLength`: rejected in favor of the direct length
  getter because it needs element-width recovery and has no stronger
  guarantee.
- `ArrayBuffer.isView`: rejected because it yields no cardinality and admits
  DataView.
- General object or Array fast path: rejected because JavaScript exposes no
  O(1) own-property count, and array length does not imply density or data-only
  elements.
- Engine-specific intrinsic: deferred. It is the only route to a genuinely
  O(1) end-to-end pure-indexed predicate, but `@endo/harden` must remain
  portable across V8, SpiderMonkey, JavaScriptCore, XS, and GraalJS.

## Prompt

> Propose a change based on `master` that avoids the linear own-keys work in
> `make-hardener` when total own-property cardinality equals indexed
> own-property cardinality, provided the latter has a genuine O(1) source.
> Establish the source and prove behavior is unchanged for expandos,
> accessors, symbols, and holes.
