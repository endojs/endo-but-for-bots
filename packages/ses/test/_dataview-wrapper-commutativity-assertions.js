const fail = message => {
  throw Error(message);
};

/**
 * @param {unknown} actual
 * @param {unknown} expected
 * @param {string} message
 */
const assertSame = (actual, expected, message) => {
  if (!Object.is(actual, expected)) {
    fail(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
};

/**
 * @param {() => unknown} thunk
 * @param {string} message
 */
const assertThrowsTypeError = (thunk, message) => {
  try {
    thunk();
  } catch (error) {
    if (error instanceof TypeError) {
      return;
    }
    fail(`${message}: threw ${String(error)} instead of TypeError`);
  }
  fail(`${message}: did not throw`);
};

const floatCases = [
  {
    width: 32,
    getFloat: 'getFloat32',
    setFloat: 'setFloat32',
    getUint: 'getUint32',
    setUint: 'setUint32',
    otherNaN: 0xfff8_0000,
    canonicalNaN: 0x7fc0_0000,
  },
  {
    width: 64,
    getFloat: 'getFloat64',
    setFloat: 'setFloat64',
    getUint: 'getBigUint64',
    setUint: 'setBigUint64',
    otherNaN: 0xfff8_0000_0000_0000n,
    canonicalNaN: 0x7ff8_0000_0000_0000n,
  },
];

if ('setFloat16' in DataView.prototype) {
  floatCases.unshift({
    width: 16,
    getFloat: 'getFloat16',
    setFloat: 'setFloat16',
    getUint: 'getUint16',
    setUint: 'setUint16',
    otherNaN: 0xfe00,
    canonicalNaN: 0x7e00,
  });
}

/** Exercise both wrappers through the observable DataView surface. */
export const assertDataViewWrapperPurposes = () => {
  for (const {
    width,
    getFloat,
    setFloat,
    getUint,
    setUint,
    otherNaN,
    canonicalNaN,
  } of floatCases) {
    const mutableView = new DataView(new ArrayBuffer(8));
    Reflect.apply(mutableView[setUint], mutableView, [0, otherNaN, false]);
    const noncanonicalNaN = Reflect.apply(mutableView[getFloat], mutableView, [
      0,
      false,
    ]);
    assertSame(
      Object.is(noncanonicalNaN, NaN),
      true,
      `setFloat${width} fixture is NaN`,
    );
    Reflect.apply(mutableView[setFloat], mutableView, [
      0,
      noncanonicalNaN,
      false,
    ]);
    assertSame(
      Reflect.apply(mutableView[getUint], mutableView, [0, false]),
      canonicalNaN,
      `setFloat${width} canonicalizes NaN`,
    );
  }

  const source = new ArrayBuffer(8);
  new DataView(source).setUint8(1, 0x5a);
  const immutable = source.sliceToImmutable();
  const immutableView = new DataView(immutable);

  assertSame(
    Object.prototype.toString.call(immutableView),
    '[object DataView]',
    'immutable DataView preserves its brand',
  );
  assertSame(
    immutableView.buffer,
    immutable,
    'immutable DataView exposes its immutable buffer',
  );
  assertSame(
    immutableView.getUint8(1),
    0x5a,
    'immutable DataView remains readable',
  );
  assertSame(
    Object.freeze(immutableView),
    immutableView,
    'immutable DataView can be frozen',
  );
  assertSame(
    Object.isFrozen(immutableView),
    true,
    'immutable DataView reports frozen',
  );

  for (const { width, setFloat } of floatCases) {
    assertThrowsTypeError(
      () => Reflect.apply(immutableView[setFloat], immutableView, [0, NaN]),
      `setFloat${width} rejects writes to an immutable DataView`,
    );
  }
};
