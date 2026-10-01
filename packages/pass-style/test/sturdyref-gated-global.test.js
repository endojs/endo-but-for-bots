import test from '@endo/ses-ava/test.js';

const { create, defineProperty, freeze } = Object;

// Each case installs a frozen constructor whose `isSturdyRef` vouches for
// everything, and breaks exactly one of the other conditions pass-style
// requires before it trusts the global. Pass-style captures the first global
// it trusts for the life of its module, so each case asks a fresh instance of
// the module, and a case that is wrongly trusted cannot hide the others.
let instance = 0;

/**
 * @param {(impostor: any) => void} [breakIt]
 * @param {object} [options]
 * @param {boolean} [options.freezeCheck]
 * @param {boolean} [options.freezePrototype]
 */
const makeImpostor = (
  breakIt = () => {},
  { freezeCheck = true, freezePrototype = true } = {},
) => {
  const impostor = function SturdyRef() {};
  impostor.isSturdyRef = () => true;
  defineProperty(impostor.prototype, Symbol.toStringTag, {
    value: 'SturdyRef',
  });
  breakIt(impostor);
  if (freezeCheck) freeze(impostor.isSturdyRef);
  if (freezePrototype && impostor.prototype) freeze(impostor.prototype);
  return freeze(impostor);
};

/**
 * @param {any} impostor
 */
const isTrusted = async impostor => {
  instance += 1;
  const { isSturdyRefObject } = await import(
    `../src/sturdyref.js?instance=${instance}`
  );
  /** @type {any} */ (globalThis).SturdyRef = impostor;
  try {
    const { prototype } = impostor;
    const candidate = freeze(
      create(
        typeof prototype === 'object' || prototype === null ? prototype : null,
      ),
    );
    return isSturdyRefObject(candidate);
  } finally {
    delete (/** @type {any} */ (globalThis).SturdyRef);
  }
};

/**
 * @param {any} t
 * @param {any} impostor
 */
const assertNotTrusted = async (t, impostor) => {
  t.false(await isTrusted(impostor));
};

test.serial('a well-shaped impostor is trusted', async t => {
  // The control: every case below differs from this one in one condition.
  t.true(await isTrusted(makeImpostor()));
});

// `Object.isFrozen({}) === true` detects unsafe harden taming, under which
// `isFrozen` answers true for everything.
const frozenIsMeaningful = !Object.isFrozen({});

test.serial('an unfrozen isSturdyRef is not trusted', async t => {
  if (!frozenIsMeaningful) {
    t.pass('unsafe taming: isFrozen cannot detect an unfrozen check');
    return;
  }
  await assertNotTrusted(t, makeImpostor(undefined, { freezeCheck: false }));
});

test.serial('an unfrozen prototype is not trusted', async t => {
  if (!frozenIsMeaningful) {
    t.pass('unsafe taming: isFrozen cannot detect an unfrozen prototype');
    return;
  }
  await assertNotTrusted(
    t,
    makeImpostor(undefined, { freezePrototype: false }),
  );
});

test.serial('a null prototype is not trusted', async t => {
  await assertNotTrusted(
    t,
    makeImpostor(impostor => {
      impostor.prototype = null;
    }),
  );
});

test.serial('a prototype carrying a method is not trusted', async t => {
  await assertNotTrusted(
    t,
    makeImpostor(impostor => {
      impostor.prototype.transfer = () => {};
    }),
  );
});

test.serial('a prototype carrying an accessor tag is not trusted', async t => {
  await assertNotTrusted(
    t,
    makeImpostor(impostor => {
      impostor.prototype = {};
      defineProperty(impostor.prototype, 'constructor', { value: impostor });
      defineProperty(impostor.prototype, Symbol.toStringTag, {
        get: () => 'SturdyRef',
      });
    }),
  );
});

test.serial('a prototype with the wrong tag is not trusted', async t => {
  await assertNotTrusted(
    t,
    makeImpostor(impostor => {
      impostor.prototype = {};
      defineProperty(impostor.prototype, 'constructor', { value: impostor });
      defineProperty(impostor.prototype, Symbol.toStringTag, {
        value: 'Remotable',
      });
    }),
  );
});

test.serial(
  'a prototype that does not inherit from Object is not trusted',
  async t => {
    await assertNotTrusted(
      t,
      makeImpostor(impostor => {
        impostor.prototype = create(null);
        defineProperty(impostor.prototype, 'constructor', { value: impostor });
        defineProperty(impostor.prototype, Symbol.toStringTag, {
          value: 'SturdyRef',
        });
      }),
    );
  },
);

test.serial(
  'a prototype whose constructor is another is not trusted',
  async t => {
    await assertNotTrusted(
      t,
      makeImpostor(impostor => {
        impostor.prototype = {};
        defineProperty(impostor.prototype, 'constructor', {
          value: function Other() {},
        });
        defineProperty(impostor.prototype, Symbol.toStringTag, {
          value: 'SturdyRef',
        });
      }),
    );
  },
);

test.serial(
  'a prototype carrying an enumerable tag is not trusted',
  async t => {
    await assertNotTrusted(
      t,
      makeImpostor(impostor => {
        impostor.prototype = {};
        defineProperty(impostor.prototype, 'constructor', { value: impostor });
        defineProperty(impostor.prototype, Symbol.toStringTag, {
          value: 'SturdyRef',
          enumerable: true,
        });
      }),
    );
  },
);

test.serial('a throwing isSturdyRef accessor is not trusted', async t => {
  // Freezing a constructor does not stop its accessors from throwing, so
  // pass-style must not invoke them.
  await assertNotTrusted(
    t,
    makeImpostor(
      impostor => {
        delete impostor.isSturdyRef;
        defineProperty(impostor, 'isSturdyRef', {
          get() {
            throw Error('boom');
          },
        });
      },
      { freezeCheck: false },
    ),
  );
});

test.serial('a rejected global does not stop a later one', async t => {
  // Only a trusted global is captured, so a malformed one that appears first
  // cannot keep the shim's from being recognized afterward.
  instance += 1;
  const { isSturdyRefObject } = await import(
    `../src/sturdyref.js?instance=${instance}`
  );
  const malformed = makeImpostor(impostor => {
    impostor.prototype.transfer = () => {};
  });
  const wellShaped = makeImpostor();
  try {
    /** @type {any} */ (globalThis).SturdyRef = malformed;
    t.false(isSturdyRefObject(freeze(create(malformed.prototype))));
    /** @type {any} */ (globalThis).SturdyRef = wellShaped;
    t.true(isSturdyRefObject(freeze(create(wellShaped.prototype))));
  } finally {
    delete (/** @type {any} */ (globalThis).SturdyRef);
  }
});

test.serial('a trusted global is not replaced by a later one', async t => {
  // Once a well-shaped global is captured, a second, equally well-shaped
  // constructor installed afterward does not displace it.
  instance += 1;
  const { isSturdyRefObject } = await import(
    `../src/sturdyref.js?instance=${instance}`
  );
  const first = makeImpostor();
  const second = makeImpostor();
  try {
    /** @type {any} */ (globalThis).SturdyRef = first;
    t.true(isSturdyRefObject(freeze(create(first.prototype))));
    /** @type {any} */ (globalThis).SturdyRef = second;
    t.false(isSturdyRefObject(freeze(create(second.prototype))));
    t.true(isSturdyRefObject(freeze(create(first.prototype))));
  } finally {
    delete (/** @type {any} */ (globalThis).SturdyRef);
  }
});
