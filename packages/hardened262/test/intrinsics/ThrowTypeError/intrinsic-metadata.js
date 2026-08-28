/*---
description: The %ThrowTypeError% intrinsic is a single shared, frozen poison-pill accessor across Hardened JavaScript hosts
features: [caller]
flags: [onlyStrict]
---*/

// %ThrowTypeError% is a well-known intrinsic that no host exposes as a global:
// it is the shared accessor installed as the get/set pair of the poison-pill
// `callee` property on every strict-mode arguments object (and, where the host
// keeps them, of Function.prototype's `caller`/`arguments`). Reaching it through
// a strict arguments object is the one route that survives on every host: the
// SES shim's lockdown deletes Function.prototype.caller/arguments as unpermitted
// intrinsics, but the strict `callee` poison pill is mandated by the language
// and left in place, so XS native lockdown and the SES shim agree here.
function makeArguments() {
  return arguments;
}

var calleeDescriptor = Object.getOwnPropertyDescriptor(makeArguments(), 'callee');
var ThrowTypeError = calleeDescriptor.get;

// A single accessor object is installed as both the getter and the setter. It
// is an anonymous zero-length function whose [[Prototype]] is %Function.prototype%
// from creation, and it is frozen by the language itself — base ECMA-262 builds
// %ThrowTypeError% as a non-extensible function with non-configurable `length`
// and `name` (§10.2.4.1), independent of SES lockdown. This test therefore pins
// that hardening does not perturb that pre-existing invariant, rather than that
// hardening establishes it. It has no own `prototype` property (a non-constructible
// built-in, unlike an ordinary function expression), and the `callee` accessor
// property itself is non-configurable and non-enumerable so the poison pill cannot
// be deleted or enumerated away per arguments object. Every value is pinned in one
// string so a host that disagrees on any one field is caught.
var metadata = [
  typeof ThrowTypeError,
  ThrowTypeError.name,
  ThrowTypeError.length,
  calleeDescriptor.get === calleeDescriptor.set,
  Object.getPrototypeOf(ThrowTypeError) === Function.prototype,
  Object.isFrozen(ThrowTypeError),
  Object.prototype.hasOwnProperty.call(ThrowTypeError, 'prototype'),
  calleeDescriptor.configurable,
  calleeDescriptor.enumerable,
].join('|');

assert.sameValue(
  metadata,
  'function||0|true|true|true|false|false|false',
  'the %ThrowTypeError% intrinsic is a frozen, zero-length, anonymous, prototype-less function shared by the non-configurable, non-enumerable callee poison pill get/set pair',
);

// The defining behavior: reading or writing the poison pill throws a TypeError,
// through either the `callee` accessor or a direct call of the intrinsic.
assert.throws(
  TypeError,
  function () {
    return calleeDescriptor.get.call({});
  },
  'invoking %ThrowTypeError% as a getter throws a TypeError',
);
assert.throws(
  TypeError,
  function () {
    return calleeDescriptor.set.call({}, 0);
  },
  'invoking %ThrowTypeError% as a setter throws a TypeError',
);

// %ThrowTypeError% is a single shared intrinsic: distinct strict arguments
// objects — including one with a different argument count — resolve to the very
// same accessor, so a host that minted a fresh poison pill per call would be
// caught.
var otherCalleeDescriptor = Object.getOwnPropertyDescriptor(
  makeArguments(1, 2, 3),
  'callee',
);
assert.sameValue(
  otherCalleeDescriptor.get,
  ThrowTypeError,
  'every strict-mode arguments object shares one %ThrowTypeError%',
);

// Where a host retains the Function.prototype `caller`/`arguments` poison pills
// (every non-lockdown host, and XS's native lockdown), they too must be the
// same %ThrowTypeError% used for the same get and set slots. The SES shim's
// lockdown removes these accessors entirely, so this cross-route invariant is
// pinned only where the accessors survive rather than forced everywhere.
var callerDescriptor = Object.getOwnPropertyDescriptor(
  Function.prototype,
  'caller',
);
if (callerDescriptor !== undefined) {
  var argumentsDescriptor = Object.getOwnPropertyDescriptor(
    Function.prototype,
    'arguments',
  );
  assert.sameValue(
    callerDescriptor.get,
    ThrowTypeError,
    'Function.prototype.caller reuses the %ThrowTypeError% intrinsic',
  );
  assert.sameValue(
    callerDescriptor.get,
    callerDescriptor.set,
    'Function.prototype.caller uses one accessor for get and set',
  );
  assert.sameValue(
    argumentsDescriptor.get,
    ThrowTypeError,
    'Function.prototype.arguments reuses the %ThrowTypeError% intrinsic',
  );
  assert.sameValue(
    argumentsDescriptor.get,
    argumentsDescriptor.set,
    'Function.prototype.arguments uses one accessor for get and set',
  );
}
