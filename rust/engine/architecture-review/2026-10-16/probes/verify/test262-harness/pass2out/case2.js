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

// Copyright (C) 2022 Igalia, S.L. All rights reserved.
// This code is governed by the BSD license found in the LICENSE file.

/*---
esid: sec-temporal.duration.compare
description: Basic comparisons.
features: [Temporal]
---*/

const td1pos = new Temporal.Duration(0, 0, 0, 0, 5, 5, 5, 5, 5, 5);
const td2pos = new Temporal.Duration(0, 0, 0, 0, 5, 4, 5, 5, 5, 5);
const td1neg = new Temporal.Duration(0, 0, 0, 0, -5, -5, -5, -5, -5, -5);
const td2neg = new Temporal.Duration(0, 0, 0, 0, -5, -4, -5, -5, -5, -5);
assert.sameValue(Temporal.Duration.compare(td1pos, td1pos), 0,
  "time units: equal");
assert.sameValue(Temporal.Duration.compare(td2pos, td1pos), -1,
  "time units: smaller/larger");
assert.sameValue(Temporal.Duration.compare(td1pos, td2pos), 1,
  "time units: larger/smaller");
assert.sameValue(Temporal.Duration.compare(td1neg, td1neg), 0,
  "time units: negative/negative equal");
assert.sameValue(Temporal.Duration.compare(td2neg, td1neg), 1,
  "time units: negative/negative smaller/larger");
assert.sameValue(Temporal.Duration.compare(td1neg, td2neg), -1,
  "time units: negative/negative larger/smaller");
assert.sameValue(Temporal.Duration.compare(td1neg, td2pos), -1,
  "time units: negative/positive");
assert.sameValue(Temporal.Duration.compare(td1pos, td2neg), 1,
  "time units: positive/negative");

const dd1pos = new Temporal.Duration(5, 5, 5, 5, 5, 5, 5, 5, 5, 5);
const dd2pos = new Temporal.Duration(5, 5, 5, 5, 5, 4, 5, 5, 5, 5);
const dd1neg = new Temporal.Duration(-5, -5, -5, -5, -5, -5, -5, -5, -5, -5);
const dd2neg = new Temporal.Duration(-5, -5, -5, -5, -5, -4, -5, -5, -5, -5);
const relativeTo = Temporal.PlainDate.from("2017-01-01");
assert.throws(RangeError, () => Temporal.Duration.compare(dd1pos, dd2pos),
  "date units: relativeTo is required");
assert.sameValue(Temporal.Duration.compare(dd1pos, dd1pos, { relativeTo }), 0,
  "date units: equal");
assert.sameValue(Temporal.Duration.compare(dd2pos, dd1pos, { relativeTo }), -1,
  "date units: smaller/larger");
assert.sameValue(Temporal.Duration.compare(dd1pos, dd2pos, { relativeTo }), 1,
  "date units: larger/smaller");
assert.sameValue(Temporal.Duration.compare(dd1neg, dd1neg, { relativeTo }), 0,
  "date units: negative/negative equal");
assert.sameValue(Temporal.Duration.compare(dd2neg, dd1neg, { relativeTo }), 1,
  "date units: negative/negative smaller/larger");
assert.sameValue(Temporal.Duration.compare(dd1neg, dd2neg, { relativeTo }), -1,
  "date units: negative/negative larger/smaller");
assert.sameValue(Temporal.Duration.compare(dd1neg, dd2pos, { relativeTo }), -1,
  "date units: negative/positive");
assert.sameValue(Temporal.Duration.compare(dd1pos, dd2neg, { relativeTo }), 1,
  "date units: positive/negative");
