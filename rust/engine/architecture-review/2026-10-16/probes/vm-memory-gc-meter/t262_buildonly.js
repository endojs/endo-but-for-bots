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
// Copyright (C) 2017 Mathias Bynens.  All rights reserved.
// This code is governed by the BSD license found in the LICENSE file.
/*---
description: |
    Collection of functions used to assert the correctness of RegExp objects.
defines: [buildString, testPropertyEscapes, testPropertyOfStrings, testExtendedCharacterClass, matchValidator]
---*/

function buildString(args) {
  // Use member expressions rather than destructuring `args` for improved
  // compatibility with engines that only implement assignment patterns
  // partially or not at all.
  const loneCodePoints = args.loneCodePoints;
  const ranges = args.ranges;
  const CHUNK_SIZE = 10000;
  let result = String.fromCodePoint.apply(null, loneCodePoints);
  for (let i = 0; i < ranges.length; i++) {
    let range = ranges[i];
    let start = range[0];
    let end = range[1];
    let codePoints = [];
    for (let length = 0, codePoint = start; codePoint <= end; codePoint++) {
      codePoints[length++] = codePoint;
      if (length === CHUNK_SIZE) {
        result += String.fromCodePoint.apply(null, codePoints);
        codePoints.length = length = 0;
      }
    }
    result += String.fromCodePoint.apply(null, codePoints);
  }
  return result;
}

function printCodePoint(codePoint) {
  const hex = codePoint
    .toString(16)
    .toUpperCase()
    .padStart(6, "0");
  return `U+${hex}`;
}

function printStringCodePoints(string) {
  const buf = [];
  for (let symbol of string) {
    let formatted = printCodePoint(symbol.codePointAt(0));
    buf.push(formatted);
  }
  return buf.join(' ');
}

function testPropertyEscapes(regExp, string, expression) {
  if (!regExp.test(string)) {
    for (let symbol of string) {
      let formatted = printCodePoint(symbol.codePointAt(0));
      assert(
        regExp.test(symbol),
        `\`${ expression }\` should match ${ formatted } (\`${ symbol }\`)`
      );
    }
  }
}

function testPropertyOfStrings(args) {
  // Use member expressions rather than destructuring `args` for improved
  // compatibility with engines that only implement assignment patterns
  // partially or not at all.
  const regExp = args.regExp;
  const expression = args.expression;
  const matchStrings = args.matchStrings;
  const nonMatchStrings = args.nonMatchStrings;
  const allStrings = matchStrings.join('');
  if (!regExp.test(allStrings)) {
    for (let string of matchStrings) {
      assert(
        regExp.test(string),
        `\`${ expression }\` should match ${ string } (${ printStringCodePoints(string) })`
      );
    }
  }

  if (!nonMatchStrings) return;

  const allNonMatchStrings = nonMatchStrings.join('');
  if (regExp.test(allNonMatchStrings)) {
    for (let string of nonMatchStrings) {
      assert(
        !regExp.test(string),
        `\`${ expression }\` should not match ${ string } (${ printStringCodePoints(string) })`
      );
    }
  }
}

// The exact same logic can be used to test extended character classes
// as enabled through the RegExp `v` flag. This is useful to test not
// just standalone properties of strings, but also string literals, and
// set operations.
const testExtendedCharacterClass = testPropertyOfStrings;

// Returns a function that validates a RegExp match result.
//
// Example:
//
//    var validate = matchValidator(['b'], 1, 'abc');
//    validate(/b/.exec('abc'));
//
function matchValidator(expectedEntries, expectedIndex, expectedInput) {
  return function(match) {
    assert.compareArray(match, expectedEntries, 'Match entries');
    assert.sameValue(match.index, expectedIndex, 'Match index');
    assert.sameValue(match.input, expectedInput, 'Match input');
  }
}
// Copyright (C) 2018 Leo Balter.  All rights reserved.
// Copyright (C) 2024 Aurèle Barrière.  All rights reserved.
// This code is governed by the BSD license found in the LICENSE file.

/*---
esid: prod-CharacterClassEscape
description: >
  Check positive cases of non-digit class escape \D.
info: |
  This is a generated test. Please check out
  https://github.com/tc39/test262/tree/main/tools/regexp-generator/
  for any changes.

  CharacterClassEscape[UnicodeMode] ::
    d
    D
    s
    S
    w
    W
    [+UnicodeMode] p{ UnicodePropertyValueExpression }
    [+UnicodeMode] P{ UnicodePropertyValueExpression }

  22.2.2.9 Runtime Semantics: CompileToCharSet

  CharacterClassEscape :: d
    1. Return the ten-element CharSet containing the characters 0, 1, 2, 3, 4,
      5, 6, 7, 8, and 9.
  CharacterClassEscape :: D
    1. Let S be the CharSet returned by CharacterClassEscape :: d.
    2. Return CharacterComplement(rer, S).
  CharacterClassEscape :: s
    1. Return the CharSet containing all characters corresponding to a code
      point on the right-hand side of the WhiteSpace or LineTerminator
      productions.
  CharacterClassEscape :: S
    1. Let S be the CharSet returned by CharacterClassEscape :: s.
    2. Return CharacterComplement(rer, S).
  CharacterClassEscape :: w
    1. Return MaybeSimpleCaseFolding(rer, WordCharacters(rer)).
  CharacterClassEscape :: W
    1. Let S be the CharSet returned by CharacterClassEscape :: w.
    2. Return CharacterComplement(rer, S).
features: [String.fromCodePoint]
includes: [regExpUtils.js]
flags: [generated]
---*/

const str = buildString(
{
  loneCodePoints: [],
  ranges: [
    [0x00DC00, 0x00DFFF],
    [0x000000, 0x00002F],
    [0x00003A, 0x00DBFF],
    [0x00E000, 0x10FFFF]
  ]
}
);

const standard = /^\D+$/;
const unicode = /^\D+$/u;
const vflag = /^\D+$/v;
const regexes = [standard,unicode,vflag];

const errors = [];

for (const regex of regexes) {
  if (!regex.test(str)) {
    // Error, let's find out where
    for (const char of str) {
      if (!regex.test(char)) {
        errors.push('0x' + char.codePointAt(0).toString(16));
      }
    }
  }
}

assert.sameValue(
  errors.length,
  0,
  'Expected full match, but did not match: ' + errors.join(',')
);

function testPropertyEscapes() {}
throw new Error("completed buildString only");
