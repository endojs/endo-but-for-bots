/*---
description: The %Reflect% namespace intrinsic exposes a coherent method table and prototype metadata across Hardened JavaScript hosts
features: [Reflect, Symbol.toStringTag]
---*/

// %Reflect% is a namespace object, not a constructor: it is a plain intrinsic
// whose prototype is %Object.prototype% and which is not itself callable or
// constructable. Lockdown hardens it but must not tame away its identity, so each
// fact that survives hardening on every host is pinned as its own assertion.
// Frozenness is intentionally NOT pinned: these tests also run in the pre-lockdown
// `module` scenario, where the intrinsic is not yet frozen, so only the identity
// facts that hold with and without lockdown are asserted here.
assert.sameValue(typeof Reflect, 'object', '%Reflect% is a namespace object');
assert.sameValue(
  Object.getPrototypeOf(Reflect),
  Object.prototype,
  '%Reflect% chains directly to %Object.prototype%',
);
assert.sameValue(
  Reflect[Symbol.toStringTag],
  'Reflect',
  '%Reflect%[Symbol.toStringTag]',
);
assert.sameValue(
  Object.prototype.toString.call(Reflect),
  '[object Reflect]',
  '%Reflect% Object.prototype.toString tag',
);
assert.throws(
  TypeError,
  function () {
    Reflect();
  },
  '%Reflect% is not callable',
);
assert.throws(
  TypeError,
  function () {
    return new Reflect();
  },
  '%Reflect% is not constructable',
);

// The full %Reflect% method table must be present as callable own properties on
// every host, each pinned by its own assertion so a host missing any single
// reflective operation is named precisely. The `.name`/`.length` of each method
// is intentionally NOT pinned: XS's native lockdown blanks tamed function names,
// so only presence and callability are cross-host-stable. The list is spelled in
// specification order.
[
  'apply',
  'construct',
  'defineProperty',
  'deleteProperty',
  'get',
  'getOwnPropertyDescriptor',
  'getPrototypeOf',
  'has',
  'isExtensible',
  'ownKeys',
  'preventExtensions',
  'set',
  'setPrototypeOf',
].forEach(function (name) {
  assert.sameValue(
    typeof Reflect[name],
    'function',
    '%Reflect%.' + name + ' is present and callable',
  );
});

// The reflective operations agree with their ordinary-object counterparts, so a
// stand-in that kept the shape but broke the behavior is caught. Each check
// exercises one operation against a fresh target built after hardening and is
// pinned independently.
var target = { existing: 1 };
assert.sameValue(
  Reflect.has(target, 'existing'),
  true,
  '%Reflect.has% reports a present property',
);
assert.sameValue(
  Reflect.has(target, 'absent'),
  false,
  '%Reflect.has% reports an absent property',
);
assert.sameValue(
  Reflect.get(target, 'existing'),
  1,
  '%Reflect.get% reads a property value',
);
assert.sameValue(
  Reflect.getPrototypeOf([]),
  Array.prototype,
  '%Reflect.getPrototypeOf% returns the ordinary prototype',
);
assert.sameValue(
  Reflect.ownKeys({ a: 1, b: 2 }).join(','),
  'a,b',
  '%Reflect.ownKeys% enumerates own keys in order',
);
assert.sameValue(
  Reflect.apply(
    function (x) {
      return this.base + x;
    },
    { base: 10 },
    [5],
  ),
  15,
  '%Reflect.apply% invokes with the given this and argument list',
);
assert.sameValue(
  Reflect.construct(function (v) {
    this.v = v;
  }, [7]).v,
  7,
  '%Reflect.construct% constructs with the given argument list',
);

// A defineProperty/deleteProperty round-trip through %Reflect% mutates a
// post-hardening object exactly as the imperative forms would: lockdown freezes
// the intrinsics, not the objects a program later creates. Each step of the
// round-trip is pinned independently.
var mutable = {};
assert.sameValue(
  Reflect.defineProperty(mutable, 'k', { value: 42, configurable: true }),
  true,
  '%Reflect.defineProperty% reports success on a post-lockdown object',
);
assert.sameValue(mutable.k, 42, '%Reflect.defineProperty% installs the value');
assert.sameValue(
  Reflect.deleteProperty(mutable, 'k'),
  true,
  '%Reflect.deleteProperty% reports success',
);
assert.sameValue(
  Reflect.has(mutable, 'k'),
  false,
  '%Reflect.deleteProperty% removes the property',
);
