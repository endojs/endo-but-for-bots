/*---
description: The %Reflect% namespace intrinsic exposes a coherent method table and prototype metadata across Hardened JavaScript hosts
features: [Reflect, Symbol.toStringTag]
---*/

// %Reflect% is a namespace object, not a constructor: it is a plain frozen
// intrinsic whose prototype is %Object.prototype% and which is not itself
// callable or constructable. Lockdown hardens it but must not tame away its
// identity, so this pins the shape that survives hardening on every host.
var metadata = [
  typeof Reflect,
  Object.getPrototypeOf(Reflect) === Object.prototype,
  Reflect[Symbol.toStringTag],
  Object.prototype.toString.call(Reflect),
].join('|');

assert.sameValue(
  metadata,
  'object|true|Reflect|[object Reflect]',
  'the %Reflect% namespace is an object rooted at %Object.prototype% tagged Reflect',
);

// The full %Reflect% method table must be present as callable own properties on
// every host. The `.name`/`.length` of each method is intentionally NOT pinned:
// XS's native lockdown blanks tamed function names, so only presence and
// callability are cross-host-stable. The list is spelled in specification order
// so a host missing any single reflective operation is caught precisely.
var methodNames = [
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
];
var methodTable = methodNames
  .map(function (name) {
    return name + ':' + typeof Reflect[name];
  })
  .join('|');

assert.sameValue(
  methodTable,
  methodNames
    .map(function (name) {
      return name + ':function';
    })
    .join('|'),
  'every %Reflect% reflective operation is present and callable',
);

// The reflective operations agree with their ordinary-object counterparts, so a
// stand-in that kept the shape but broke the behavior is caught. Each check
// exercises one operation against a fresh target built after hardening.
var target = { existing: 1 };
var behavior = [
  Reflect.has(target, 'existing'),
  Reflect.has(target, 'absent'),
  Reflect.get(target, 'existing'),
  Reflect.getPrototypeOf([]) === Array.prototype,
  Reflect.ownKeys({ a: 1, b: 2 }).join(','),
  Reflect.apply(
    function (x) {
      return this.base + x;
    },
    { base: 10 },
    [5],
  ),
  Reflect.construct(function (v) {
    this.v = v;
  }, [7]).v,
].join('|');

assert.sameValue(
  behavior,
  'true|false|1|true|a,b|15|7',
  'the %Reflect% operations behave as the reflective counterparts of the ordinary internal methods',
);

// A defineProperty/deleteProperty round-trip through %Reflect% mutates a
// post-hardening object exactly as the imperative forms would: lockdown freezes
// the intrinsics, not the objects a program later creates.
var mutable = {};
var roundTrip = [
  Reflect.defineProperty(mutable, 'k', { value: 42, configurable: true }),
  mutable.k,
  Reflect.deleteProperty(mutable, 'k'),
  Reflect.has(mutable, 'k'),
].join('|');

assert.sameValue(
  roundTrip,
  'true|42|true|false',
  'a %Reflect% defineProperty/deleteProperty round-trip mutates a post-lockdown object',
);
