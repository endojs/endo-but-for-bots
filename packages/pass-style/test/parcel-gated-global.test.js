import test from '@endo/ses-ava/test.js';

const { create, defineProperty, freeze } = Object;
const mutableSerialTest =
  Object.getOwnPropertyDescriptor(globalThis, 'Parcel')?.configurable !== false
    ? test.serial
    : test.skip;

// Each case installs a frozen constructor whose `isParcel` vouches for
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
  const impostor = function Parcel() {};
  impostor.isParcel = () => true;
  defineProperty(impostor.prototype, Symbol.toStringTag, {
    value: 'Parcel',
  });
  breakIt(impostor);
  if (freezeCheck) freeze(impostor.isParcel);
  if (freezePrototype && impostor.prototype) freeze(impostor.prototype);
  return freeze(impostor);
};

/**
 * @param {any} impostor
 */
const isTrusted = async impostor => {
  instance += 1;
  const { isParcelObject } = await import(
    `../src/parcel.js?instance=${instance}`
  );
  /** @type {any} */ (globalThis).Parcel = impostor;
  try {
    const { prototype } = impostor;
    const candidate = freeze(
      create(
        typeof prototype === 'object' || prototype === null ? prototype : null,
      ),
    );
    return isParcelObject(candidate);
  } finally {
    delete (/** @type {any} */ (globalThis).Parcel);
  }
};

/**
 * @param {any} t
 * @param {any} impostor
 */
const assertNotTrusted = async (t, impostor) => {
  t.false(await isTrusted(impostor));
};

mutableSerialTest('a well-shaped impostor is trusted', async t => {
  // The control: every case below differs from this one in one condition.
  t.true(await isTrusted(makeImpostor()));
});

// `Object.isFrozen({}) === true` detects unsafe harden taming, under which
// `isFrozen` answers true for everything.
const frozenIsMeaningful = !Object.isFrozen({});

mutableSerialTest('an unfrozen isParcel is not trusted', async t => {
  if (!frozenIsMeaningful) {
    t.pass('unsafe taming: isFrozen cannot detect an unfrozen check');
    return;
  }
  await assertNotTrusted(t, makeImpostor(undefined, { freezeCheck: false }));
});

mutableSerialTest('an unfrozen prototype is not trusted', async t => {
  if (!frozenIsMeaningful) {
    t.pass('unsafe taming: isFrozen cannot detect an unfrozen prototype');
    return;
  }
  await assertNotTrusted(
    t,
    makeImpostor(undefined, { freezePrototype: false }),
  );
});

mutableSerialTest('a null prototype is not trusted', async t => {
  await assertNotTrusted(
    t,
    makeImpostor(impostor => {
      impostor.prototype = null;
    }),
  );
});

mutableSerialTest('a prototype carrying a method is not trusted', async t => {
  await assertNotTrusted(
    t,
    makeImpostor(impostor => {
      impostor.prototype.transfer = () => {};
    }),
  );
});

mutableSerialTest(
  'a prototype carrying an accessor tag is not trusted',
  async t => {
    await assertNotTrusted(
      t,
      makeImpostor(impostor => {
        impostor.prototype = {};
        defineProperty(impostor.prototype, 'constructor', { value: impostor });
        defineProperty(impostor.prototype, Symbol.toStringTag, {
          get: () => 'Parcel',
        });
      }),
    );
  },
);

mutableSerialTest('a prototype with the wrong tag is not trusted', async t => {
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

mutableSerialTest(
  'a prototype that does not inherit from Object is not trusted',
  async t => {
    await assertNotTrusted(
      t,
      makeImpostor(impostor => {
        impostor.prototype = create(null);
        defineProperty(impostor.prototype, 'constructor', { value: impostor });
        defineProperty(impostor.prototype, Symbol.toStringTag, {
          value: 'Parcel',
        });
      }),
    );
  },
);

mutableSerialTest(
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
          value: 'Parcel',
        });
      }),
    );
  },
);

mutableSerialTest(
  'a prototype carrying an enumerable tag is not trusted',
  async t => {
    await assertNotTrusted(
      t,
      makeImpostor(impostor => {
        impostor.prototype = {};
        defineProperty(impostor.prototype, 'constructor', { value: impostor });
        defineProperty(impostor.prototype, Symbol.toStringTag, {
          value: 'Parcel',
          enumerable: true,
        });
      }),
    );
  },
);

mutableSerialTest('a throwing isParcel accessor is not trusted', async t => {
  // Freezing a constructor does not stop its accessors from throwing, so
  // pass-style must not invoke them.
  await assertNotTrusted(
    t,
    makeImpostor(
      impostor => {
        delete impostor.isParcel;
        defineProperty(impostor, 'isParcel', {
          get() {
            throw Error('boom');
          },
        });
      },
      { freezeCheck: false },
    ),
  );
});

mutableSerialTest('a rejected global does not stop a later one', async t => {
  // Only a trusted global is captured, so a malformed one that appears first
  // cannot keep the shim's from being recognized afterward.
  instance += 1;
  const { isParcelObject } = await import(
    `../src/parcel.js?instance=${instance}`
  );
  const malformed = makeImpostor(impostor => {
    impostor.prototype.transfer = () => {};
  });
  const wellShaped = makeImpostor();
  try {
    /** @type {any} */ (globalThis).Parcel = malformed;
    t.false(isParcelObject(freeze(create(malformed.prototype))));
    /** @type {any} */ (globalThis).Parcel = wellShaped;
    t.true(isParcelObject(freeze(create(wellShaped.prototype))));
  } finally {
    delete (/** @type {any} */ (globalThis).Parcel);
  }
});

mutableSerialTest(
  'a trusted global is not replaced by a later one',
  async t => {
    // Once a well-shaped global is captured, a second, equally well-shaped
    // constructor installed afterward does not displace it.
    instance += 1;
    const { isParcelObject } = await import(
      `../src/parcel.js?instance=${instance}`
    );
    const first = makeImpostor();
    const second = makeImpostor();
    try {
      /** @type {any} */ (globalThis).Parcel = first;
      t.true(isParcelObject(freeze(create(first.prototype))));
      /** @type {any} */ (globalThis).Parcel = second;
      t.false(isParcelObject(freeze(create(second.prototype))));
      t.true(isParcelObject(freeze(create(first.prototype))));
    } finally {
      delete (/** @type {any} */ (globalThis).Parcel);
    }
  },
);
