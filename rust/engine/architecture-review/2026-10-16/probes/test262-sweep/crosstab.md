| oracle-on \ oracle-off | covered | infrastructure | ironhorse-failure | refused | skipped | unsupported |
| covered | 39860 | 0 | 0 | 0 | 0 | 0 |
| infrastructure | 2 | 145 | 24 | 0 | 0 | 6 |
| ironhorse-failure | 0 | 839 | 217 | 0 | 0 | 8 |
| refused | 0 | 0 | 0 | 5 | 0 | 0 |
| skipped | 0 | 2473 | 0 | 0 | 5141 | 0 |
| unsupported | 0 | 0 | 0 | 0 | 0 | 3256 |

## oracle-off reasons by category (top)

### ironhorse-failure
| 53 | async: Test262:AsyncTestFailure:TypeError: call: not a function (the oracle completed) |
| 48 | async: Test262:AsyncTestFailure:Test262Error: Test262Error: reject reason Expected SameValue(«TypeError: call: |
| 24 | engine-invariant:await:no-async-instance |
| 19 | ironhorse failed a harness assertion the oracle passed: Test262Error: Expected a ReferenceError to be thrown b |
| 11 | ironhorse failed a harness assertion the oracle passed: Test262Error: Expected SameValue(«"…"», «"…"») to be t |
| 7 | async: Test262:AsyncTestFailure:Test262Error: Test262Error: Promise should be rejected Expected a CatchError t |
| 7 | ironhorse failed a harness assertion the oracle passed: Test262Error: Expected a TypeError to be thrown but no |
| 4 | ironhorse failed a harness assertion the oracle passed: Test262Error: isConstructor invoked with a non-functio |
| 4 | ironhorse failed a harness assertion the oracle passed: Test262Error: Expected a RangeError but got a TypeErro |
| 3 | async: Test262:AsyncTestFailure:Test262Error: Test262Error: iterator closed properly Expected SameValue(«0», « |
| 3 | ironhorse failed a harness assertion the oracle passed: Test262Error: __re.hasOwnProperty('global') must retur |
| 3 | ironhorse failed a harness assertion the oracle passed: Test262Error: __re.hasOwnProperty('ignoreCase') must r |
| 3 | ironhorse failed a harness assertion the oracle passed: Test262Error: __re.hasOwnProperty('multiline') must re |
| 3 | ironhorse failed a harness assertion the oracle passed: Test262Error: typeof Expected SameValue(«"…"», «"…"»)  |
| 2 | result divergence: oracle="…" ironhorse="…" |
| 2 | async: Test262:AsyncTestFailure:Test262Error: Test262Error: Actual [dispose, job 1, job 2] and expected [job 1 |
| 2 | async: Test262:AsyncTestFailure:Test262Error: Test262Error: Promise should be rejected with thrown error Expec |
| 2 | async: Test262:AsyncTestFailure:Test262Error: Test262Error: Promise should be rejected Expected a Reject to be |
| 2 | ironhorse failed a harness assertion the oracle passed: Test262Error: constructor descriptor should not be wri |
| 2 | async: Test262:AsyncTestFailure:Test262Error: Test262Error: Expected rejection (the oracle completed) |
| 2 | async: Test262:AsyncTestFailure:Test262Error: Test262Error: The value of resolve.length is expected to equal t |
| 2 | async: Test262:AsyncTestFailure:Test262Error: Test262Error: Expected SameValue(«5», «7») to be true (the oracl |
| 2 | ironhorse failed a harness assertion the oracle passed: Test262Error: Expected true but got false |
| 2 | ironhorse failed a harness assertion the oracle passed: Test262Error: f descriptor should be enumerable; f des |
| 2 | ironhorse failed a harness assertion the oracle passed: Test262Error: declaration following Expected SameValue |

### unsupported
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

### skipped
| 4238 | oracle-host-missing-global:Temporal |
| 539 | oracle-host-missing-global:Intl |
| 228 | structural:multi-agent |
| 64 | feature:ShadowRealm |
| 35 | feature:IsHTMLDDA |
| 35 | feature:tail-call-optimization |
| 2 | structural:can-block |

### infrastructure
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

### refused
| 5 | refused:collection-constructor:weak-symbol-oracle-version |

## oracle-off by top/second area for Temporal and intl402
| built-ins/Temporal | {'infrastructure': 2224, 'skipped': 2378, 'unsupported': 1} |
| intl402/Temporal | {'skipped': 1837, 'infrastructure': 182, 'unsupported': 10} |
| annexB/language | {'unsupported': 662, 'covered': 151, 'skipped': 26, 'infrastructure': 6} |
| language/module-code | {'infrastructure': 37, 'unsupported': 336, 'covered': 202, 'ironhorse-failure': 24} |
| intl402/NumberFormat | {'infrastructure': 167, 'skipped': 61, 'unsupported': 21} |
| intl402/DateTimeFormat | {'infrastructure': 124, 'skipped': 115, 'unsupported': 5} |
| annexB/built-ins | {'skipped': 9, 'covered': 89, 'unsupported': 139, 'infrastructure': 4} |
| intl402/Locale | {'infrastructure': 72, 'skipped': 95, 'unsupported': 1} |
| language/import | {'covered': 10, 'unsupported': 29, 'infrastructure': 90} |
| intl402/DurationFormat | {'infrastructure': 8, 'skipped': 102} |
| intl402/ListFormat | {'infrastructure': 73, 'skipped': 7, 'unsupported': 1} |
| intl402/RelativeTimeFormat | {'skipped': 76, 'infrastructure': 3, 'unsupported': 1} |
| intl402/Segmenter | {'infrastructure': 69, 'skipped': 8, 'unsupported': 2} |
| intl402/Intl | {'infrastructure': 35, 'skipped': 31} |
| intl402/Collator | {'infrastructure': 45, 'skipped': 19, 'unsupported': 1} |
| intl402/DisplayNames | {'infrastructure': 22, 'skipped': 34, 'unsupported': 1} |
| intl402/PluralRules | {'infrastructure': 49, 'skipped': 3, 'unsupported': 1} |
| intl402/String | {'covered': 7, 'skipped': 2, 'infrastructure': 6, 'unsupported': 4} |
| intl402/Date | {'skipped': 1, 'infrastructure': 3, 'covered': 8} |
| intl402/BigInt | {'covered': 5, 'infrastructure': 5, 'skipped': 1} |
| intl402/Number | {'covered': 3, 'infrastructure': 4} |
| intl402/Array | {'covered': 1, 'infrastructure': 1} |
| intl402/FallbackSymbol | {'skipped': 2} |
| intl402/TypedArray | {'covered': 1} |
| intl402/constructors-string-and-single-element-array.js | {'infrastructure': 1} |
