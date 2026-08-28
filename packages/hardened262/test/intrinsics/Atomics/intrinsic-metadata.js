/*---
description: The %Atomics% namespace intrinsic exposes coherent metadata and read-modify-write behavior across Hardened JavaScript hosts
features: [Atomics, Symbol.toStringTag]
---*/

// %Atomics% is a namespace object rather than a constructor. Lockdown hardens
// the intrinsic, but must preserve its identity and its ordinary prototype
// chain.
var metadata = [
  typeof Atomics,
  Object.getPrototypeOf(Atomics) === Object.prototype,
  Atomics[Symbol.toStringTag],
  Object.prototype.toString.call(Atomics),
].join('|');

assert.sameValue(
  metadata,
  'object|true|Atomics|[object Atomics]',
  'the %Atomics% namespace is an object rooted at %Object.prototype% tagged Atomics',
);

// Pin the read-modify-write and synchronization method surface every hardened
// host is expected to expose. Method names and lengths are deliberately not
// checked because XS native lockdown may tame function metadata while
// preserving callability.
var methodNames = [
  'add',
  'and',
  'compareExchange',
  'exchange',
  'isLockFree',
  'load',
  'or',
  'store',
  'sub',
  'wait',
  'notify',
  'xor',
];
var methodTable = methodNames
  .map(function (name) {
    return name + ':' + typeof Atomics[name];
  })
  .join('|');

assert.sameValue(
  methodTable,
  methodNames
    .map(function (name) {
      return name + ':function';
    })
    .join('|'),
  'every %Atomics% operation is present and callable',
);

// Read-modify-write operations work on integer typed arrays backed by a plain
// ArrayBuffer, so the behavior is observable without shared memory. The array
// is allocated after lockdown to prove hardening does not disturb the ops.
var view = new Int32Array(new ArrayBuffer(8));

Atomics.store(view, 0, 5);
var behavior = [
  Atomics.load(view, 0),
  Atomics.add(view, 0, 3),
  Atomics.load(view, 0),
  Atomics.sub(view, 0, 1),
  Atomics.and(view, 0, 0x0e),
  Atomics.or(view, 0, 0x01),
  Atomics.xor(view, 0, 0x03),
  Atomics.exchange(view, 0, 42),
  Atomics.compareExchange(view, 0, 42, 99),
  Atomics.load(view, 0),
].join('|');

assert.sameValue(
  behavior,
  '5|5|8|8|7|6|7|4|42|99',
  'representative %Atomics% read-modify-write operations retain their specified behavior after hardening',
);

assert.sameValue(
  typeof Atomics.isLockFree(4),
  'boolean',
  '%Atomics.isLockFree% reports lock-freedom for a supported element size',
);
