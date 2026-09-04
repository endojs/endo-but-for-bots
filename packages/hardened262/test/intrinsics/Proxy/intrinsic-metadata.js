/*---
description: The %Proxy% constructor intrinsic exposes coherent metadata and a working trap surface across Hardened JavaScript hosts
features: [Proxy, Reflect]
---*/

// %Proxy% is an exotic constructor with two spec-mandated peculiarities that
// survive hardening on every host: it is callable-as-constructor yet has NO
// `.prototype` own property, and it carries a `revocable` static factory. The
// `.name`/`.length` are intentionally NOT pinned here: XS's native lockdown
// blanks tamed constructor names, so only the structural facts are
// cross-host-stable, and each is pinned as its own assertion.
assert.sameValue(typeof Proxy, 'function', '%Proxy% is a constructor');
assert.sameValue(
  Object.prototype.hasOwnProperty.call(Proxy, 'prototype'),
  false,
  '%Proxy% has no own prototype property',
);
assert.sameValue(
  Proxy.prototype,
  undefined,
  '%Proxy%.prototype is absent',
);
assert.sameValue(
  typeof Proxy.revocable,
  'function',
  '%Proxy.revocable% is a callable static factory',
);

// A proxy with an empty handler is fully transparent: every internal method
// forwards to the target. This pins that hardening did not replace %Proxy% with
// a stand-in that breaks transparent forwarding, each forwarded operation
// asserted independently.
var target = { a: 1 };
var transparent = new Proxy(target, {});
assert.sameValue(
  transparent.a,
  1,
  'an empty-handler %Proxy% forwards property reads to its target',
);
assert.sameValue(
  'a' in transparent,
  true,
  'an empty-handler %Proxy% forwards the has trap to its target',
);
assert.sameValue(
  Object.getPrototypeOf(transparent),
  Object.prototype,
  "an empty-handler %Proxy% forwards getPrototypeOf to its target's prototype",
);

// A get trap intercepts property access and receives (target, key, receiver),
// and %Reflect.get% is the canonical way to complete the default behavior from
// inside a trap — exercising the %Proxy%/%Reflect% pairing that both intrinsics
// are designed around. The intercepted and deferred paths are pinned separately.
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
assert.sameValue(
  trapped.intercepted,
  'trap',
  'a %Proxy% get trap intercepts property access',
);
assert.sameValue(
  trapped.real,
  'value',
  'a %Proxy% get trap can defer to %Reflect.get% for the default behavior',
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
