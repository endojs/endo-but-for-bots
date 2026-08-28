/*---
description: The %Atomics% namespace intrinsic exposes coherent metadata and read-modify-write behavior across Hardened JavaScript hosts
features: [Atomics, Symbol.toStringTag]
---*/

// %Atomics% is a namespace object rather than a constructor. Lockdown hardens
// the intrinsic, but must preserve its identity and its ordinary prototype
// chain; each fact is pinned as its own assertion.
assert.sameValue(typeof Atomics, 'object', '%Atomics% is a namespace object');
assert.sameValue(
  Object.getPrototypeOf(Atomics),
  Object.prototype,
  '%Atomics% chains directly to %Object.prototype%',
);
assert.sameValue(
  Atomics[Symbol.toStringTag],
  'Atomics',
  '%Atomics%[Symbol.toStringTag]',
);
assert.sameValue(
  Object.prototype.toString.call(Atomics),
  '[object Atomics]',
  '%Atomics% Object.prototype.toString tag',
);

// Pin the read-modify-write and synchronization method surface every hardened
// host is expected to expose, each method as its own assertion. Method names and
// lengths are deliberately not checked because XS native lockdown may tame
// function metadata while preserving callability.
[
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
].forEach(function (name) {
  assert.sameValue(
    typeof Atomics[name],
    'function',
    '%Atomics%.' + name + ' is present and callable',
  );
});

// Read-modify-write operations work on integer typed arrays backed by a plain
// ArrayBuffer, so the behavior is observable without shared memory. The array
// is allocated after lockdown to prove hardening does not disturb the ops. Each
// operation's return value is pinned independently, in execution order, so a
// drifted operation is named precisely.
var view = new Int32Array(new ArrayBuffer(8));

Atomics.store(view, 0, 5);
assert.sameValue(
  Atomics.load(view, 0),
  5,
  '%Atomics.load% reads the value written by %Atomics.store%',
);
assert.sameValue(
  Atomics.add(view, 0, 3),
  5,
  '%Atomics.add% returns the prior value',
);
assert.sameValue(Atomics.load(view, 0), 8, '%Atomics.add% updated the cell to 8');
assert.sameValue(
  Atomics.sub(view, 0, 1),
  8,
  '%Atomics.sub% returns the prior value',
);
assert.sameValue(
  Atomics.and(view, 0, 0x0e),
  7,
  '%Atomics.and% returns the prior value',
);
assert.sameValue(
  Atomics.or(view, 0, 0x01),
  6,
  '%Atomics.or% returns the prior value',
);
assert.sameValue(
  Atomics.xor(view, 0, 0x03),
  7,
  '%Atomics.xor% returns the prior value',
);
assert.sameValue(
  Atomics.exchange(view, 0, 42),
  4,
  '%Atomics.exchange% returns the prior value',
);
assert.sameValue(
  Atomics.compareExchange(view, 0, 42, 99),
  42,
  '%Atomics.compareExchange% returns the prior value on a matching compare',
);
assert.sameValue(
  Atomics.load(view, 0),
  99,
  '%Atomics.compareExchange% stored the replacement value',
);

assert.sameValue(
  typeof Atomics.isLockFree(4),
  'boolean',
  '%Atomics.isLockFree% reports lock-freedom for a supported element size',
);
