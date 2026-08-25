# Purely Indexed TypedArray Fast Path for `harden`

| | |
|---|---|
| **Created** | 2026-08-24 |
| **Updated** | 2026-08-25 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |

## What is the Problem Being Solved?

`harden` is a transitive freeze: it tamper-proofs an object graph so that
confined code can be handed a reference without being able to mutate it or the
objects it can reach.
`baseFreezeAndTraverse` walks the graph, making each reachable object
non-extensible and each own property read-only and non-configurable, then
enqueues every outbound reference (own property values, and the prototype when
the `traversePrototypes` option of `makeHardener` is enabled) so the walk
continues.

On `master` at commit
[`6ee3fda77b`](https://github.com/endojs/endo/commit/6ee3fda77b),
`packages/harden/make-hardener.js` special-cases *genuine TypedArrays* (views
whose intrinsic TypedArray brand check passes, as opposed to Arrays, DataViews,
ordinary objects imitating a view, or Proxies around a view) because
`Object.freeze` rejects a non-empty view (the integer-indexed exotic rules
forbid making an in-range element non-writable).
`freezeTypedArray` instead prevents extensions and walks every own key, fetching
a descriptor and redefining each non-indexed *expando* as read-only and
non-configurable.
An expando is an own property whose key is not a canonical integer index: any
property added to a view beyond its elements.
A *canonical integer index* is the string form of a non-negative integer with no
redundant representation: `"0"` and `"12"` are canonical integer indices, while
`"00"`, `"1.0"`, `"-0"`, `"length"`, and any symbol are not.
After `freezeTypedArray` returns, `baseFreezeAndTraverse` obtains every own
descriptor a second time to discover outbound references.

The common case is a *dense* TypedArray with no expandos: every valid index from
zero through `length - 1` is present, no index is a hole, and no property has been
added beyond the elements.
Such a view is *purely indexed*: dense **and** carrying no expando.
The term is not a synonym for *dense* — a dense view can still carry an expando,
which makes it dense but not purely indexed — and *purely indexed* is the exact
class the fast path accepts.
For such a view all own properties are integer-indexed elements.
Their values are necessarily Number or BigInt primitives, and the
integer-indexed exotic rules already fix their descriptors, so there is no
per-key hardening or traversal work to perform.
Large byte arrays nevertheless pay for both descriptor passes today.
The workload that motivates this change is hardening large binary payloads that
cross a confinement boundary: `Uint8Array` buffers holding serialized CapTP
arguments, cryptographic material, WASM linear-memory snapshots, or decoded media,
where a single `harden` walks tens of kilobytes of elements that can never carry
an outbound reference.
Small views gain nothing measurable; the case worth optimizing is the
multi-kilobyte dense buffer.

The prompt (reproduced verbatim at the end) asks for a change based on `master`
that avoids the linear own-keys work when total own-property cardinality equals
indexed own-property cardinality, provided the indexed count has a genuine O(1)
source, and that proves behavior unchanged for expandos, accessors, symbols, and
holes.
The ask as literally posed is not portably achievable — no standard JavaScript
operation reveals total own-property cardinality in O(1) (§ Design spells out
why, and § Alternatives Considered covers the engine-intrinsic route) — so the
linear `Reflect.ownKeys` materialization cannot be removed.
This design delivers the closest portable thing: it keeps the one O(n)
`Reflect.ownKeys` allocation but removes both O(n) *descriptor* passes for the
pure case.

The cardinality-equality condition is nonetheless the right condition — it holds
precisely when the view is purely indexed — but it need not be decided by
counting *alone*.
Section 10.4.5.7 of ECMA-262 orders all integer indices of a TypedArray before
any string or symbol key, and a genuine in-bounds TypedArray is dense, so a
single `Reflect.ownKeys` result already answers the question at one instant: the
view is purely indexed exactly when its **last own key is a canonical integer
index** (or it has no own keys at all).
This design adopts **both** tests, conjoined: the cardinality-equality count
(`keys.length` equals the O(1) intrinsic index count) **and** the single-instant
last-key ordering test.
The two are not exclusive alternatives to choose between — because the key list
is already materialized, the count conjunct costs one extra O(1) length-getter
read and one comparison, and a conjunction is at least as strict as either
conjunct, so it can only ever classify *fewer* views as pure, never more.
That makes it strictly safer than either test alone: it survives non-conformance
of *either* lemma (a mis-ordered or index-shaped-expando engine is caught by the
count; a mis-counting engine is caught by the ordering), where each test on its
own fails open under its own lemma's failure.
§ Alternatives Considered records the count-only and last-key-only forms, and why
neither on its own is preferred to the conjunction.

Materializing the own keys still costs one O(n) `Reflect.ownKeys` allocation —
the tension the prompt names — and this is a reduction in constant-factor work
(two descriptor passes down to none for the pure case), not an asymptotic change.
The design claims no more than that.

This proposal is independent of
[PR #475](https://github.com/endojs/endo/pull/475) and its byte-array changes;
the later implementation must branch from `master` (the release line PR #475 also
targets), not from the `endo-but-for-bots` `llm` line where most designs land.

## Design

The optimization adds a fast path to `freezeTypedArray` that recognizes a purely
indexed view and lets the caller skip its own-descriptor traversal.
The fast path is restricted to values accepted by the existing intrinsic
TypedArray brand check.
Arrays, DataViews, ordinary objects that imitate a TypedArray, and Proxies around
TypedArrays continue through the generic path.

### The purely indexed decision

`freezeTypedArray` reads the intrinsic index count, materializes the own keys
once, and requires **both** that the two counts agree and that the last key is a
canonical integer index, reusing `isCanonicalIntegerIndexString` (already defined
in the file) and a `length` getter captured from `%TypedArray%.prototype` at
module load (`getTypedArrayLength`; the file already captures that prototype's
`Symbol.toStringTag` getter for its brand check, so this adds one sibling
intrinsic):

```js
/**
 * @template T
 * @param {ArrayLike<T>} array a genuine (brand-checked) TypedArray
 * @returns {boolean} true when the view is purely indexed (see § Design for the
 *   definition), so the caller may skip its own-descriptor traversal for this
 *   object
 */
const freezeTypedArray = array => {
  preventExtensions(array);
  // Read the intrinsic length BEFORE the key list. With length read first,
  // concurrent growth of a length-tracking view over a growable
  // SharedArrayBuffer can only inflate `keys.length` relative to `len` and
  // force the slow path, never mask an expando (see § Correctness Argument).
  const len = apply(getTypedArrayLength, array, []);
  const keys = ownKeys(array);
  const purelyIndexed =
    keys.length === len &&
    (keys.length === 0 ||
      isCanonicalIntegerIndexString(keys[keys.length - 1]));
  if (purelyIndexed) {
    // No expando: every own key is a primitive-valued element. The
    // integer-indexed exotic rules keep in-range elements writable and
    // `configurable: true`, so there is nothing to downgrade, and each value
    // is a primitive, so there is no own outbound reference to enqueue.
    return true;
  }
  // Slow path: at least one expando. Downgrade each non-index expando to
  // read-only and non-configurable, exactly as today.
  arrayForEach(keys, name => {
    const desc = getOwnPropertyDescriptor(array, name);
    assert(desc);
    if (!isCanonicalIntegerIndexString(name)) {
      defineProperty(array, name, {
        ...desc,
        writable: false,
        configurable: false,
      });
    }
  });
  return false;
};
```

The caller consumes exactly one new fact — "this object has no own outbound
reference" — reported as the boolean `purelyIndexed`.

The change to `baseFreezeAndTraverse` is two things: capture the boolean out of
the TypedArray arm, and guard the *own-descriptor* pass — the bulk
`getOwnPropertyDescriptors` plus the loop that enqueues each descriptor's outbound
references — with `!purelyIndexed`.
The prototype enqueue keeps its existing placement and gating in each copy; only
the own-key pass is skipped.

The two snippets below are **schematic**: the loop body is elided (the
`enqueue(/* outbound refs of */ descs[key])` shorthand stands in for the real
per-descriptor walk, which applies the `hasOwn(desc, 'value')`
data-versus-accessor test), and the prototype enqueue differs between the two
copies as described in § Implementation and Test Plan.
The `harden`-package copy (`baseFreezeAndTraverse`) runs today:

```js
if (isTypedArray(obj)) {
  freezeTypedArray(obj);
} else {
  freeze(obj);
}
const descs = getOwnPropertyDescriptors(obj);
if (traversePrototypes) {
  enqueue(getPrototypeOf(obj)); // harden copy: gated on traversePrototypes
}
arrayForEach(ownKeys(descs), key => enqueue(/* outbound refs of */ descs[key]));
```

and becomes:

```js
let purelyIndexed = false;
if (isTypedArray(obj)) {
  purelyIndexed = freezeTypedArray(obj);
} else {
  freeze(obj);
}
if (traversePrototypes) {
  enqueue(getPrototypeOf(obj)); // unchanged, still runs for every object
}
if (!purelyIndexed) {
  const descs = getOwnPropertyDescriptors(obj);
  arrayForEach(ownKeys(descs), key => enqueue(/* outbound refs of */ descs[key]));
}
```

The prototype enqueue is hoisted above the now-guarded descriptor block so that it
still runs for a purely indexed view.
The prototype is an outbound reference the walk must continue through — in the
`harden` copy whenever `traversePrototypes` is enabled, in the SES copy
unconditionally — so skipping the own-key pass must not also skip the prototype
enqueue.
Hoisting is safe because the prototype enqueue never read `descs`.
In the SES copy the prototype enqueue is *unconditional* rather than gated on
`traversePrototypes` (§ Implementation and Test Plan), so its edit hoists an
unconditional `enqueue(proto)` above the same guard; the two copies therefore
receive parallel but not character-identical edits.

The polarity is deliberately `purelyIndexed`, not `hasExpandos`: the falsy
default is the *fail-safe* one.
The flag is threaded out of only one arm of the `if`/`else`, the `else` arm
produces no assignment, and the SES copy is a hand-mirrored edit; a missed
assignment, an unset `let`, or a botched mirror therefore leaves `purelyIndexed`
false and runs the full descriptor traversal.
The dangerous direction — skipping traversal for an object that has outbound
references — is reachable only by an explicit `true`, never by omission.

The returned value is named `purelyIndexed` for the *classification* the helper
directly computes — "no non-index own key" — not for the downstream fact the
caller ultimately consumes ("no own outbound reference").
The two coincide only through a lemma stated in the § Correctness Argument: on a
genuine dense TypedArray every own key is either a primitive-valued index or a
downgraded expando, so a purely indexed view has no own outbound reference at all.
Naming the boolean for what the helper locally observes, rather than for the
consequence the caller draws from it, keeps the helper's contract about its own
check; the caller relies on the lemma to translate that classification into the
skip-traversal decision.

The boolean is deliberately not the list of keys: the reason is minimality. The
caller consumes exactly one bit, so the interface hands back one bit and nothing
that invites a future caller to re-walk descriptors a third way. (Returning the
keys would introduce nothing new — `baseFreezeAndTraverse` already calls bulk
`getOwnPropertyDescriptors(obj)` unconditionally on the traversal in both copies —
but it would widen the contract past what the one consumer needs.)

The slow path re-derives each descriptor per key because of a known GraalJS
non-conformance the file already guards: on GraalJS,
`Object.getOwnPropertyDescriptor` can return `undefined` for a property that
`Reflect.ownKeys` reports as present, so the per-key `assert(desc)` in
`freezeTypedArray` guards against trusting a bulk snapshot.
This design leaves that guard and its slow-path traversal untouched.

Combining the expando-freezing pass and the outbound-reference traversal into a
single descriptor walk on the slow path is a possible later refinement, but it is
out of scope here: the slow path is unchanged from today and does not depend on
this optimization.

Why the ordering conjunct decides it (on its own, on a conformant engine):
ECMA-262 section 10.4.5.7,
[TypedArray `[[OwnPropertyKeys]]`](https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-typedarray-exotic-objects-ownpropertykeys),
emits every valid integer index from zero through `length - 1`, then ordinary
string keys, then symbol keys.
Genuine in-bounds TypedArrays are dense, so if any expando exists it sorts after
every index and the final key is a string or a symbol.
A string expando's key can nonetheless *look* like an integer index, so "the
final key is a string" is not by itself enough to conclude "not a canonical
integer index"; that step needs a second lemma, proved in the *Correctness
Argument*, that no admissible expando key is a canonical integer index string.
Given that lemma, if the final key is a canonical integer index there can be no
trailing expando, and density rules out an interior gap, so the view is purely
indexed.
Why the count conjunct decides it (on its own): a genuine view is dense, so
`keys.length` equals the intrinsic index count exactly when no expando is
present, regardless of how any expando is spelled — this is the engine-independent
backstop the ordering conjunct lacks (it catches an index-shaped expando even on
an engine that mis-classified its key form).
The fast path requires **both**, so it engages only when both agree; either
lemma's failure is caught by the other conjunct.
This is an O(1) decision over the already-materialized key list plus one O(1)
length read: the win is not "examine no keys"; it is "read no descriptors".

`Reflect.ownKeys(array)` remains O(n): the tension the prompt names.
No ordinary JavaScript operation exposes the total number of own properties in
O(1): `Reflect.ownKeys`, `Object.getOwnPropertyNames`, and
`Object.getOwnPropertyDescriptors` each materialize a result proportional to the
number of keys, and a Proxy can synthesize an arbitrary key list.
A truly O(1) end-to-end test would require a new engine intrinsic for
own-property cardinality and is outside this portable implementation.
The gain here is that a purely indexed view avoids per-key descriptor reads,
per-key redefinitions, and the second descriptor enumeration.

## Correctness Argument

The fast path *skips work*, so it fails open: wrongly classifying a view with an
expando as purely indexed would leave that expando writable and its outbound
reference un-hardened, defeating the confinement guarantee `harden` exists to
provide.
Safety therefore rests on the classification never reporting "purely indexed" in
the presence of an expando.

The decision reads two intrinsics: the `%TypedArray%.prototype` `length` getter
first, then a `Reflect.ownKeys` snapshot.
Each is one synchronous internal operation with no user-code interposition point
(the brand check excludes Proxies, whose traps could otherwise run), so each is a
single-instant read.
The ordering conjunct reasons about exactly the one key list.
The count conjunct compares that list's length against the separately-read
`length`, so there is a second read, and its skew must be proved conservative.
It is, by the read order: `length` is read *before* `ownKeys`, and the only
concurrent mutation possible is another agent growing a length-tracking view over
a growable `SharedArrayBuffer` (a `SharedArrayBuffer` can only grow, and no
non-shared buffer has a concurrent writer between two synchronous reads).
Growth between the two reads makes `ownKeys` expose *more* indices than `len`, so
`keys.length > len` and the counts disagree, forcing the slow path.
Skew can therefore only *reject* the fast path, never admit an expando — the safe
direction.
Because the two conjuncts are ANDed, even a mis-timed count that spuriously agreed
would still leave the ordering conjunct to reject an expando on a conformant
engine; the race is not load-bearing for safety, only the read order is, and it
fails safe.

The boolean is computed at the `ownKeys` instant but consumed slightly later, when
the caller decides whether to run the descriptor pass, so the fact it reports must
still hold at consumption.
It does.
`preventExtensions` has already run on the view, so no new own property — and in
particular no expando — can be added afterward.
The only key-set changes still possible are index-count changes on a detached or
length-tracking view: a detach drops indices, and growth of a length-tracking view
over a growable buffer adds indices.
Both change only the population of integer-indexed elements, whose values remain
primitives and carry no outbound reference; neither can turn a purely indexed view
into one bearing an expando.
The reported fact — "no own outbound reference" — therefore holds just as well when
the caller acts on it as at the instant it was read.

Two lemmas make the last-key test exact.

**Lemma 1 (ordering).**
By section 10.4.5.7, an expando — any non-index own key — sorts after every
integer index, so if the last own key is a canonical integer index the view
carries no expando.

**Lemma 2 (no index-shaped expando survives definition).**
The last-key test would be unsafe if a view could carry an own key that both *is*
a canonical integer index string and *is not* a live element, because such a key
would pass `isCanonicalIntegerIndexString` yet name an expando.
`isCanonicalIntegerIndexString` (defined in the file) is
looser than "valid index": it returns `true` for any canonical numeric index
string regardless of range, so `"1e+21"` and `"9007199254740992"` (2^53) both
classify `true` even though neither is a valid TypedArray index.
What prevents these from ever appearing as own keys on a genuine view is ECMA-262
section 10.4.5.3,
[TypedArray `[[DefineOwnProperty]]`](https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-typedarray-exotic-objects-defineownproperty):
for a key that is a CanonicalNumericIndexString, the definition *fails* unless
the numeric value is a valid in-range integer index — and this rejection applies
to **data** properties, not only to the accessor case.
Verified on V8: `Object.defineProperty(new Uint8Array(4), k, { value: 9 })`
throws a `TypeError` for each of `"1e+21"`, `"9007199254740992"`, `"-1"`, `"100"`
(on a length-4 view), and `"-0"` — each is a CanonicalNumericIndexString whose
numeric value is not a valid in-range index, so the definition is rejected.
`"-0"` is the subtle member of this set: its numeric value is `-0`, which section
10.4.5.3 rejects even though `isCanonicalIntegerIndexString("-0")` returns `false`
(because `String(-0)` is `"0"`, not `"-0"`, so the round-trip test fails).
By contrast the near-index strings `"00"`, `"1.0"`, and `"1e21"` are *not*
CanonicalNumericIndexStrings at all — their canonical numeric forms are `"0"`,
`"1"`, and `"1e+21"` respectively — so they are ordinary string keys that *are*
definable and for which `isCanonicalIntegerIndexString` correctly returns `false`.
So every key that survives definition on a genuine view and satisfies
`isCanonicalIntegerIndexString` is a live in-range element whose value is a
primitive; every expando either fails `isCanonicalIntegerIndexString` (and sorts
last, by Lemma 1) or was rejected at definition and cannot be present.

The behavior-preservation cases follow.

- A plain TypedArray has exactly `length` own keys, all canonical integer
  indices, so the last key is a canonical integer index and the fast path
  applies.
  Skipping is safe for two reasons the fast path relies on.
  First, `harden`'s per-property job is to make each own property read-only and
  non-configurable, but the integer-indexed exotic rules make in-range elements
  permanently writable and `configurable: true` (the latter since the ES2021
  resizable-buffer change), so `harden` *cannot* downgrade them — the only
  per-key work available is work that would always throw, so skipping it changes
  nothing.
  Second, each element value is a Number or BigInt primitive, so there is no
  outbound reference to enqueue.
  `harden` carves these elements out much as it leaves the internal data slots of
  a hardened Map or Set untraversed.
- Any string expando, including an own `length` shadowing the prototype's, sorts
  after every index, so the last key is a non-index string and the slow path
  applies.
  Data expandos are downgraded and traversed; accessor expandos retain the
  existing thrown outcome.
- Every symbol expando sorts after all string keys, so the last key is a symbol.
  `isCanonicalIntegerIndexString` returns `false` for a symbol (`String(sym)` is
  not a canonical integer string), so the slow path applies and symbol-keyed
  outbound references are preserved.
- Accessor expandos cannot occupy an integer index: section 10.4.5.3 rejects
  accessors at valid integer indices, the same clause that rejects out-of-range
  numeric-index data keys in Lemma 2.
  An accessor can exist only under a non-index key, which lands last and forces
  the slow path.
  A Proxy that could synthesize index accessors fails the intrinsic brand check
  and never enters this path.
- Detached and out-of-bounds views expose no valid indexed own keys.
  If such a view has no expandos, `keys.length === 0` and the fast path correctly
  does nothing; any expando makes the last key a non-index key, forcing the slow
  path.
  Length-tracking resizable views expose their current indices at the instant
  `ownKeys` runs, and the same conjoined test applies to that snapshot, with the
  read-order argument above making concurrent growth select the slow path rather
  than mask an expando.

The proof depends on the genuine TypedArray density invariant.
The fast path must not be generalized to Arrays, whose `length` is an own
property and whose indexed elements may have holes or accessor descriptors.
Ordinary and emulated typed-array-like objects likewise retain the generic path,
including all hole and accessor traversal.

The ordering conjunct rests on engine conformance to sections 10.4.5.7 (ordering)
and 10.4.5.3 (definition rejection); the count conjunct rests only on density
(genuine TypedArrays have no index holes), which does not depend on either
clause.
Under a non-conformant engine that mis-ordered keys or admitted an out-of-range
numeric-index data property, the ordering conjunct could in principle
misclassify — but the count conjunct still catches the extra key by count, and
because the fast path requires *both*, the conjunction rejects the expando and
fails safe.
Conversely, an engine that mis-reported the intrinsic length (fooling the count)
is caught by the ordering conjunct.
This is exactly why the design conjoins the two rather than choosing one: each
conjunct is the other's engine-independent backstop, so the fast-path
classification — unlike either test alone — has no single lemma whose failure
opens it.
The file already carries a GraalJS fail-safe on the *slow* path (the per-key
`assert(desc)` in `freezeTypedArray`); the conjoined fast path extends that
belt-and-suspenders posture to the classification itself.
The residual cost is one intrinsic captured from `%TypedArray%.prototype` (the
`length` getter, a sibling of the toStringTag getter already captured for the
brand check), which is negligible against silent loss of confinement — the
weighting a security primitive should take.

Note (out of scope): whether `Object.preventExtensions` should succeed at all on
a length-tracking view over a resizable buffer (V8 allows it today, after which
growth still adds indices to a hardened array) is a pre-existing `harden`
question this design does not create and does not absorb; it belongs on its own
issue.

## Implementation and Test Plan

The change touches two near-identical copies of the hardener:
`packages/harden/make-hardener.js` and the SES copy
`packages/ses/src/make-hardener.js`, from which `packages/ses/src/lockdown.js`
builds `safeHarden`.
Both carry their own `freezeTypedArray`; the optimization does not reach the
`harden` that SES consumers actually call unless the SES copy is changed too.

The two copies are **not** identical at the exact site this change touches, and the
edit must respect that drift rather than treat the pair as one place.
The `harden`-package copy has a `traversePrototypes` option and gates its prototype
enqueue on it; the SES copy has **no** such option — `traversePrototypes` does not
appear in `packages/ses/src/make-hardener.js` at all — and its prototype enqueue is
**unconditional**, running for every object.
The fast-path edit is therefore *parallel but not character-identical*: each copy
keeps its own prototype-enqueue placement and gating, and only the own-descriptor
pass is wrapped in `!purelyIndexed` (the `harden` copy hoisting the guarded
descriptor block below its `traversePrototypes`-gated enqueue, the SES copy below
its unconditional one).
The genuinely shared parts — the `freezeTypedArray` return contract, the conjoined
count-plus-last-key test, the Lemma-2 reasoning, and the regression matrix — are
identical across the two; the surrounding control flow is copied verbatim from
*each* file, not from the other.

The two copies are expected to stay parallel indefinitely; there is no parity test
today, and this design adds a new cross-file return-value contract to the
already-duplicated pair, so a `freezeTypedArray` parity check is a candidate
follow-up rather than part of this PR.
The regression tests live in `packages/harden/test/make-hardener.test.js` and the
matching SES tests.

Drive-by (its own commit, per changeset discipline): the `freezeTypedArray`
comment (in both the `harden` and SES copies of `make-hardener.js`) says in-range
indices are "permanently writable and non-configurable"; the "non-configurable"
clause is a stale pre-ES2021 remark, since in-range indices are `configurable:
true` today.
Correct both comments in the same PR but as a separate commit from the
optimization.

Tests must cover:

- empty and large Number/BigInt TypedArrays;
- string, symbol, and accessor expandos;
- an own `length` expando;
- an index-shaped but non-canonical string expando, `"1e21"` (canonical form
  `"1e+21"`), plus `"00"` and `"1.0"`: each must classify as an expando, sort last,
  and force the slow path so its value is hardened;
- an attempt to define a *data* property at a canonical numeric index that is not a
  valid in-range index (`"1e+21"`, `"9007199254740992"`, and `"-0"`): the engine
  must reject the definition before `harden` runs, confirming Lemma 2 (`"-0"` is the
  boundary case — a CanonicalNumericIndexString whose value `-0` is not a valid
  index — and must be tested in this rejected bucket, not the definable one);
- detached and resizable-buffer views, when the runtime supports them;
- a length-tracking view over a growable `SharedArrayBuffer`: harden it, then
  `grow()` the buffer and confirm the freshly exposed indices are writable
  (documenting the pre-existing `preventExtensions`-on-length-tracking gap noted
  above, so the fast path is not blamed for it);
- `harden` idempotency: hardening an already-fast-pathed view a second time is a
  no-op and still reports purely indexed;
- a TypedArray subclass;
- a Proxy around a TypedArray;
- holey and accessor-bearing Arrays and ordinary objects (must retain the generic
  path).

The catalog above is behavior-preserving, and a hardener that never took the fast
path would pass all of it; the matrix is therefore vacuous with respect to the
optimization unless at least one case *observes the fast path engage*.
Observing it requires a test-only seam, and the seam is not a plain spy:
`make-hardener.js` captures its intrinsics (`getOwnPropertyDescriptors`,
`getOwnPropertyDescriptor`) at module load inside a closure, so a black-box test
cannot intercept the descriptor reads from outside, and "it still hardens" is
exactly the vacuous assertion.
The implementation PR should add the seam explicitly — a module-level slow-path
counter or callback that `freezeTypedArray` touches only when it does *not* take
the fast path, exported or injectable under a test build — and assert it stays at
zero when a large pure `Uint8Array` is hardened while it increments for an
expando-bearing view.
Where wiring such a seam into the hot path is judged too invasive, the fallback is
a micro-benchmark gate: the pure-view harden time must sit near the
`Reflect.ownKeys` floor rather than at the baseline descriptor-pass cost.
Either way, a test that cannot distinguish fast-path from slow-path execution does
not exercise the change.

Both `makeHardener()` and `makeHardener({ traversePrototypes: true })` must be
exercised, since the change sits on exactly that control flow.
Slow-path cases must prove that referenced data values are hardened and that
accessor expandos retain the baseline thrown outcome, not merely that the root
becomes non-extensible.
Tests that attempt to define an accessor at an in-range TypedArray index must
confirm that the engine rejects the definition before `harden` runs.
Every listed case is a deterministic assertion: the design reads the intrinsic
length and one key snapshot, each a synchronous intrinsic with no user-code
interposition, and the read-order argument makes the count conjunct's only
concurrent-mutation vector (SharedArrayBuffer growth, covered by the growable case
above) fail toward the slow path, so no individual case is flaky, and the
fast-path-engaged assertion above closes the aggregate-vacuity gap.

Add a focused benchmark comparing the current and proposed hardener on large pure
TypedArrays and on TypedArrays with one expando, run on the engines the
portability claim rests on (at minimum V8; SpiderMonkey, JavaScriptCore, XS, and
GraalJS where available in CI).
Acceptance requires a falsifiable threshold, not merely "a repeatable reduction":
the median pure-case harden time on a large dense `Uint8Array` must fall by at
least **2x** against the baseline (a smaller win does not justify a new cross-file
boolean contract plus two lemmas across the two hand-mirrored copies), with no
more than a 5% regression on the expando-bearing slow case. If the measured pure
case does not clear that 2x bar — plausible if the retained O(n) `Reflect.ownKeys`
materialization dominates on a multi-kilobyte buffer — the change is abandoned.
The benchmark report must describe the remaining O(n) `Reflect.ownKeys`
allocation so the result is not presented as an asymptotic improvement.

The achievable speedup for the pure case is bounded by the ratio of the current
per-key descriptor cost to the `Reflect.ownKeys` floor the fast path cannot go
below, and the fast path is expected to approach that floor because it does no
per-key descriptor work beyond materializing the keys.
This design deliberately states no figure: the only measurements taken so far are
single-harness estimates that have not been reproduced, so they are a measurement
result rather than design content and do not belong here as if settled.
The implementation PR must establish the ratio with committed-harness measurements
on a large dense `Uint8Array` and describe the remaining O(n) `Reflect.ownKeys`
allocation so the result is not presented as an asymptotic improvement.

## Alternatives Considered

- **Count-only cardinality-equality (the prompt's literal framing).**
  Capture the `length` getter from `%TypedArray%.prototype` at module load, read
  `apply(getTypedArrayLength, array, [])` as an O(1) indexed cardinality, and
  take purely-indexed to be `ownKeys(array).length === len` *alone*.
  This is a genuine O(1) count source, and it needs no key-form reasoning —
  cardinality equality catches an extra own key regardless of how it is spelled,
  robust even to an engine that admitted an index-shaped expando.
  Rejected *as a sole test* because it fails open under an engine that
  mis-reported the intrinsic length, with no ordering backstop.
- **Last-key ordering test alone.**
  Take purely-indexed to be `keys.length === 0 || isCanonicalIntegerIndexString(keys[keys.length - 1])`
  with no count.
  It needs no second intrinsic and no read-ordering argument, but relies wholly on
  Lemma 2 (definition-rejection) plus Lemma 1 (ordering); rejected *as a sole
  test* because it fails open under an engine that mis-ordered keys or admitted an
  out-of-range index-shaped data key.
  The design adopts the **conjunction** of these two rather than either alone: the
  count conjunct costs one extra O(1) length read over the already-materialized
  key list, a conjunction only ever classifies *fewer* views as pure (so it is
  never less safe than either conjunct), and each conjunct is the other's
  engine-independent backstop. The one captured intrinsic and the read-ordering
  argument are the price, weighed in § Correctness Argument as negligible against
  silent loss of confinement for a security primitive.
- **`TypedArray.prototype.byteLength` as the count source.**
  Rejected in favor of the direct length getter (were a count used at all)
  because it needs element-width recovery and offers no stronger guarantee.
- **`ArrayBuffer.isView`.**
  Rejected because it yields no cardinality and admits DataView.
- **A general object or Array fast path.**
  Rejected because JavaScript exposes no O(1) own-property count, and array length
  does not imply density or data-only elements.
- **An engine-specific own-property-cardinality intrinsic.**
  Deferred.
  It is the only route to a genuinely O(1) end-to-end purely indexed predicate,
  but `@endo/harden` must remain portable across V8, SpiderMonkey,
  JavaScriptCore, XS, and GraalJS.

## Open Questions

None load-bearing. An earlier revision left the mechanism as a maintainer choice
between the count-only (the prompt's literal cardinality-equality) and last-key
forms; that choice is now resolved rather than escalated. The two forms are not
exclusive — because the key list is already materialized, conjoining them costs
one extra O(1) length read and one comparison, and a conjunction is at least as
strict as either conjunct, so it can only be safer. The design therefore adopts
**both**, and the prompt's cardinality-equality shape is honored as one of the two
conjuncts rather than demoted. The only residual judgment calls are already
localized to the implementation PR: the exact acceptance threshold if measurement
lands near the 2x bar (§ Implementation and Test Plan), and whether the fast-path
observability seam is a counter or a benchmark gate.

## Prompt

> Propose a change based on `master` that avoids the linear own-keys work in
> `make-hardener` when total own-property cardinality equals indexed
> own-property cardinality, provided the latter has a genuine O(1) source.
> Establish the source and prove behavior is unchanged for expandos,
> accessors, symbols, and holes.
