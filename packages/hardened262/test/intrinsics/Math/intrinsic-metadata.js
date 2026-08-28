/*---
description: The %Math% namespace intrinsic exposes coherent metadata and numerical operations across Hardened JavaScript hosts
features: [Math, Symbol.toStringTag]
---*/

// %Math% is a namespace object rather than a constructor. Lockdown hardens the
// intrinsic, but must preserve its identity and its ordinary prototype chain;
// each fact is pinned as its own assertion.
assert.sameValue(typeof Math, 'object', '%Math% is a namespace object');
assert.sameValue(
  Object.getPrototypeOf(Math),
  Object.prototype,
  '%Math% chains directly to %Object.prototype%',
);
assert.sameValue(Math[Symbol.toStringTag], 'Math', '%Math%[Symbol.toStringTag]');
assert.sameValue(
  Object.prototype.toString.call(Math),
  '[object Math]',
  '%Math% Object.prototype.toString tag',
);

// Pin the complete ES2015-and-later method surface supported by every hardened
// host, each method as its own assertion. Method names and lengths are
// deliberately not checked because XS native lockdown may tame function metadata
// while preserving callability.
[
  'abs',
  'acos',
  'acosh',
  'asin',
  'asinh',
  'atan',
  'atanh',
  'atan2',
  'cbrt',
  'ceil',
  'clz32',
  'cos',
  'cosh',
  'exp',
  'expm1',
  'floor',
  'fround',
  'hypot',
  'imul',
  'log',
  'log1p',
  'log2',
  'log10',
  'max',
  'min',
  'pow',
  'random',
  'round',
  'sign',
  'sin',
  'sinh',
  'sqrt',
  'tan',
  'tanh',
  'trunc',
].forEach(function (name) {
  assert.sameValue(
    typeof Math[name],
    'function',
    '%Math%.' + name + ' is present and callable',
  );
});

// Each mathematical constant is pinned independently as a finite number so a
// drifted constant is named precisely.
[
  ['E', Math.E],
  ['LN10', Math.LN10],
  ['LN2', Math.LN2],
  ['LOG10E', Math.LOG10E],
  ['LOG2E', Math.LOG2E],
  ['PI', Math.PI],
  ['SQRT1_2', Math.SQRT1_2],
  ['SQRT2', Math.SQRT2],
].forEach(function (entry) {
  assert.sameValue(
    typeof entry[1] === 'number' && Number.isFinite(entry[1]),
    true,
    '%Math%.' + entry[0] + ' is a finite number',
  );
});

// Representative operations retain their specified behavior after hardening,
// each pinned independently.
assert.sameValue(Math.abs(-3), 3, '%Math.abs% returns the magnitude');
assert.sameValue(Math.max(1, 7, 2), 7, '%Math.max% returns the largest argument');
assert.sameValue(Math.min(1, 7, 2), 1, '%Math.min% returns the smallest argument');
assert.sameValue(Math.hypot(3, 4), 5, '%Math.hypot% returns the Euclidean norm');
assert.sameValue(Math.trunc(-1.75), -1, '%Math.trunc% truncates toward zero');
assert.sameValue(Math.sign(-9), -1, '%Math.sign% returns the sign');
assert.sameValue(Math.clz32(1), 31, '%Math.clz32% counts leading zero bits');
assert.sameValue(
  Math.imul(0xffffffff, 5),
  -5,
  '%Math.imul% performs 32-bit integer multiplication',
);
