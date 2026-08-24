# Purely Indexed TypedArray Fast Path for `harden`

| | |
|---|---|
| **Created** | 2026-08-24 |
| **Updated** | 2026-08-24 |
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

For the common case of a *dense* TypedArray — one whose valid indices zero
through `length - 1` are all present, with no holes — carrying no expandos, all
own properties are integer-indexed elements.
Their values are necessarily Number or BigInt primitives, and the
integer-indexed exotic rules already fix their descriptors, so there is no
per-key hardening or traversal work to perform.
Large byte arrays nevertheless pay for both descriptor passes today.

The prompt (reproduced verbatim at the end) asks for a change based on `master`
that avoids the linear own-keys work when total own-property cardinality equals
indexed own-property cardinality, provided the indexed count has a genuine O(1)
source, and that proves behavior unchanged for expandos, accessors, symbols, and
holes.
The ask as literally posed is not portably achievable: no standard JavaScript
operation reveals total own-property cardinality in O(1), so the linear
`Reflect.ownKeys` materialization cannot be removed without a new engine
intrinsic (see *Alternatives Considered*).
This design delivers the closest portable thing: it keeps the one O(n)
`Reflect.ownKeys` allocation but removes both O(n) *descriptor* passes for the
pure case.

The cardinality-equality condition is nonetheless the right condition — it holds
precisely when the view is purely indexed — but it need not be decided by
counting.
Section 10.4.5.7 of ECMA-262 orders all integer indices of a TypedArray before
any string or symbol key, and a genuine in-bounds TypedArray is dense, so a
single `Reflect.ownKeys` result already answers the question at one instant: the
view is purely indexed exactly when its **last own key is a canonical integer
index** (or it has no own keys at all).
This design adopts that single-instant ordering test as its primary mechanism.
The equivalent counting formulation, which reads an O(1) intrinsic length as the
prompt's literal framing suggests, is retained under *Alternatives Considered* as
a behaviorally identical variant that trades a different lemma (see there, and
*Open Questions*, for the tradeoff).

Materializing the own keys still costs one O(n) `Reflect.ownKeys` allocation:
the tension the prompt names.
This is a reduction in constant-factor work (two descriptor passes down to none
for the pure case), not an asymptotic change, and the design claims no more than
that.

This proposal is independent of
[PR #475](https://github.com/endojs/endo/pull/475) and its byte-array changes;
the later implementation must branch from `master` (the release line PR #475 also
targets), not from the `endo-but-for-bots` `llm` line where most designs land.

## Design

The fast path is restricted to values accepted by the existing intrinsic
TypedArray brand check.
Arrays, DataViews, ordinary objects that imitate a TypedArray, and Proxies around
TypedArrays continue through the generic path.

### The purely indexed decision

`freezeTypedArray` materializes the own keys once and tests whether the last one
is a canonical integer index, reusing `isCanonicalIntegerIndexString`, which the
file already defines (`packages/harden/make-hardener.js:282`):

```js
/**
 * @template {TypedArray} T
 * @param {T} array a genuine (brand-checked) TypedArray
 * @returns {boolean} true when the view is purely indexed, so the caller may
 *   skip its own-descriptor traversal for this object
 */
const freezeTypedArray = array => {
  preventExtensions(array);
  const keys = ownKeys(array);
  const purelyIndexed =
    keys.length === 0 ||
    isCanonicalIntegerIndexString(keys[keys.length - 1]);
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
`baseFreezeAndTraverse` today runs
(`packages/harden/make-hardener.js:375-385`):

```js
if (isTypedArray(obj)) {
  freezeTypedArray(obj);
} else {
  freeze(obj);
}
// ...then, unconditionally, the second descriptor pass:
const descs = getOwnPropertyDescriptors(obj);
arrayForEach(ownKeys(descs), key => enqueueOutboundReferences(descs[key]));
```

and becomes:

```js
let purelyIndexed = false;
if (isTypedArray(obj)) {
  purelyIndexed = freezeTypedArray(obj);
} else {
  freeze(obj);
}
if (!purelyIndexed) {
  const descs = getOwnPropertyDescriptors(obj);
  arrayForEach(ownKeys(descs), key => enqueueOutboundReferences(descs[key]));
}
// prototype enqueue under `traversePrototypes` is unchanged and runs in both
// arms.
```

The polarity is deliberately `purelyIndexed`, not `hasExpandos`: the falsy
default is the *fail-safe* one.
The flag is threaded out of only one arm of the `if`/`else`, the `else` arm
produces no assignment, and the SES copy is a hand-mirrored edit; a missed
assignment, an unset `let`, or a botched mirror therefore leaves `purelyIndexed`
false and runs the full descriptor traversal.
The dangerous direction — skipping traversal for an object that has outbound
references — is reachable only by an explicit `true`, never by omission.

The returned value is named for the fact the caller consumes.
The classification the helper computes ("no non-index own key") and the fact the
caller needs ("no own outbound reference") coincide only through a lemma stated
in the *Correctness Argument*: on a genuine dense TypedArray every own key is
either a primitive-valued index or a downgraded expando, so a purely indexed
view has no own outbound reference at all.

The boolean is deliberately not the list of keys, but the reason is minimality,
not a descriptor-skew defense.
An earlier draft justified the boolean by claiming that handing the key list back
would let a later refinement feed it into `getOwnPropertyDescriptors` and
reintroduce the GraalJS skew (below) that the per-key `getOwnPropertyDescriptor`
re-derivation defends against.
That rationale does not hold: `baseFreezeAndTraverse` already calls bulk
`getOwnPropertyDescriptors(obj)` unconditionally on the traversal
(`packages/harden/make-hardener.js:385`; SES copy
`packages/ses/src/make-hardener.js:193`), so the caller already lives with that
call and returning keys would not introduce it.
The real reason to return a boolean is minimality: the caller consumes one bit,
so the interface hands back one bit and nothing that invites a future caller to
re-walk descriptors a third way.

The GraalJS skew named above is a known non-conformance the file already guards:
on GraalJS, `Object.getOwnPropertyDescriptor` can return `undefined` for a
property that `Reflect.ownKeys` reports as present
(`packages/harden/make-hardener.js:296`), so the slow path re-derives each
descriptor per key and asserts it rather than trusting a bulk snapshot.
This design leaves that guard and its slow-path traversal untouched.

Combining the expando-freezing pass and the outbound-reference traversal into a
single descriptor walk on the slow path is a possible later refinement, but it is
out of scope here: the slow path is unchanged from today and does not depend on
this optimization.

Why the last key alone decides it: ECMA-262 section 10.4.5.7,
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
This is an O(1) decision over the already-materialized key list: the win is not
"examine no keys"; it is "read no descriptors".

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

The decision reads a single `Reflect.ownKeys` snapshot.
`[[OwnPropertyKeys]]` is one synchronous internal operation with no user-code
interposition point (the brand check excludes Proxies, whose traps could
otherwise run), so the returned list is a single-instant view of the object's
keys.
There is no second read to race against and no ordering to prove
skew-conservative; the design reasons about exactly one key list.

Two lemmas make the last-key test exact.

**Lemma 1 (ordering).**
By section 10.4.5.7, an expando — any non-index own key — sorts after every
integer index, so if the last own key is a canonical integer index the view
carries no expando.

**Lemma 2 (no index-shaped expando survives definition).**
The last-key test would be unsafe if a view could carry an own key that both *is*
a canonical integer index string and *is not* a live element, because such a key
would pass `isCanonicalIntegerIndexString` yet name an expando.
`isCanonicalIntegerIndexString` (`packages/harden/make-hardener.js:282`) is
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
throws a `TypeError` for each of `"1e+21"`, `"9007199254740992"`, `"-1"`, and
`"100"` (on a length-4 view), while the near-index strings `"00"`, `"1.0"`,
`"-0"`, and `"1e21"` are ordinary string keys that *are* definable and for which
`isCanonicalIntegerIndexString` correctly returns `false` (`"1e21"` is not
canonical — its canonical form is `"1e+21"`).
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
  `ownKeys` runs, and the same last-key test applies to that snapshot.

The proof depends on the genuine TypedArray density invariant.
The fast path must not be generalized to Arrays, whose `length` is an own
property and whose indexed elements may have holes or accessor descriptors.
Ordinary and emulated typed-array-like objects likewise retain the generic path,
including all hole and accessor traversal.

Both lemmas rest on engine conformance to sections 10.4.5.7 (ordering) and
10.4.5.3 (definition rejection).
Under a non-conformant engine that mis-ordered keys or admitted an out-of-range
numeric-index data property, the last-key test could in principle misclassify,
whereas the cardinality-equality form (*Alternatives Considered*) would still
catch the extra key by count.
This is the one respect in which the two forms are *not* interchangeable, and it
is why the equivalence claim in *Alternatives Considered* is scoped to conformant
engines.
The file already carries a GraalJS fail-safe on the *slow* path
(`packages/harden/make-hardener.js:296`), but neither form's *fast*-path
classification has an engine-independent backstop; the design accepts that for
the adopted form on the ground that TypedArray key ordering and index-definition
rejection are among the most uniformly implemented exotic behaviors, and it flags
the divergence as the substance of the open question.

Note (out of scope): whether `Object.preventExtensions` should succeed at all on
a length-tracking view over a resizable buffer (V8 allows it today, after which
growth still adds indices to a hardened array) is a pre-existing `harden`
question this design does not create and does not absorb; it belongs on its own
issue.

## Implementation and Test Plan

The change touches two near-identical copies of the hardener that must move in
lockstep: `packages/harden/make-hardener.js` and the SES copy
`packages/ses/src/make-hardener.js`, from which `packages/ses/src/lockdown.js`
builds `safeHarden`.
Both carry their own `freezeTypedArray`; the optimization does not reach the
`harden` that SES consumers actually call unless the SES copy is changed too.
The two copies are expected to stay parallel indefinitely; there is no parity
test today, and this design adds one new cross-file return-value contract to the
already-duplicated pair, so a `freezeTypedArray` parity check is a candidate
follow-up rather than part of this PR.
Because the single-instant test has no read-ordering to get wrong, there is no
race-dependent invariant to keep aligned by hand across the two copies: the
decision is a one-line last-key test in each.
Both get the same edit, the same proof, and the same regression matrix.
The regression tests live in `packages/harden/test/make-hardener.test.js` and the
matching SES tests.

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
- an index-shaped but non-canonical string expando, `"1e21"` (canonical form
  `"1e+21"`), plus `"00"`, `"1.0"`, and `"-0"`: each must classify as an expando,
  sort last, and force the slow path so its value is hardened;
- an attempt to define a *data* property at an out-of-range canonical numeric
  index (`"1e+21"`, `"9007199254740992"`): the engine must reject the definition
  before `harden` runs, confirming Lemma 2;
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
Add an instrumented assertion — a counter or a spy on the descriptor-reading path
— that fails if a large pure `Uint8Array` is hardened via the slow path, so a
regression that silently disables the fast path is caught.

Both `makeHardener()` and `makeHardener({ traversePrototypes: true })` must be
exercised, since the change sits on exactly that control flow.
Slow-path cases must prove that referenced data values are hardened and that
accessor expandos retain the baseline thrown outcome, not merely that the root
becomes non-extensible.
Tests that attempt to define an accessor at an in-range TypedArray index must
confirm that the engine rejects the definition before `harden` runs.
Every listed case is a deterministic single-instant assertion: because the design
reads one key snapshot and never a second, there is no concurrent-mutation timing
to reproduce, so no individual case is flaky, and the fast-path-engaged assertion
above closes the aggregate-vacuity gap.

Add a focused benchmark comparing the current and proposed hardener on large pure
TypedArrays and on TypedArrays with one expando, run on the engines the
portability claim rests on (at minimum V8; SpiderMonkey, JavaScriptCore, XS, and
GraalJS where available in CI).
Acceptance requires a repeatable reduction for the pure case without a material
regression for the slow case.
The benchmark report must describe the remaining O(n) `Reflect.ownKeys`
allocation so the result is not presented as an asymptotic improvement.

On a 64 KiB `Uint8Array` (Node v22, median of 60 runs) an early harness measured
the current hardener at roughly 15 ms and a bare `Reflect.ownKeys(array)` at
roughly 3.5 ms.
These figures are preliminary single-harness estimates, not yet reproduced, and
the implementation PR must replace them with committed-harness measurements.
Since the fast path cannot go below that `ownKeys` floor, the achievable speedup
is bounded by the ratio of baseline to floor, about 4.3x (15 / 3.5), and the fast
path is expected to approach the floor because it does no per-key descriptor work
beyond materializing the keys.

## Alternatives Considered

- **Cardinality-equality via a captured intrinsic length getter.**
  Capture the `length` getter from `%TypedArray%.prototype` at module load, read
  `apply(getTypedArrayLength, array, [])` as an O(1) indexed cardinality, and
  compare it against `ownKeys(array).length`.
  This is the prompt's literal framing: a genuine O(1) *count* source, with
  equality recognizing the no-expando case.
  It is behaviorally equivalent to the adopted last-key test on conformant
  engines, but the two forms rest on *different* lemmas rather than one being
  uniformly heavier.
  The counting form needs no key-form reasoning at all — cardinality equality
  catches an extra own key regardless of how it is spelled, so it is robust even
  to an engine that admitted an index-shaped expando — but it adds a second
  captured intrinsic to `harden`'s trusted base and, because the count and the
  key list are two independent reads of a possibly growable view, its safety
  rests on a read-ordering argument (read the length first, so concurrent growth
  of a growable `SharedArrayBuffer` can only inflate the key count and select the
  slow path, never mask an expando).
  The adopted last-key form needs neither the second intrinsic nor the
  read-ordering argument, but in exchange it relies on Lemma 2
  (definition-rejection) to rule out an index-shaped expando, which the counting
  form does not need.
  The design prefers the last-key form for its smaller trusted-base surface and
  single-instant reasoning, and treats the choice between "one ordering-plus-
  definition lemma" and "one counting lemma plus a captured intrinsic" as the
  open question below.
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

- **Last-key ordering test versus cardinality-equality.**
  This revision adopts the single-instant last-key ordering test and demotes the
  prompt's literal cardinality-equality-with-O(1)-length-source formulation to
  *Alternatives Considered*.
  The two are behaviorally equivalent on conformant engines but rest on different
  lemmas (see there): the adopted form trades a captured intrinsic and a two-read
  race for reliance on the definition-rejection lemma (Lemma 2), while the
  counting form catches an extra own key of any spelling by count.
  The prompt asked specifically for the cardinality-equality shape.
  Confirm the last-key form, or revert to the counting form — in which case
  Lemma 2 is replaced by the read-ordering proof and a captured `length` getter
  is added to the trusted base.

## Prompt

> Propose a change based on `master` that avoids the linear own-keys work in
> `make-hardener` when total own-property cardinality equals indexed
> own-property cardinality, provided the latter has a genuine O(1) source.
> Establish the source and prove behavior is unchanged for expandos,
> accessors, symbols, and holes.
