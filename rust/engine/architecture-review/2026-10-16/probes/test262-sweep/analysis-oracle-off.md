## Totals
{'skipped': 5141, 'covered': 39862, 'unsupported': 3270, 'infrastructure': 3457, 'ironhorse-failure': 241, 'refused': 5} total 51976
outcomes {'pre-skip': 364, 'covered': 39862, 'run-skip': 11509, 'fail': 241}
strict_skipped 0 computron_gap 38612

### By top-level tree

| group | total | covered | % covered | fail | unsupported | refused | skipped | infra |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| built-ins | 23809 | 17267 | 72.5 | 101 | 1387 | 5 | 2673 | 2376 |
| language | 23724 | 22330 | 94.1 | 140 | 1034 | 0 | 34 | 186 |
| intl402 | 3357 | 25 | 0.7 | 0 | 48 | 0 | 2399 | 885 |
| annexB | 1086 | 240 | 22.1 | 0 | 801 | 0 | 35 | 10 |

### By second-level area

| group | total | covered | % covered | fail | unsupported | refused | skipped | infra |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| language/expressions | 11102 | 10391 | 93.6 | 67 | 610 | 0 | 16 | 18 |
| language/statements | 9347 | 9223 | 98.7 | 45 | 43 | 0 | 18 | 18 |
| built-ins/Temporal | 4603 | 0 | 0.0 | 0 | 1 | 0 | 2378 | 2224 |
| built-ins/Object | 3411 | 3386 | 99.3 | 9 | 8 | 0 | 0 | 8 |
| built-ins/Array | 3082 | 2992 | 97.1 | 0 | 87 | 0 | 0 | 3 |
| intl402/Temporal | 2029 | 0 | 0.0 | 0 | 10 | 0 | 1837 | 182 |
| built-ins/RegExp | 1879 | 1226 | 65.2 | 10 | 565 | 0 | 0 | 78 |
| built-ins/TypedArray | 1446 | 1300 | 89.9 | 13 | 106 | 0 | 0 | 27 |
| built-ins/String | 1223 | 1216 | 99.4 | 2 | 3 | 0 | 0 | 2 |
| annexB/language | 845 | 151 | 17.9 | 0 | 662 | 0 | 26 | 6 |
| built-ins/TypedArrayConstructors | 738 | 710 | 96.2 | 0 | 28 | 0 | 0 | 0 |
| built-ins/Promise | 729 | 630 | 86.4 | 8 | 91 | 0 | 0 | 0 |
| built-ins/Iterator | 654 | 438 | 67.0 | 2 | 210 | 0 | 0 | 4 |
| language/module-code | 599 | 202 | 33.7 | 24 | 336 | 0 | 0 | 37 |
| built-ins/Date | 594 | 582 | 98.0 | 0 | 12 | 0 | 0 | 0 |
| built-ins/DataView | 561 | 548 | 97.7 | 0 | 13 | 0 | 0 | 0 |
| language/literals | 534 | 534 | 100.0 | 0 | 0 | 0 | 0 | 0 |
| built-ins/Function | 509 | 416 | 81.7 | 1 | 84 | 0 | 0 | 8 |
| built-ins/Atomics | 389 | 146 | 37.5 | 0 | 13 | 0 | 230 | 0 |
| built-ins/Set | 383 | 378 | 98.7 | 0 | 5 | 0 | 0 | 0 |
| language/eval-code | 347 | 328 | 94.5 | 4 | 3 | 0 | 0 | 12 |
| built-ins/Number | 340 | 339 | 99.7 | 0 | 1 | 0 | 0 | 0 |
| built-ins/Math | 327 | 322 | 98.5 | 2 | 0 | 0 | 0 | 3 |
| built-ins/Proxy | 311 | 269 | 86.5 | 4 | 37 | 0 | 1 | 0 |
| language/identifiers | 268 | 268 | 100.0 | 0 | 0 | 0 | 0 | 0 |
| language/arguments-object | 263 | 263 | 100.0 | 0 | 0 | 0 | 0 | 0 |
| intl402/NumberFormat | 249 | 0 | 0.0 | 0 | 21 | 0 | 61 | 167 |
| intl402/DateTimeFormat | 244 | 0 | 0.0 | 0 | 5 | 0 | 115 | 124 |
| annexB/built-ins | 241 | 89 | 36.9 | 0 | 139 | 0 | 9 | 4 |
| built-ins/ArrayBuffer | 221 | 193 | 87.3 | 0 | 28 | 0 | 0 | 0 |
| language/function-code | 217 | 215 | 99.1 | 0 | 0 | 0 | 0 | 2 |
| built-ins/Map | 204 | 203 | 99.5 | 0 | 1 | 0 | 0 | 0 |
| intl402/Locale | 168 | 0 | 0.0 | 0 | 1 | 0 | 95 | 72 |
| built-ins/JSON | 165 | 162 | 98.2 | 0 | 2 | 0 | 0 | 1 |
| built-ins/Reflect | 153 | 153 | 100.0 | 0 | 0 | 0 | 0 | 0 |
| language/block-scope | 145 | 145 | 100.0 | 0 | 0 | 0 | 0 | 0 |
| built-ins/WeakMap | 141 | 123 | 87.2 | 0 | 14 | 4 | 0 | 0 |
| language/import | 129 | 10 | 7.8 | 0 | 29 | 0 | 0 | 90 |
| language/types | 113 | 108 | 95.6 | 0 | 2 | 0 | 0 | 3 |
| intl402/DurationFormat | 110 | 0 | 0.0 | 0 | 0 | 0 | 102 | 8 |
| built-ins/AsyncDisposableStack | 104 | 94 | 90.4 | 3 | 3 | 0 | 0 | 4 |
| built-ins/SharedArrayBuffer | 104 | 103 | 99.0 | 0 | 1 | 0 | 0 | 0 |
| language/asi | 102 | 102 | 100.0 | 0 | 0 | 0 | 0 | 0 |
| built-ins/Symbol | 98 | 81 | 82.7 | 0 | 17 | 0 | 0 | 0 |
| built-ins/NativeErrors | 94 | 88 | 93.6 | 0 | 6 | 0 | 0 | 0 |
| built-ins/DisposableStack | 93 | 86 | 92.5 | 1 | 2 | 0 | 0 | 4 |
| built-ins/Error | 93 | 78 | 83.9 | 0 | 15 | 0 | 0 | 0 |
| built-ins/WeakSet | 85 | 77 | 90.6 | 0 | 7 | 1 | 0 | 0 |
| intl402/ListFormat | 81 | 0 | 0.0 | 0 | 1 | 0 | 7 | 73 |
| intl402/RelativeTimeFormat | 80 | 0 | 0.0 | 0 | 1 | 0 | 76 | 3 |
| language/statementList | 80 | 80 | 100.0 | 0 | 0 | 0 | 0 | 0 |
| intl402/Segmenter | 79 | 0 | 0.0 | 0 | 2 | 0 | 8 | 69 |
| built-ins/BigInt | 77 | 76 | 98.7 | 0 | 1 | 0 | 0 | 0 |
| built-ins/Uint8Array | 70 | 68 | 97.1 | 0 | 2 | 0 | 0 | 0 |
| language/white-space | 67 | 67 | 100.0 | 0 | 0 | 0 | 0 | 0 |
| intl402/Intl | 66 | 0 | 0.0 | 0 | 0 | 0 | 31 | 35 |
| intl402/Collator | 65 | 0 | 0.0 | 0 | 1 | 0 | 19 | 45 |
| built-ins/ShadowRealm | 64 | 0 | 0.0 | 0 | 0 | 0 | 64 | 0 |
| language/directive-prologue | 62 | 62 | 100.0 | 0 | 0 | 0 | 0 | 0 |
| built-ins/GeneratorPrototype | 61 | 61 | 100.0 | 0 | 0 | 0 | 0 | 0 |
| intl402/DisplayNames | 57 | 0 | 0.0 | 0 | 1 | 0 | 34 | 22 |
| built-ins/decodeURIComponent | 56 | 55 | 98.2 | 0 | 0 | 0 | 0 | 1 |
| built-ins/decodeURI | 55 | 54 | 98.2 | 0 | 0 | 0 | 0 | 1 |
| built-ins/parseInt | 55 | 54 | 98.2 | 0 | 0 | 0 | 0 | 1 |
| language/future-reserved-words | 55 | 55 | 100.0 | 0 | 0 | 0 | 0 | 0 |
| built-ins/parseFloat | 54 | 53 | 98.1 | 0 | 0 | 0 | 0 | 1 |
| intl402/PluralRules | 53 | 0 | 0.0 | 0 | 1 | 0 | 3 | 49 |
| language/comments | 52 | 52 | 100.0 | 0 | 0 | 0 | 0 | 0 |
| built-ins/Boolean | 51 | 50 | 98.0 | 0 | 1 | 0 | 0 | 0 |
| built-ins/AsyncGeneratorPrototype | 48 | 45 | 93.8 | 3 | 0 | 0 | 0 | 0 |
| language/computed-property-names | 48 | 48 | 100.0 | 0 | 0 | 0 | 0 | 0 |
| built-ins/FinalizationRegistry | 47 | 44 | 93.6 | 0 | 3 | 0 | 0 | 0 |
| language/global-code | 42 | 27 | 64.3 | 0 | 10 | 0 | 0 | 5 |
| language/line-terminators | 41 | 41 | 100.0 | 0 | 0 | 0 | 0 | 0 |
| built-ins/AsyncFromSyncIteratorPrototype | 38 | 8 | 21.1 | 29 | 1 | 0 | 0 | 0 |
| built-ins/encodeURI | 31 | 30 | 96.8 | 0 | 0 | 0 | 0 | 1 |
| built-ins/encodeURIComponent | 31 | 30 | 96.8 | 0 | 0 | 0 | 0 | 1 |
| built-ins/WeakRef | 29 | 26 | 89.7 | 0 | 3 | 0 | 0 | 0 |
| built-ins/global | 29 | 28 | 96.6 | 0 | 0 | 0 | 0 | 1 |
| built-ins/ArrayIteratorPrototype | 27 | 24 | 88.9 | 3 | 0 | 0 | 0 | 0 |
| language/reserved-words | 27 | 27 | 100.0 | 0 | 0 | 0 | 0 | 0 |
| built-ins/AggregateError | 25 | 24 | 96.0 | 0 | 1 | 0 | 0 | 0 |
| language/keywords | 25 | 25 | 100.0 | 0 | 0 | 0 | 0 | 0 |
| built-ins/AsyncGeneratorFunction | 23 | 19 | 82.6 | 2 | 2 | 0 | 0 | 0 |
| built-ins/GeneratorFunction | 23 | 20 | 87.0 | 1 | 2 | 0 | 0 | 0 |
| built-ins/SuppressedError | 22 | 21 | 95.5 | 0 | 1 | 0 | 0 | 0 |
| intl402/String | 19 | 7 | 36.8 | 0 | 4 | 0 | 2 | 6 |
| language/destructuring | 19 | 18 | 94.7 | 0 | 1 | 0 | 0 | 0 |
| built-ins/AsyncFunction | 18 | 17 | 94.4 | 0 | 1 | 0 | 0 | 0 |
| built-ins/RegExpStringIteratorPrototype | 17 | 17 | 100.0 | 0 | 0 | 0 | 0 | 0 |
| built-ins/isFinite | 15 | 15 | 100.0 | 0 | 0 | 0 | 0 | 0 |
| built-ins/isNaN | 15 | 15 | 100.0 | 0 | 0 | 0 | 0 | 0 |
| built-ins/ThrowTypeError | 14 | 13 | 92.9 | 0 | 1 | 0 | 0 | 0 |
| language/identifier-resolution | 14 | 13 | 92.9 | 0 | 0 | 0 | 0 | 1 |
| built-ins/AsyncIteratorPrototype | 13 | 4 | 30.8 | 6 | 0 | 0 | 0 | 3 |
| intl402/Date | 12 | 8 | 66.7 | 0 | 0 | 0 | 1 | 3 |
| built-ins/MapIteratorPrototype | 11 | 11 | 100.0 | 0 | 0 | 0 | 0 | 0 |
| built-ins/SetIteratorPrototype | 11 | 11 | 100.0 | 0 | 0 | 0 | 0 | 0 |
| intl402/BigInt | 11 | 5 | 45.5 | 0 | 0 | 0 | 1 | 5 |
| language/punctuators | 11 | 11 | 100.0 | 0 | 0 | 0 | 0 | 0 |
| language/rest-parameters | 11 | 11 | 100.0 | 0 | 0 | 0 | 0 | 0 |
| built-ins/eval | 10 | 10 | 100.0 | 0 | 0 | 0 | 0 | 0 |
| built-ins/AbstractModuleSource | 8 | 0 | 0.0 | 0 | 8 | 0 | 0 | 0 |
| built-ins/undefined | 8 | 7 | 87.5 | 1 | 0 | 0 | 0 | 0 |
| built-ins/StringIteratorPrototype | 7 | 6 | 85.7 | 1 | 0 | 0 | 0 | 0 |
| intl402/Number | 7 | 3 | 42.9 | 0 | 0 | 0 | 0 | 4 |
| built-ins/Infinity | 6 | 6 | 100.0 | 0 | 0 | 0 | 0 | 0 |
| built-ins/NaN | 6 | 6 | 100.0 | 0 | 0 | 0 | 0 | 0 |
| language/export | 3 | 3 | 100.0 | 0 | 0 | 0 | 0 | 0 |
| intl402/Array | 2 | 1 | 50.0 | 0 | 0 | 0 | 0 | 1 |
| intl402/FallbackSymbol | 2 | 0 | 0.0 | 0 | 0 | 0 | 2 | 0 |
| intl402/TypedArray | 1 | 1 | 100.0 | 0 | 0 | 0 | 0 | 0 |
| intl402/constructors-string-and-single-element-array.js | 1 | 0 | 0.0 | 0 | 0 | 0 | 0 | 1 |
| intl402/constructors-taint-Object-prototype-2.js | 1 | 0 | 0.0 | 0 | 0 | 0 | 0 | 1 |
| intl402/constructors-taint-Object-prototype.js | 1 | 0 | 0.0 | 0 | 0 | 0 | 0 | 1 |
| intl402/default-locale-is-canonicalized.js | 1 | 0 | 0.0 | 0 | 0 | 0 | 0 | 1 |
| intl402/default-locale-is-supported.js | 1 | 0 | 0.0 | 0 | 0 | 0 | 0 | 1 |
| intl402/fallback-locales-are-supported.js | 1 | 0 | 0.0 | 0 | 0 | 0 | 0 | 1 |
| intl402/language-tags-canonicalized.js | 1 | 0 | 0.0 | 0 | 0 | 0 | 1 | 0 |
| intl402/language-tags-invalid.js | 1 | 0 | 0.0 | 0 | 0 | 0 | 1 | 0 |
| intl402/language-tags-valid.js | 1 | 0 | 0.0 | 0 | 0 | 0 | 0 | 1 |
| intl402/language-tags-with-underscore.js | 1 | 0 | 0.0 | 0 | 0 | 0 | 0 | 1 |
| intl402/supportedLocalesOf-consistent-with-resolvedOptions.js | 1 | 0 | 0.0 | 0 | 0 | 0 | 1 | 0 |
| intl402/supportedLocalesOf-default-locale-and-zxx-locale.js | 1 | 0 | 0.0 | 0 | 0 | 0 | 0 | 1 |
| intl402/supportedLocalesOf-duplicate-elements-removed.js | 1 | 0 | 0.0 | 0 | 0 | 0 | 0 | 1 |
| intl402/supportedLocalesOf-empty-and-undefined.js | 1 | 0 | 0.0 | 0 | 0 | 0 | 0 | 1 |
| intl402/supportedLocalesOf-locales-arg-coered-to-object.js | 1 | 0 | 0.0 | 0 | 0 | 0 | 1 | 0 |
| intl402/supportedLocalesOf-locales-arg-empty-array.js | 1 | 0 | 0.0 | 0 | 0 | 0 | 0 | 1 |
| intl402/supportedLocalesOf-returned-array-elements-are-not-frozen.js | 1 | 0 | 0.0 | 0 | 0 | 0 | 0 | 1 |
| intl402/supportedLocalesOf-taint-Array-2.js | 1 | 0 | 0.0 | 0 | 0 | 0 | 0 | 1 |
| intl402/supportedLocalesOf-taint-Array.js | 1 | 0 | 0.0 | 0 | 0 | 0 | 0 | 1 |
| intl402/supportedLocalesOf-test-option-localeMatcher.js | 1 | 0 | 0.0 | 0 | 0 | 0 | 1 | 0 |
| intl402/supportedLocalesOf-throws-if-element-not-string-or-object.js | 1 | 0 | 0.0 | 0 | 0 | 0 | 0 | 1 |
| intl402/supportedLocalesOf-unicode-extensions-ignored.js | 1 | 0 | 0.0 | 0 | 0 | 0 | 0 | 1 |
| language/source-text | 1 | 1 | 100.0 | 0 | 0 | 0 | 0 | 0 |

### Reason prefixes for ironhorse-failure

| async | 134 |
| ironhorse failed a harness assertion the oracle passed | 81 |
| engine-invariant | 24 |
| result divergence | 2 |

### Top full reasons for ironhorse-failure

| 53 | async: Test262:AsyncTestFailure:TypeError: call: not a function (the oracle completed) |
| 48 | async: Test262:AsyncTestFailure:Test262Error: Test262Error: reject reason Expected SameValue(«TypeError: call: not a function», «[object Obj |
| 24 | engine-invariant:await:no-async-instance |
| 19 | ironhorse failed a harness assertion the oracle passed: Test262Error: Expected a ReferenceError to be thrown but no exception was thrown at  |
| 7 | async: Test262:AsyncTestFailure:Test262Error: Test262Error: Promise should be rejected Expected a CatchError to be thrown asynchronously but |
| 7 | ironhorse failed a harness assertion the oracle passed: Test262Error: Expected a TypeError to be thrown but no exception was thrown at all |
| 4 | ironhorse failed a harness assertion the oracle passed: Test262Error: isConstructor invoked with a non-function value |
| 4 | ironhorse failed a harness assertion the oracle passed: Test262Error: Expected a RangeError but got a TypeError (Testing with Float64Array a |
| 3 | async: Test262:AsyncTestFailure:Test262Error: Test262Error: iterator closed properly Expected SameValue(«0», «1») to be true (the oracle com |
| 3 | ironhorse failed a harness assertion the oracle passed: Test262Error: Expected SameValue(«"object"», «"function"») to be true |
| 3 | ironhorse failed a harness assertion the oracle passed: Test262Error: __re.hasOwnProperty('global') must return true Expected SameValue(«fal |
| 3 | ironhorse failed a harness assertion the oracle passed: Test262Error: __re.hasOwnProperty('ignoreCase') must return true Expected SameValue( |
| 3 | ironhorse failed a harness assertion the oracle passed: Test262Error: __re.hasOwnProperty('multiline') must return true Expected SameValue(« |
| 3 | ironhorse failed a harness assertion the oracle passed: Test262Error: typeof Expected SameValue(«"undefined"», «"function"») to be true |
| 2 | ironhorse failed a harness assertion the oracle passed: Test262Error: Expected SameValue(«"Array Iterator"», «"Iterator"») to be true |
| 2 | async: Test262:AsyncTestFailure:Test262Error: Test262Error: Actual [dispose, job 1, job 2] and expected [job 1, dispose, job 2] should have  |
| 2 | async: Test262:AsyncTestFailure:Test262Error: Test262Error: Promise should be rejected with thrown error Expected SameValue(«TypeError: call |
| 2 | async: Test262:AsyncTestFailure:Test262Error: Test262Error: Promise should be rejected Expected a Reject to be thrown asynchronously but got |
| 2 | ironhorse failed a harness assertion the oracle passed: Test262Error: constructor descriptor should not be writable |
| 2 | async: Test262:AsyncTestFailure:Test262Error: Test262Error: Expected rejection (the oracle completed) |
| 2 | ironhorse failed a harness assertion the oracle passed: Test262Error: Expected SameValue(«"undefined"», «"function"») to be true |
| 2 | async: Test262:AsyncTestFailure:Test262Error: Test262Error: The value of resolve.length is expected to equal the value of expected[calls].le |
| 2 | async: Test262:AsyncTestFailure:Test262Error: Test262Error: Expected SameValue(«5», «7») to be true (the oracle completed) |
| 2 | ironhorse failed a harness assertion the oracle passed: Test262Error: Expected true but got false |
| 2 | ironhorse failed a harness assertion the oracle passed: Test262Error: f descriptor should be enumerable; f descriptor should be writable |
| 2 | ironhorse failed a harness assertion the oracle passed: Test262Error: declaration following Expected SameValue(«[object Object]», «undefined |
| 1 | ironhorse failed a harness assertion the oracle passed: Test262Error: Expected SameValue(«"[object Array Iterator]"», «"[object Iterator]"») |
| 1 | result divergence: oracle="Error" ironhorse="[object AsyncDisposableStack]" |
| 1 | async: Test262:AsyncTestFailure:Test262Error: Test262Error: Expected SameValue(«TypeError: call: not a function», «"reject"») to be true (th |
| 1 | async: Test262:AsyncTestFailure:Test262Error: Test262Error: Expected SameValue(«0», «1») to be true (the oracle completed) |
| 1 | ironhorse failed a harness assertion the oracle passed: Test262Error: prototype descriptor should be configurable |
| 1 | async: Test262:AsyncTestFailure:TypeError: cannot coerce undefined to object (the oracle completed) |
| 1 | ironhorse failed a harness assertion the oracle passed: Test262Error: Symbol(Symbol.asyncDispose) should be an own property |
| 1 | result divergence: oracle="Error" ironhorse="[object DisposableStack]" |
| 1 | ironhorse failed a harness assertion the oracle passed: Test262Error: Symbol(Symbol.dispose) should be an own property |
| 1 | ironhorse failed a harness assertion the oracle passed: Test262Error: random should be an own property |
| 1 | ironhorse failed a harness assertion the oracle passed: Test262Error: Expected a Test262Error but got a TypeError |
| 1 | ironhorse failed a harness assertion the oracle passed: Test262Error: Object.setPrototypeOf(ObjProto, { __proto__: null }) throws a TypeErro |
| 1 | ironhorse failed a harness assertion the oracle passed: Test262Error: Object.setPrototypeOf(ObjProto, Object.create(null)) throws a TypeErro |
| 1 | ironhorse failed a harness assertion the oracle passed: Test262Error: Expected SameValue(«"[object Iterator]"», «"[object Array Iterator]"») |

### Reason prefixes for unsupported

| shared-positive-test-failure | 1618 |
| unsupported-opcode | 821 |
| ironhorse-aborted-limit | 452 |
| shared-test262-failure | 278 |
| async | 56 |
| compiler-unimplemented | 24 |
| non-primitive-completion | 9 |
| negative-type-unmatched | 8 |
| parse-or-decode | 3 |
| strict | 1 |

### Top full reasons for unsupported

| 1618 | shared-positive-test-failure |
| 452 | ironhorse-aborted-limit |
| 436 | unsupported-opcode:module:dynamic-import |
| 278 | shared-test262-failure |
| 211 | unsupported-opcode:module:top-level-await |
| 134 | unsupported-opcode:module:static-linking |
| 46 | async:reported-failure |
| 21 | compiler-unimplemented:module |
| 15 | unsupported-opcode:Temporal.ZonedDateTime.toLocaleString:needs-intl |
| 11 | unsupported-opcode:Intl.NumberFormat:formatRange |
| 10 | async:unhandled-rejection |
| 9 | non-primitive-completion |
| 9 | unsupported-opcode:Intl.NumberFormat:compact-locale |
| 5 | negative-type-unmatched:Test262Error |
| 5 | unsupported-opcode:module:import-meta |
| 3 | negative-type-unmatched:EvalError |
| 3 | compiler-unimplemented:parse |
| 3 | parse-or-decode |
| 1 | strict:shared-positive-test-failure |

### Reason prefixes for refused

| refused | 5 |

### Top full reasons for refused

| 5 | refused:collection-constructor:weak-symbol-oracle-version |

### Reason prefixes for skipped

| oracle-host-missing-global | 4777 |
| structural | 230 |
| feature | 134 |

### Top full reasons for skipped

| 4238 | oracle-host-missing-global:Temporal |
| 539 | oracle-host-missing-global:Intl |
| 228 | structural:multi-agent |
| 64 | feature:ShadowRealm |
| 35 | feature:IsHTMLDDA |
| 35 | feature:tail-call-optimization |
| 2 | structural:can-block |

### Reason prefixes for infrastructure

| oracle-gate-off | 3297 |
| module | 132 |
| strict | 23 |
| oracle-nontermination | 3 |
| negative-oracle-unexpected | 2 |

### Top full reasons for infrastructure

| 2826 | oracle-gate-off:ironhorse-only-complete |
| 327 | oracle-gate-off:abort-value-differs |
| 130 | oracle-gate-off:oracle-only-complete |
| 98 | module:compiler-rejected |
| 34 | module:resolution-linking |
| 23 | strict:oracle-gate-off:ironhorse-only-complete |
| 10 | oracle-gate-off:error-message-differs |
| 3 | oracle-gate-off:negative-over-acceptance |
| 3 | oracle-nontermination: oracle failed to terminate within 60s (ironhorse terminates alone) |
| 2 | negative-oracle-unexpected |
| 1 | oracle-gate-off:abort-type-differs |

### Failures by third-level area (top 40)

| language/expressions/class | 28 |
| language/statements/class | 28 |
| language/module-code/top-level-await | 24 |
| language/expressions/async-generator | 14 |
| built-ins/TypedArray/prototype | 13 |
| built-ins/AsyncFromSyncIteratorPrototype/throw | 12 |
| language/expressions/compound-assignment | 11 |
| language/statements/async-generator | 11 |
| built-ins/AsyncFromSyncIteratorPrototype/return | 9 |
| built-ins/RegExp/prototype | 9 |
| built-ins/AsyncFromSyncIteratorPrototype/next | 8 |
| language/expressions/object | 7 |
| built-ins/AsyncIteratorPrototype/Symbol.asyncDispose | 6 |
| built-ins/Object/prototype | 5 |
| built-ins/Promise/prototype | 5 |
| built-ins/ArrayIteratorPrototype/Symbol.toStringTag | 3 |
| built-ins/AsyncGeneratorPrototype/return | 3 |
| built-ins/Promise/any | 3 |
| language/eval-code/indirect | 3 |
| language/statements/for-await-of | 3 |
| language/statements/with | 3 |
| built-ins/AsyncDisposableStack/prototype | 2 |
| built-ins/AsyncGeneratorFunction/prototype | 2 |
| built-ins/Iterator/prototype | 2 |
| built-ins/Math/random | 2 |
| built-ins/AsyncDisposableStack/is-a-constructor.js | 1 |
| built-ins/DisposableStack/is-a-constructor.js | 1 |
| built-ins/Function/internals | 1 |
| built-ins/GeneratorFunction/prototype | 1 |
| built-ins/Object/defineProperty | 1 |
| built-ins/Object/freeze | 1 |
| built-ins/Object/preventExtensions | 1 |
| built-ins/Object/seal | 1 |
| built-ins/Proxy/create-target-is-revoked-function-proxy.js | 1 |
| built-ins/Proxy/has | 1 |
| built-ins/Proxy/revocable | 1 |
| built-ins/Proxy/set | 1 |
| built-ins/RegExp/match-indices | 1 |
| built-ins/String/S15.5.5.1_A3.js | 1 |
| built-ins/String/symbol-wrapping.js | 1 |

### Non-covered by feature (features of non-covered cases, top 50)

| Temporal | 6711 of 6711 | 0.0% covered |
| Intl.Era-monthcode | 1566 of 1566 | 0.0% covered |
| dynamic-import | 581 of 1011 | 42.5% covered |
| Symbol | 557 of 1469 | 62.1% covered |
| regexp-unicode-property-escapes | 508 of 681 | 25.4% covered |
| BigInt | 293 of 1499 | 80.5% covered |
| TypedArray | 285 of 2519 | 88.7% covered |
| top-level-await | 267 of 276 | 3.3% covered |
| arrow-function | 258 of 949 | 72.8% covered |
| Atomics | 238 of 384 | 38.0% covered |
| cross-realm | 200 of 202 | 1.0% covered |
| resizable-arraybuffer | 196 of 462 | 57.6% covered |
| async-iteration | 193 of 4971 | 96.1% covered |
| SharedArrayBuffer | 183 of 463 | 60.5% covered |
| Reflect.construct | 181 of 703 | 74.3% covered |
| Intl.Locale | 172 of 172 | 0.0% covered |
| import-defer | 160 of 252 | 36.5% covered |
| Reflect | 122 of 478 | 74.5% covered |
| regexp-v-flag | 122 of 187 | 34.8% covered |
| Intl.DurationFormat | 111 of 111 | 0.0% covered |
| class | 108 of 4790 | 97.7% covered |
| Symbol.iterator | 102 of 1860 | 94.5% covered |
| source-phase-imports | 102 of 251 | 59.4% covered |
| Atomics.waitAsync | 101 of 101 | 0.0% covered |
| Intl.NumberFormat-v3 | 99 of 99 | 0.0% covered |
| await-dictionary | 87 of 89 | 2.2% covered |
| Intl.ListFormat | 81 of 81 | 0.0% covered |
| Intl.RelativeTimeFormat | 79 of 79 | 0.0% covered |
| Intl.Segmenter | 79 of 79 | 0.0% covered |
| import-attributes | 78 of 101 | 22.8% covered |
| joint-iteration | 77 of 82 | 6.1% covered |
| Proxy | 74 of 479 | 84.6% covered |
| Symbol.asyncIterator | 73 of 538 | 86.4% covered |
| iterator-chunking | 69 of 78 | 11.5% covered |
| Intl.NumberFormat-unified | 68 of 68 | 0.0% covered |
| immutable-arraybuffer | 64 of 66 | 3.0% covered |
| Symbol.toStringTag | 64 of 131 | 51.1% covered |
| ShadowRealm | 64 of 64 | 0.0% covered |
| async-functions | 62 of 702 | 91.2% covered |
| Intl.Locale-info | 60 of 60 | 0.0% covered |
| generators | 47 of 4118 | 98.9% covered |
| Intl.DisplayNames | 47 of 47 | 0.0% covered |
| explicit-resource-management | 46 of 430 | 89.3% covered |
| source-phase-imports-module-source | 45 of 108 | 58.3% covered |
| Symbol.toPrimitive | 41 of 233 | 82.4% covered |
| iterator-includes | 40 of 44 | 9.1% covered |
| Array.prototype.includes | 37 of 69 | 46.4% covered |
| change-array-by-copy | 37 of 132 | 72.0% covered |
| Intl.DateTimeFormat-formatRange | 37 of 37 | 0.0% covered |
| ArrayBuffer | 36 of 275 | 86.9% covered |
