// Copyright (C) 2017 Ecma International.  All rights reserved.
// This code is governed by the BSD license found in the LICENSE file.
/*---
description: |
    Collection of assertion functions used throughout test262
defines:
  - assert
  - compareArray
  - formatIdentityFreeValue
  - formatSimpleValue
  - isNegativeZero
  - isPrimitive
---*/


function isNegativeZero(value) {
  return value === 0 && 1 / value === -Infinity;
}

function isPrimitive(value) {
  return !value || (typeof value !== 'object' && typeof value !== 'function');
}

function formatIdentityFreeValue(value) {
  switch (value === null ? 'null' : typeof value) {
    case 'string':
      return typeof JSON !== "undefined" ? JSON.stringify(value) : '"' + value + '"';
    case 'bigint':
      return String(value) + "n";
    case 'number':
      if (isNegativeZero(value)) return '-0';
      // falls through
    case 'boolean':
    case 'undefined':
    case 'null':
      return String(value);
  }
}

function formatSimpleValue(value) {
  var basic = formatIdentityFreeValue(value);
  if (basic) return basic;
  try {
    return String(value);
  } catch (err) {
    if (err.name === 'TypeError') {
      return Object.prototype.toString.call(value);
    }
    throw err;
  }
}

function assert(mustBeTrue, message) {
  if (mustBeTrue === true) {
    return;
  }

  if (message === undefined) {
    message = 'Expected true but got ' + assert._toString(mustBeTrue);
  }
  throw new Test262Error(message);
}

assert._isSameValue = function (a, b) {
  if (a === b) {
    // Handle +/-0 vs. -/+0
    return a !== 0 || 1 / a === 1 / b;
  }

  // Handle NaN vs. NaN
  return a !== a && b !== b;
};

assert.sameValue = function (actual, expected, message) {
  try {
    if (assert._isSameValue(actual, expected)) {
      return;
    }
  } catch (error) {
    throw new Test262Error(message + ' (_isSameValue operation threw) ' + error);
    return;
  }

  if (message === undefined) {
    message = '';
  } else {
    message += ' ';
  }

  message += 'Expected SameValue(«' + assert._toString(actual) + '», «' + assert._toString(expected) + '») to be true';

  throw new Test262Error(message);
};

assert.notSameValue = function (actual, unexpected, message) {
  if (!assert._isSameValue(actual, unexpected)) {
    return;
  }

  if (message === undefined) {
    message = '';
  } else {
    message += ' ';
  }

  message += 'Expected SameValue(«' + assert._toString(actual) + '», «' + assert._toString(unexpected) + '») to be false';

  throw new Test262Error(message);
};

assert.throws = function (expectedErrorConstructor, func, message) {
  var expectedName, actualName;
  if (typeof func !== "function") {
    throw new Test262Error('assert.throws requires two arguments: the error constructor ' +
      'and a function to run');
    return;
  }
  if (message === undefined) {
    message = '';
  } else {
    message += ' ';
  }

  try {
    func();
  } catch (thrown) {
    if (typeof thrown !== 'object' || thrown === null) {
      message += 'Thrown value was not an object!';
      throw new Test262Error(message);
    } else if (thrown.constructor !== expectedErrorConstructor) {
      expectedName = expectedErrorConstructor.name;
      actualName = thrown.constructor.name;
      if (expectedName === actualName) {
        message += 'Expected a ' + expectedName + ' but got a different error constructor with the same name';
      } else {
        message += 'Expected a ' + expectedName + ' but got a ' + actualName;
      }
      throw new Test262Error(message);
    }
    return;
  }

  message += 'Expected a ' + expectedErrorConstructor.name + ' to be thrown but no exception was thrown at all';
  throw new Test262Error(message);
};

assert.compareArray = function (actual, expected, message) {
  message = message === undefined ? '' : message;

  if (typeof message === 'symbol') {
    message = message.toString();
  }

  if (isPrimitive(actual)) {
    assert(false, "Actual argument [" + actual + "] shouldn't be primitive. " + String(message));
  } else if (isPrimitive(expected)) {
    assert(false, "Expected argument [" + expected + "] shouldn't be primitive. " + String(message));
  }
  var result = compareArray(actual, expected);
  if (result) return;

  var format = compareArray.format;
  assert(false, "Actual " + format(actual) + " and expected " + format(expected) + " should have the same contents. " + String(message));
};

function compareArray(a, b) {
  if (b.length !== a.length) {
    return false;
  }
  for (var i = 0; i < a.length; i++) {
    if (!assert._isSameValue(b[i], a[i])) {
      return false;
    }
  }
  return true;
}

compareArray.format = function (arrayLike) {
  return "[" + Array.prototype.map.call(arrayLike, String).join(", ") + "]";
};

assert._formatIdentityFreeValue = formatIdentityFreeValue;

assert._toString = formatSimpleValue;

// Copyright (c) 2012 Ecma International.  All rights reserved.
// This code is governed by the BSD license found in the LICENSE file.
/*---
description: |
    Provides both:

    - An error class to avoid false positives when testing for thrown exceptions
    - A function to explicitly throw an exception using the Test262Error class
defines: [Test262Error, $DONOTEVALUATE]
---*/


function Test262Error(message) {
  if (!(this instanceof Test262Error)) return new Test262Error(message);
  this.message = message || "";
}

Test262Error.prototype.toString = function () {
  return "Test262Error: " + this.message;
};

Test262Error.thrower = function (message) {
  throw new Test262Error(message);
};

function $DONOTEVALUATE() {
  throw "Test262: This statement should not be evaluated.";
}

// Copyright (C) 2017 Ecma International.  All rights reserved.
// This code is governed by the BSD license found in the LICENSE file.
/*---
description: |
    Deprecated now that compareArray is defined in assert.js.
allow_unused: true
---*/

// Copyright 2023 the V8 project authors. All rights reserved.
// This code is governed by the BSD license found in the LICENSE file.

/*---
description: |
    Collection of helper constants and functions for testing resizable array buffers.
defines:
  - floatCtors
  - ctors
  - MyBigInt64Array
  - CreateResizableArrayBuffer
  - MayNeedBigInt
  - Convert
  - ToNumbers
  - CreateRabForTest
  - CollectValuesAndResize
  - TestIterationAndResize
features: [BigInt]
---*/
// Helper to create subclasses without bombing out when `class` isn't supported
function subClass(type) {
  try {
    return new Function('return class My' + type + ' extends ' + type + ' {}')();
  } catch (e) {}
}

const MyUint8Array = subClass('Uint8Array');
const MyFloat32Array = subClass('Float32Array');
const MyBigInt64Array = subClass('BigInt64Array');

const builtinCtors = [
  Uint8Array,
  Int8Array,
  Uint16Array,
  Int16Array,
  Uint32Array,
  Int32Array,
  Float32Array,
  Float64Array,
  Uint8ClampedArray,
];

// Big(U)int64Array and Float16Array are newer features adding them above unconditionally
// would cause implementations lacking it to fail every test which uses it.
if (typeof Float16Array !== 'undefined') {
  builtinCtors.push(Float16Array);
}

if (typeof BigUint64Array !== 'undefined') {
  builtinCtors.push(BigUint64Array);
}

if (typeof BigInt64Array !== 'undefined') {
  builtinCtors.push(BigInt64Array);
}

const floatCtors = [
  Float32Array,
  Float64Array,
  MyFloat32Array
];

if (typeof Float16Array !== 'undefined') {
  floatCtors.push(Float16Array);
}

const ctors = builtinCtors.concat(MyUint8Array, MyFloat32Array);

if (typeof MyBigInt64Array !== 'undefined') {
    ctors.push(MyBigInt64Array);
}

function CreateResizableArrayBuffer(byteLength, maxByteLength) {
  return new ArrayBuffer(byteLength, { maxByteLength: maxByteLength });
}

function Convert(item) {
  if (typeof item == 'bigint') {
    return Number(item);
  }
  return item;
}

function ToNumbers(array) {
  let result = [];
  for (let i = 0; i < array.length; i++) {
    let item = array[i];
    result.push(Convert(item));
  }
  return result;
}

function MayNeedBigInt(ta, n) {
  assert.sameValue(typeof n, 'number');
  if ((BigInt64Array !== 'undefined' && ta instanceof BigInt64Array)
      || (BigUint64Array !== 'undefined' && ta instanceof BigUint64Array)) {
    return BigInt(n);
  }
  return n;
}

function CreateRabForTest(ctor) {
  const rab = CreateResizableArrayBuffer(4 * ctor.BYTES_PER_ELEMENT, 8 * ctor.BYTES_PER_ELEMENT);
  // Write some data into the array.
  const taWrite = new ctor(rab);
  for (let i = 0; i < 4; ++i) {
    taWrite[i] = MayNeedBigInt(taWrite, 2 * i);
  }
  return rab;
}

function CollectValuesAndResize(n, values, rab, resizeAfter, resizeTo) {
  if (typeof n == 'bigint') {
    values.push(Number(n));
  } else {
    values.push(n);
  }
  if (values.length == resizeAfter) {
    rab.resize(resizeTo);
  }
  return true;
}

function TestIterationAndResize(iterable, expected, rab, resizeAfter, newByteLength) {
  let values = [];
  let resized = false;
  var arrayValues = false;

  for (let value of iterable) {
    if (Array.isArray(value)) {
      arrayValues = true;
      values.push([
        value[0],
        Number(value[1])
      ]);
    } else {
      values.push(Number(value));
    }
    if (!resized && values.length == resizeAfter) {
      rab.resize(newByteLength);
      resized = true;
    }
  }
  if (!arrayValues) {
      assert.compareArray([].concat(values), expected, "TestIterationAndResize: list of iterated values");
  } else {
    for (let i = 0; i < expected.length; i++) {
      assert.compareArray(values[i], expected[i], "TestIterationAndResize: list of iterated lists of values");
    }
  }
  assert(resized, "TestIterationAndResize: resize condition should have been hit");
}

// Copyright 2023 the V8 project authors. All rights reserved.
// This code is governed by the BSD license found in the LICENSE file.

/*---
esid: sec-%typedarray%.prototype.sort
description: >
  TypedArray.p.sort behaves correctly on TypedArrays backed by resizable buffers
  and passed a user-provided comparison callback.
includes: [compareArray.js, resizableArrayBufferUtils.js]
features: [resizable-arraybuffer]
---*/

for (let ctor of ctors) {
  const rab = CreateResizableArrayBuffer(4 * ctor.BYTES_PER_ELEMENT, 8 * ctor.BYTES_PER_ELEMENT);
  const fixedLength = new ctor(rab, 0, 4);
  const fixedLengthWithOffset = new ctor(rab, 2 * ctor.BYTES_PER_ELEMENT, 2);
  const lengthTracking = new ctor(rab, 0);
  const lengthTrackingWithOffset = new ctor(rab, 2 * ctor.BYTES_PER_ELEMENT);
  const taFull = new ctor(rab, 0);
  function WriteUnsortedData() {
    // Write some data into the array.
    for (let i = 0; i < taFull.length; ++i) {
      taFull[i] = MayNeedBigInt(taFull, 10 - i);
    }
  }
  function OddBeforeEvenComparison(a, b) {
    // Sort all odd numbers before even numbers.
    a = Number(a);
    b = Number(b);
    if (a % 2 == 1 && b % 2 == 0) {
      return -1;
    }
    if (a % 2 == 0 && b % 2 == 1) {
      return 1;
    }
    if (a < b) {
      return -1;
    }
    if (a > b) {
      return 1;
    }
    return 0;
  }
  // Orig. array: [10, 9, 8, 7]
  //              [10, 9, 8, 7] << fixedLength
  //                     [8, 7] << fixedLengthWithOffset
  //              [10, 9, 8, 7, ...] << lengthTracking
  //                     [8, 7, ...] << lengthTrackingWithOffset

  WriteUnsortedData();
  fixedLength.sort(OddBeforeEvenComparison);
  assert.compareArray(ToNumbers(taFull), [
    7,
    9,
    8,
    10
  ]);
  WriteUnsortedData();
  fixedLengthWithOffset.sort(OddBeforeEvenComparison);
  assert.compareArray(ToNumbers(taFull), [
    10,
    9,
    7,
    8
  ]);
  WriteUnsortedData();
  lengthTracking.sort(OddBeforeEvenComparison);
  assert.compareArray(ToNumbers(taFull), [
    7,
    9,
    8,
    10
  ]);
  WriteUnsortedData();
  lengthTrackingWithOffset.sort(OddBeforeEvenComparison);
  assert.compareArray(ToNumbers(taFull), [
    10,
    9,
    7,
    8
  ]);

  // Shrink so that fixed length TAs go out of bounds.
  rab.resize(3 * ctor.BYTES_PER_ELEMENT);

  // Orig. array: [10, 9, 8]
  //              [10, 9, 8, ...] << lengthTracking
  //                     [8, ...] << lengthTrackingWithOffset

  WriteUnsortedData();
  assert.throws(TypeError, () => {
    fixedLength.sort(OddBeforeEvenComparison);
  });
  assert.compareArray(ToNumbers(taFull), [
    10,
    9,
    8
  ]);
  assert.throws(TypeError, () => {
    fixedLengthWithOffset.sort(OddBeforeEvenComparison);
  });
  assert.compareArray(ToNumbers(taFull), [
    10,
    9,
    8
  ]);
  WriteUnsortedData();
  lengthTracking.sort(OddBeforeEvenComparison);
  assert.compareArray(ToNumbers(taFull), [
    9,
    8,
    10
  ]);
  WriteUnsortedData();
  lengthTrackingWithOffset.sort(OddBeforeEvenComparison);
  assert.compareArray(ToNumbers(taFull), [
    10,
    9,
    8
  ]);

  // Shrink so that the TAs with offset go out of bounds.
  rab.resize(1 * ctor.BYTES_PER_ELEMENT);
  WriteUnsortedData();
  assert.throws(TypeError, () => {
    fixedLength.sort(OddBeforeEvenComparison);
  });
  assert.compareArray(ToNumbers(taFull), [10]);
  assert.throws(TypeError, () => {
    fixedLengthWithOffset.sort(OddBeforeEvenComparison);
  });
  assert.compareArray(ToNumbers(taFull), [10]);
  assert.throws(TypeError, () => {
    lengthTrackingWithOffset.sort(OddBeforeEvenComparison);
  });
  assert.compareArray(ToNumbers(taFull), [10]);

  WriteUnsortedData();
  lengthTracking.sort(OddBeforeEvenComparison);
  assert.compareArray(ToNumbers(taFull), [10]);

  // Shrink to zero.
  rab.resize(0);
  assert.throws(TypeError, () => {
    fixedLength.sort(OddBeforeEvenComparison);
  });
  assert.throws(TypeError, () => {
    fixedLengthWithOffset.sort(OddBeforeEvenComparison);
  });
  assert.throws(TypeError, () => {
    lengthTrackingWithOffset.sort(OddBeforeEvenComparison);
  });

  lengthTracking.sort(OddBeforeEvenComparison);
  assert.compareArray(ToNumbers(taFull), []);

  // Grow so that all TAs are back in-bounds.
  rab.resize(6 * ctor.BYTES_PER_ELEMENT);

  // Orig. array: [10, 9, 8, 7, 6, 5]
  //              [10, 9, 8, 7] << fixedLength
  //                     [8, 7] << fixedLengthWithOffset
  //              [10, 9, 8, 7, 6, 5, ...] << lengthTracking
  //                     [8, 7, 6, 5, ...] << lengthTrackingWithOffset

  WriteUnsortedData();
  fixedLength.sort(OddBeforeEvenComparison);
  assert.compareArray(ToNumbers(taFull), [
    7,
    9,
    8,
    10,
    6,
    5
  ]);
  WriteUnsortedData();
  fixedLengthWithOffset.sort(OddBeforeEvenComparison);
  assert.compareArray(ToNumbers(taFull), [
    10,
    9,
    7,
    8,
    6,
    5
  ]);
  WriteUnsortedData();
  lengthTracking.sort(OddBeforeEvenComparison);
  assert.compareArray(ToNumbers(taFull), [
    5,
    7,
    9,
    6,
    8,
    10
  ]);
  WriteUnsortedData();
  lengthTrackingWithOffset.sort(OddBeforeEvenComparison);
  assert.compareArray(ToNumbers(taFull), [
    10,
    9,
    5,
    7,
    6,
    8
  ]);
}
