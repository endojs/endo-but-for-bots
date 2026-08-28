/*---
description: The %Math% namespace intrinsic exposes coherent metadata and numerical operations across Hardened JavaScript hosts
features: [Math, Symbol.toStringTag]
---*/

// %Math% is a namespace object rather than a constructor. Lockdown hardens the
// intrinsic, but must preserve its identity and its ordinary prototype chain.
var metadata = [
  typeof Math,
  Object.getPrototypeOf(Math) === Object.prototype,
  Math[Symbol.toStringTag],
  Object.prototype.toString.call(Math),
].join('|');

assert.sameValue(
  metadata,
  'object|true|Math|[object Math]',
  'the %Math% namespace is an object rooted at %Object.prototype% tagged Math',
);

// Pin the complete ES2015-and-later method surface supported by every hardened
// host. Method names and lengths are deliberately not checked because XS native
// lockdown may tame function metadata while preserving callability.
var methodNames = [
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
];
var methodTable = methodNames
  .map(function (name) {
    return name + ':' + typeof Math[name];
  })
  .join('|');

assert.sameValue(
  methodTable,
  methodNames
    .map(function (name) {
      return name + ':function';
    })
    .join('|'),
  'every %Math% numerical operation is present and callable',
);

var constants = [
  Math.E,
  Math.LN10,
  Math.LN2,
  Math.LOG10E,
  Math.LOG2E,
  Math.PI,
  Math.SQRT1_2,
  Math.SQRT2,
];
assert.sameValue(
  constants.every(function (value) {
    return typeof value === 'number' && Number.isFinite(value);
  }),
  true,
  'every %Math% mathematical constant is a finite number',
);

var behavior = [
  Math.abs(-3),
  Math.max(1, 7, 2),
  Math.min(1, 7, 2),
  Math.hypot(3, 4),
  Math.trunc(-1.75),
  Math.sign(-9),
  Math.clz32(1),
  Math.imul(0xffffffff, 5),
].join('|');

assert.sameValue(
  behavior,
  '3|7|1|5|-1|-1|31|-5',
  'representative %Math% operations retain their specified behavior after hardening',
);
