# TypedArray Indexed-Cardinality Fast Path for `harden`

| | |
|---|---|
| **Created** | 2026-08-24 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |

## What is the Problem Being Solved?

On `master` at commit `6ee3fda77b`, `packages/harden/make-hardener.js`
special-cases genuine TypedArrays because `Object.freeze` rejects a non-empty
view. `freezeTypedArray` instead prevents extensions and walks every own key,
fetching a descriptor and redefining each non-indexed expando as readonly and
non-configurable. `baseFreezeAndTraverse` then obtains every own descriptor
again to discover outbound references.

For the common case of a dense TypedArray with no expandos, all own properties
are integer-indexed elements. Their values are necessarily Number or BigInt
primitives, and the integer-indexed exotic rules already make their
descriptors unsuitable for ordinary freezing. There is therefore no per-key
hardening or traversal work to perform. Large byte arrays nevertheless pay for
both descriptor passes today.

This proposal adds a cardinality test that recognizes that common case without
examining each key. It is independent of PR #475 and its byte-array changes;
the later implementation must branch from `master`.

## Design

### Capture the intrinsic length getter

At module initialization, obtain the `length` getter from the intrinsic
`%TypedArray%.prototype`, alongside the existing captured `@@toStringTag`
getter:

```js
const typedArrayLengthDesc = getOwnPropertyDescriptor(
  typedArrayPrototype,
  'length',
);
assert(typedArrayLengthDesc);
const getTypedArrayLength = typedArrayLengthDesc.get;
assert(getTypedArrayLength);
```

The indexed-own-property cardinality of a genuine TypedArray is then:

```js
const indexedPropertyCount = apply(getTypedArrayLength, array, []);
```

This is the concrete constant-time source. ECMA-262
§ 23.2.3.21, [get `%TypedArray%.prototype.length`](https://tc39.es/ecma262/multipage/indexed-collections.html#sec-get-%typedarray%.prototype.length),
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
`Reflect.ownKeys(array)` remains O(n). The gain is that a purely indexed view
avoids per-key descriptor reads, redefinitions, and the second descriptor
enumeration. A truly O(1) end-to-end test would require a new engine intrinsic
for own-property cardinality and is outside this portable implementation.

### Cardinality equality

After `preventExtensions(array)`, `freezeTypedArray` obtains `keys` exactly
once and compares:

```js
const keys = ownKeys(array);
const isPurelyIndexed =
  keys.length === apply(getTypedArrayLength, array, []);
```

If equal, it returns a signal to `baseFreezeAndTraverse` that the object has no
outbound references. The caller still traverses the prototype when
`traversePrototypes` is enabled, but skips `getOwnPropertyDescriptors` and its
descriptor walk for this object.

If unequal, the implementation retains the existing behavior: inspect the
captured `keys`, apply the existing descriptor rewrite to every non-indexed
expando, and traverse the resulting own descriptors. This includes preserving
the current failure behavior for an accessor expando, whose rewrite supplies
the incompatible `writable` field and throws. A small implementation may leave
the generic descriptor traversal unchanged on this slow path. A later measured
refinement may combine the TypedArray expando-freezing and traversal passes,
but that is not required for this optimization.

The fast path is restricted to values accepted by the existing intrinsic
TypedArray brand check. Arrays, DataViews, ordinary objects that imitate a
TypedArray, and Proxies around TypedArrays continue through the generic path.

## Correctness Argument

ECMA-262 § 10.4.5.7, [TypedArray `[[OwnPropertyKeys]]`](https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-typedarray-exotic-objects-ownpropertykeys),
emits every valid integer index from zero through `length - 1`, followed by
ordinary string keys and then symbol keys. Genuine in-bounds TypedArrays are
dense: they cannot have holes among those indices. Therefore their own-key
count is at least the intrinsic length, and equality holds exactly when there
are no non-indexed own properties.

That yields the behavior-preservation cases:

- A plain TypedArray has exactly `length` own keys. Skipping is safe because
  every indexed value is a primitive and the hardener deliberately leaves
  indexed descriptors writable and non-configurable.
- Any string expando, including an own shadowing `length`, increases the total
  count and selects the slow path. Data expandos are still downgraded and
  traversed; accessor expandos retain the existing thrown outcome.
- Every symbol expando also increases the total count and selects the slow
  path, so symbol-keyed outbound references are preserved.
- ECMA-262 § 10.4.5.3, [TypedArray `[[DefineOwnProperty]]`](https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-typedarray-exotic-objects-defineownproperty),
  rejects accessors at valid integer indices. Accessors can exist only under a
  non-index key, which defeats equality and preserves the existing slow-path
  outcome. A Proxy that could synthesize index accessors fails the intrinsic
  brand check and never enters this path.
- Detached and out-of-bounds views have intrinsic length zero and expose no
  valid indexed own keys. Equality is safe only when they also have no
  expandos. Length-tracking resizable views use their current intrinsic
  length; growable shared buffers can at worst cause a conservative mismatch
  between the two snapshots, selecting the slow path rather than hiding an
  expando.

The proof depends on the genuine TypedArray density invariant. It must not be
generalized to Arrays, whose `length` is an own property and whose indexed
elements may have holes or accessor descriptors. Ordinary and emulated
typed-array-like objects likewise retain the generic path, including all hole
and accessor traversal.

## Implementation and Test Plan

The implementation is a localized `packages/harden/make-hardener.js` change
with regression coverage in `packages/harden/test/make-hardener.test.js` and,
where intrinsic-brand helpers are shared, the matching SES tests.

Tests must cover empty and large Number/BigInt TypedArrays; string, symbol, and
accessor expandos; an own `length` expando; detached and resizable-buffer views
when the runtime supports them; a TypedArray subclass; a Proxy around a
TypedArray; and holey/accessor-bearing Arrays and ordinary objects. Slow-path
cases must prove that referenced data values are hardened and that accessor
expandos retain the baseline thrown outcome, not merely that the root becomes
non-extensible. Tests that attempt to define an accessor at an in-range
TypedArray index must confirm that the engine rejects the definition before
`harden` runs.

Add a focused benchmark comparing the current and proposed hardener on large
pure TypedArrays and on TypedArrays with one expando. Acceptance requires a
repeatable reduction for the pure case without a material regression for the
slow case. The benchmark report must describe the remaining O(n)
`Reflect.ownKeys` allocation so the result is not presented as an asymptotic
improvement.

## Alternatives Considered

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
