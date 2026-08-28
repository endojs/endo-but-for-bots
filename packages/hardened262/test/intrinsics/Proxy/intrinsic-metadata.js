/*---
description: The %Proxy% constructor intrinsic exposes coherent metadata and a working trap surface across Hardened JavaScript hosts
features: [Proxy, Reflect]
---*/

// %Proxy% is an exotic constructor with two spec-mandated peculiarities that
// survive hardening on every host: it is callable-as-constructor yet has NO
// `.prototype` own property, and it carries a `revocable` static factory. The
// `.name`/`.length` are intentionally NOT pinned here: XS's native lockdown
// blanks tamed constructor names, so only the structural facts are
// cross-host-stable.
var metadata = [
  typeof Proxy,
  Object.prototype.hasOwnProperty.call(Proxy, 'prototype'),
  Proxy.prototype === undefined,
  typeof Proxy.revocable,
].join('|');

assert.sameValue(
  metadata,
  'function|false|true|function',
  'the %Proxy% intrinsic is a constructor with no prototype property and a revocable factory',
);

// A proxy with an empty handler is fully transparent: every internal method
// forwards to the target. This pins that hardening did not replace %Proxy% with
// a stand-in that breaks transparent forwarding.
var target = { a: 1 };
var transparent = new Proxy(target, {});
var forwarding = [
  transparent.a,
  'a' in transparent,
  Object.getPrototypeOf(transparent) === Object.prototype,
].join('|');

assert.sameValue(
  forwarding,
  '1|true|true',
  'an empty-handler %Proxy% forwards every internal method to its target',
);

// A get trap intercepts property access and receives (target, key, receiver),
// and %Reflect.get% is the canonical way to complete the default behavior from
// inside a trap — exercising the %Proxy%/%Reflect% pairing that both intrinsics
// are designed around.
var trapped = new Proxy(
  { real: 'value' },
  {
    get: function (t, key, receiver) {
      if (key === 'intercepted') {
        return 'trap';
      }
      return Reflect.get(t, key, receiver);
    },
  },
);
var trapping = [trapped.intercepted, trapped.real].join('|');

assert.sameValue(
  trapping,
  'trap|value',
  'a %Proxy% get trap intercepts and can defer to %Reflect.get%',
);

// %Proxy.revocable% yields a { proxy, revoke } pair; after revoke() every
// operation on the proxy throws a TypeError. This pins the revocation semantics
// end to end on every host.
var revocable = Proxy.revocable({ x: 1 }, {});
assert.sameValue(revocable.proxy.x, 1, 'a revocable proxy works before revocation');
assert.sameValue(
  typeof revocable.revoke,
  'function',
  'a revocable proxy exposes a revoke function',
);
revocable.revoke();
assert.throws(
  TypeError,
  function () {
    return revocable.proxy.x;
  },
  'a revoked proxy throws a TypeError on any access',
);
